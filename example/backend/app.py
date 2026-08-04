"""Athena Chat backend — conversations, messages, and chat history.

A thin stateful layer in front of the stateless graph API (src/api): it owns the
chat store (SQLite) and turns each question into a persisted turn, while relaying
the answer stream from the upstream graph API untouched.

    frontend ──▶ this backend (conversations + history)
                     └──▶ upstream graph API  /api/ask/stream, /api/search, …

Run (from the repo root, with the graph API already up on :8000):

    uvicorn app:app --app-dir example/backend --port 8100 --reload
    # or: python example/backend/app.py

Config (env):
    ATHENA_GRAPH_API   upstream graph API base URL   (default http://127.0.0.1:8000)
    ATHENA_CHAT_DB     SQLite file                    (default example/backend/data/chat.db)
    ATHENA_CHAT_PORT   port for `python app.py`       (default 8100)
"""

from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

import db
from models import AskStreamRequest, ConversationCreate, ConversationRename

UPSTREAM = os.environ.get("ATHENA_GRAPH_API", "http://127.0.0.1:8000").rstrip("/")
_UI_DIR = Path(__file__).resolve().parents[1] / "frontend"  # example/frontend/
USER = db.DEFAULT_USER  # single-user for now; swap for a real identity later


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    app.state.http = httpx.AsyncClient(timeout=None)  # streamed answers can run long
    try:
        yield
    finally:
        await app.state.http.aclose()


app = FastAPI(title="Athena Chat backend", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev convenience; tighten for a real deployment
    allow_methods=["*"],
    allow_headers=["*"],
)


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


# --- conversations --------------------------------------------------------
@app.post("/api/conversations")
async def create_conversation(body: ConversationCreate) -> dict:
    return await run_in_threadpool(
        db.create_conversation, body.title, body.mode, body.lang, USER
    )


@app.get("/api/conversations")
async def list_conversations() -> list[dict]:
    return await run_in_threadpool(db.list_conversations, USER)


@app.get("/api/conversations/{cid}")
async def get_conversation(cid: str) -> dict:
    conv = await run_in_threadpool(db.get_conversation, cid, USER)
    if not conv:
        raise HTTPException(404, "conversation not found")
    return conv


@app.patch("/api/conversations/{cid}")
async def rename_conversation(cid: str, body: ConversationRename) -> dict:
    title = body.title.strip() or "New chat"
    ok = await run_in_threadpool(db.rename_conversation, cid, title, USER)
    if not ok:
        raise HTTPException(404, "conversation not found")
    return {"ok": True, "id": cid, "title": title}


@app.delete("/api/conversations/{cid}")
async def delete_conversation(cid: str) -> dict:
    ok = await run_in_threadpool(db.delete_conversation, cid, USER)
    if not ok:
        raise HTTPException(404, "conversation not found")
    return {"ok": True, "id": cid}


# --- chat turn: persist + proxy the upstream answer stream ----------------
@app.post("/api/ask/stream")
async def ask_stream(req: AskStreamRequest, request: Request) -> StreamingResponse:
    # Resolve (or open) the conversation this turn belongs to.
    if req.conversation_id and await run_in_threadpool(
        db.conversation_exists, req.conversation_id, USER
    ):
        cid, is_new = req.conversation_id, False
    else:
        conv = await run_in_threadpool(
            db.create_conversation, "New chat", req.mode, req.lang, USER
        )
        cid, is_new = conv["id"], True

    regen = req.regenerate and not is_new
    if regen:
        # Replacing the last answer: it's already in the store (and so is the
        # question), so drop the old answer and rebuild history without the
        # trailing user turn (passed separately as the question).
        await run_in_threadpool(db.delete_last_assistant, cid)
        # An edit also rewrites that trailing user turn to the new question, so the
        # stored conversation stays consistent with the freshly generated answer.
        if req.edit:
            await run_in_threadpool(
                db.update_last_user, cid, req.question, req.scope or None
            )
        hist = await run_in_threadpool(db.get_history, cid)
        history = hist[:-1] if hist and hist[-1]["role"] == "user" else hist
        title = None
    else:
        # Prior turns (before this question) become the LLM history; then save
        # the user turn and name a fresh conversation after it.
        history = await run_in_threadpool(db.get_history, cid)
        title = db.derive_title(req.question)
        await run_in_threadpool(
            db.add_message, cid, "user", req.question, req.scope or None, None, title
        )

    payload = {
        "question": req.question,
        "history": history,
        "scope": req.scope,
        "mode": req.mode,
        "lang": req.lang,
    }
    client: httpx.AsyncClient = request.app.state.http

    async def gen():
        # Tell the client which conversation this is, up front. Only a brand-new
        # conversation carries a title (derived from this question); for an
        # existing one the client keeps the title it already knows.
        yield _sse(
            {"conversation": {"id": cid, "title": title if is_new else None, "new": is_new}}
        )
        parts: list[str] = []
        steps: list = []
        sources: list = []
        try:
            async with client.stream(
                "POST", f"{UPSTREAM}/api/ask/stream", json=payload
            ) as resp:
                if resp.status_code != 200:
                    await resp.aread()
                    yield _sse({"error": f"upstream graph API returned {resp.status_code}"})
                    return
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    yield f"data: {raw}\n\n"  # relay the frame unchanged
                    try:
                        ev = json.loads(raw)
                    except ValueError:
                        continue
                    if ev.get("delta"):
                        parts.append(ev["delta"])
                    elif ev.get("done"):
                        if ev.get("steps"):
                            steps = ev["steps"]
                        if ev.get("sources"):
                            sources = ev["sources"]
        except httpx.HTTPError as e:
            yield _sse({"error": f"cannot reach graph API: {type(e).__name__}: {e}"})

        # Persist whatever answer we managed to stream (with its steps + sources).
        answer = "".join(parts).strip()
        if answer:
            await run_in_threadpool(
                db.add_message,
                cid,
                "assistant",
                answer,
                None,
                steps or None,
                None,
                sources or None,
            )

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- pass-through to the upstream graph API for read endpoints ------------
# Registered AFTER the specific /api routes above, so those win; this catches
# /api/search, /api/status, /api/workspace, etc. the chat UI still needs.
@app.get("/api/{path:path}")
async def proxy_get(path: str, request: Request) -> Response:
    client: httpx.AsyncClient = request.app.state.http
    try:
        r = await client.get(
            f"{UPSTREAM}/api/{path}", params=request.query_params, timeout=30
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"graph API unreachable: {type(e).__name__}: {e}")
    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type=r.headers.get("content-type"),
    )


# --- chat web UI (served from example/frontend/) --------------------------
# This service IS the chat app, so the root and /chat both open the chat page.
@app.get("/")
@app.get("/chat")
def chat_page() -> FileResponse:
    return FileResponse(_UI_DIR / "index.html")


if _UI_DIR.exists():
    # Mounted for the shared assets (styles.css, logo, chat.js); "/" is handled above.
    app.mount("/", StaticFiles(directory=str(_UI_DIR), html=True), name="ui")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app, host="127.0.0.1", port=int(os.environ.get("ATHENA_CHAT_PORT", "8100"))
    )
