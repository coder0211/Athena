"""Athena HTTP API + static web UI host.

Reference integration surface over the pipeline: manage source repos, trigger
fetch/build (as background jobs), query the graph, and ask natural-language
questions. Run:

    uvicorn api.app:app --app-dir src --reload
    # or: python src/api/app.py

Everything the UI needs is under /api/*; the example SPA (example/) is served from /.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
import main as pipeline
from query import ask as ask_module
from query.engine import GraphQuery
from utils.repo.fetch import DEFAULT_SOURCES_PATH, fetch
from utils.workspace import (
    RELATION_TYPES,
    REPO_ROLES,
    WORKSPACE_PATH,
    load_workspace,
    save_workspace,
)

config.load_env()  # pick up OPENAI_API_KEY / ATHENA_* from .env

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_UI_DIR = _PROJECT_ROOT / "example"
_GRAPH_PATH = config.graph_path()

app = FastAPI(title="Athena", description="Code knowledge graph API")

# --- lazily-loaded graph engine (reloads when the graph file changes) -----
_engine: GraphQuery | None = None
_engine_mtime: float | None = None


def _engine_sig() -> tuple:
    gm = _GRAPH_PATH.stat().st_mtime
    wm = WORKSPACE_PATH.stat().st_mtime if WORKSPACE_PATH.exists() else 0
    return (gm, wm)


def get_engine() -> GraphQuery:
    """Cached engine; rebuilt when the graph OR the workspace file changes."""
    global _engine, _engine_mtime
    if not _GRAPH_PATH.exists():
        raise HTTPException(404, "Graph not built yet — run a build first.")
    sig = _engine_sig()
    if _engine is None or sig != _engine_mtime:
        _engine = GraphQuery(_GRAPH_PATH)
        _engine_mtime = sig
    return _engine


# --- background job runner ------------------------------------------------
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _run_job(job_id: str, kind: str, fn) -> None:
    try:
        fn()
        status, error = "succeeded", None
    except Exception as e:  # noqa: BLE001 - report any failure to the client
        status, error = "failed", f"{type(e).__name__}: {e}"
    with _jobs_lock:
        _jobs[job_id].update(status=status, error=error, finished=time.time())


def _start_job(kind: str, fn) -> str:
    job_id = uuid.uuid4().hex[:12]
    with _jobs_lock:
        _jobs[job_id] = {
            "id": job_id,
            "kind": kind,
            "status": "running",
            "error": None,
            "started": time.time(),
            "finished": None,
        }
    threading.Thread(target=_run_job, args=(job_id, kind, fn), daemon=True).start()
    return job_id


# --- models ---------------------------------------------------------------
class Repo(BaseModel):
    url: str
    branch: str = "main"


class Sources(BaseModel):
    repositories: list[Repo]


class AskRequest(BaseModel):
    question: str
    history: list = []  # prior [{role, content}] turns for multi-turn chat
    scope: dict = {}  # {repos: [...], symbols: [...]} to narrow the search
    mode: str = "business"  # 'business' (non-technical) | 'technical'
    lang: str = "auto"  # 'auto' | 'en' | 'vi'


# --- sources (repo settings) ---------------------------------------------
@app.get("/api/sources")
def get_sources() -> Sources:
    if not DEFAULT_SOURCES_PATH.exists():
        return Sources(repositories=[])
    data = yaml.safe_load(DEFAULT_SOURCES_PATH.read_text()) or {}
    return Sources(repositories=data.get("repositories", []))


@app.put("/api/sources")
def put_sources(sources: Sources) -> dict:
    DEFAULT_SOURCES_PATH.write_text(
        yaml.safe_dump(sources.model_dump(), sort_keys=False)
    )
    return {"ok": True, "count": len(sources.repositories)}


class WorkspaceIn(BaseModel):
    repos: dict = {}
    relations: list = []


@app.get("/api/workspace")
def get_workspace() -> dict:
    """Repo descriptions + typed relations, plus the vocab and known repo names."""
    ws = load_workspace()
    if _GRAPH_PATH.exists():
        available = get_engine().repos()
    else:
        available = sorted(ws.get("repos", {}).keys())
    return {
        **ws,
        "relation_types": RELATION_TYPES,
        "repo_roles": REPO_ROLES,
        "repos_available": available,
    }


@app.put("/api/workspace")
def put_workspace(body: WorkspaceIn) -> dict:
    save_workspace(body.model_dump())
    return {"ok": True, "repos": len(body.repos), "relations": len(body.relations)}


@app.get("/api/branches")
def branches(url: str) -> dict:
    """List remote branches for a repo URL via `git ls-remote --heads`."""
    url = url.strip()
    if not url or url.startswith("-"):  # reject empty / arg-injection
        raise HTTPException(400, "invalid repo url")
    try:
        proc = subprocess.run(
            ["git", "ls-remote", "--heads", url],
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},  # fail fast, no auth prompt
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "git ls-remote timed out")
    if proc.returncode != 0:
        raise HTTPException(400, (proc.stderr.strip() or "git ls-remote failed")[:300])
    names = [
        line.split("\trefs/heads/", 1)[1]
        for line in proc.stdout.splitlines()
        if "\trefs/heads/" in line
    ]
    return {"branches": sorted(names)}


# --- pipeline actions -----------------------------------------------------
@app.post("/api/fetch")
def start_fetch() -> dict:
    return {"job_id": _start_job("fetch", fetch)}


@app.post("/api/build")
def start_build() -> dict:
    return {"job_id": _start_job("build", lambda: pipeline.build(persist=True))}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "unknown job")
    return job


@app.get("/api/jobs")
def list_jobs() -> list[dict]:
    with _jobs_lock:
        return sorted(_jobs.values(), key=lambda j: j["started"], reverse=True)


# --- graph status + queries ----------------------------------------------
@app.get("/api/status")
def status() -> dict:
    built = _GRAPH_PATH.exists()
    out = {
        "built": built,
        "ask_available": ask_module.is_available(),
        "repos": [r.url for r in get_sources().repositories],
    }
    if built:
        out["graph"] = get_engine().overview()
        out["built_at"] = _GRAPH_PATH.stat().st_mtime
    return out


@app.get("/api/search")
def search(
    q: str, limit: int = 20, repo: str | None = None, type: str | None = None
) -> list[dict]:
    return get_engine().search_symbols(q, limit=limit, repo=repo, type=type)


@app.get("/api/symbol/{node_id:path}")
def symbol(node_id: str) -> dict:
    return get_engine().get_symbol(node_id)


@app.get("/api/impact/{node_id:path}")
def impact(node_id: str, depth: int | None = None) -> dict:
    return get_engine().impact(node_id, depth=depth)


@app.get("/api/communities")
def communities(q: str | None = None, limit: int = 30) -> list[dict]:
    return get_engine().list_communities(query=q, limit=limit)


# --- natural-language Q&A -------------------------------------------------
@app.post("/api/ask")
def ask(req: AskRequest) -> dict:
    return ask_module.answer(
        req.question,
        get_engine(),
        history=req.history,
        scope=req.scope,
        mode=req.mode,
        lang=req.lang,
    )


@app.post("/api/ask/stream")
def ask_stream(req: AskRequest) -> StreamingResponse:
    """Server-Sent Events: streams the answer token by token as `data: {json}`
    frames (events: {delta}, {tool}, {steps,done}, {unavailable}, {error})."""
    engine = get_engine()  # raises before streaming starts if the graph is missing

    def gen():
        try:
            for ev in ask_module.answer_stream(
                req.question,
                engine,
                history=req.history,
                scope=req.scope,
                mode=req.mode,
                lang=req.lang,
            ):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:  # surface unexpected errors as a final event
            yield f"data: {json.dumps({'error': f'{type(e).__name__}: {e}'})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- pages + static web UI (registered last so /api/* wins) --------------
@app.get("/chat")
def chat_page():
    from fastapi.responses import FileResponse

    return FileResponse(_UI_DIR / "chat.html")


if _UI_DIR.exists():
    app.mount("/", StaticFiles(directory=str(_UI_DIR), html=True), name="ui")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
