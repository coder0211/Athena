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
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
import main as pipeline
from extractors.documents import SUPPORTED_EXTENSIONS
from graph import docs_reindex
from query import ask as ask_module
from query import personas as personas_module
from query.engine import GraphQuery
from utils.docs import document_roots, load_docs_config, save_docs_config
from utils.repo.fetch import DEFAULT_SOURCES_PATH, fetch
from utils.workspace import (
    RELATION_TYPES,
    REPO_ROLES,
    WORKSPACE_PATH,
    load_workspace,
    save_workspace,
)
from utils.mcp import MCP_PATH

config.load_env()  # pick up OPENAI_API_KEY / ATHENA_* from .env

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_UI_DIR = _PROJECT_ROOT / "dashboard"  # this service hosts the management dashboard
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
    result = None
    try:
        result = fn()
        status, error = "succeeded", None
    except Exception as e:  # noqa: BLE001 - report any failure to the client
        status, error = "failed", f"{type(e).__name__}: {e}"
    with _jobs_lock:
        _jobs[job_id].update(
            status=status, error=error, finished=time.time(), result=result
        )


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
    scope: dict = {}  # {repos: [...], symbols: [...], docs: [...]} to narrow the search
    mode: str = "business"  # persona id — 'business'/'technical' or a custom type
    lang: str = "auto"  # 'auto' | 'en' | 'vi'


class PersonaIn(BaseModel):
    id: str = ""  # slug; derived from label when empty
    label: str
    description: str = ""
    instruction: str
    greeting: str = ""
    suggestions: list[str] = []
    followup_voice: str = ""


class PersonaGenerateIn(BaseModel):
    description: str  # plain-language description of the reader / desired output
    label: str = ""  # optional preferred type name


# --- sources (repo settings) ---------------------------------------------
def _read_sources() -> list[dict]:
    """The raw repository list from sources.yaml (list of {url, branch})."""
    if not DEFAULT_SOURCES_PATH.exists():
        return []
    data = yaml.safe_load(DEFAULT_SOURCES_PATH.read_text()) or {}
    return data.get("repositories", []) or []


@app.get("/api/sources")
def get_sources(offset: int = 0, limit: int | None = None) -> dict:
    """Paginated repository list. `limit` omitted → the whole list. Returns the
    requested page plus `total` so the client can offer "show more"."""
    repos = _read_sources()
    total = len(repos)
    offset = max(0, offset)
    page = repos[offset : offset + limit] if limit is not None else repos[offset:]
    return {"repositories": page, "total": total, "offset": offset, "limit": limit}


@app.put("/api/sources")
def put_sources(sources: Sources) -> dict:
    DEFAULT_SOURCES_PATH.write_text(
        yaml.safe_dump(sources.model_dump(), sort_keys=False)
    )
    return {"ok": True, "count": len(sources.repositories)}


class WorkspaceIn(BaseModel):
    repos: dict = {}
    docs: dict = {}
    relations: list = []


@app.get("/api/workspace")
def get_workspace() -> dict:
    """Repo/doc metadata + typed relations, plus the vocab and available nodes
    (known repo names and indexed documents) to place on the canvas."""
    ws = load_workspace()
    docs_available: list[dict] = []
    if _GRAPH_PATH.exists():
        available = get_engine().repos()
        docs_available = [
            {"id": d["id"], "name": d.get("name"), "file_type": d.get("file_type")}
            for d in get_engine().list_documents()
        ]
    else:
        available = sorted(ws.get("repos", {}).keys())
    return {
        **ws,
        "relation_types": RELATION_TYPES,
        "repo_roles": REPO_ROLES,
        "repos_available": available,
        "docs_available": docs_available,
    }


@app.put("/api/workspace")
def put_workspace(body: WorkspaceIn) -> dict:
    save_workspace(body.model_dump())
    return {
        "ok": True,
        "repos": len(body.repos),
        "docs": len(body.docs),
        "relations": len(body.relations),
    }


# --- third-party MCP servers (extra tools for the assistant) --------------
# The config is edited as raw JSON (/api/mcp/config); servers + their live tools
# are read via /api/mcp/servers; chat @-tagging uses /api/mcp/tools.
@app.get("/api/mcp/tools")
def get_mcp_tools() -> list[dict]:
    """Tools discovered across enabled MCP servers — for @-tagging in chat."""
    from query import mcp_bridge

    out = []
    for spec in mcp_bridge.get_specs():
        name = spec["function"]["name"]  # mcp__<server>__<tool>
        server, _, tool = name[len("mcp__"):].partition("__")
        out.append(
            {
                "name": name,
                "server": server,
                "tool": tool,
                "description": spec["function"].get("description", ""),
            }
        )
    return out


_MCP_STARTER = '{\n  "mcpServers": {}\n}\n'


class McpRaw(BaseModel):
    content: str


@app.get("/api/mcp/config")
def get_mcp_config() -> dict:
    """Raw mcp_servers.json text, for direct editing in the dashboard."""
    text = MCP_PATH.read_text() if MCP_PATH.exists() else _MCP_STARTER
    return {"content": text}


@app.put("/api/mcp/config")
def put_mcp_config(body: McpRaw) -> dict:
    """Validate + write the raw JSON. Rejects malformed JSON or a missing
    mcpServers object with a helpful message."""
    import json as _json

    try:
        data = _json.loads(body.content or "{}")
    except _json.JSONDecodeError as e:
        raise HTTPException(400, f"Invalid JSON: {e}")
    if not isinstance(data, dict) or not isinstance(data.get("mcpServers", {}), dict):
        raise HTTPException(400, 'Expected an object with an "mcpServers" object.')
    text = body.content if body.content.endswith("\n") else body.content + "\n"
    MCP_PATH.write_text(text)
    return {"ok": True, "servers": len(data.get("mcpServers") or {})}


@app.get("/api/mcp/servers")
def get_mcp_servers() -> list[dict]:
    """Each configured server with its live tools/prompts (or an error) — the
    per-server boxes shown after saving."""
    from query import mcp_bridge

    return mcp_bridge.describe_servers()


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
        "repos": [r.get("url") for r in _read_sources()],
    }
    if built:
        out["graph"] = get_engine().overview()
        out["built_at"] = _GRAPH_PATH.stat().st_mtime
    return out


@app.get("/api/search")
def search(
    q: str,
    limit: int = 20,
    repo: str | None = None,
    type: str | None = None,
    compact: bool = False,
) -> list[dict]:
    eng = get_engine()
    if compact:  # autocomplete pickers only need id/name/repo/type
        return eng.search_brief(q, limit=limit, repo=repo, type=type)
    return eng.search_symbols(q, limit=limit, repo=repo, type=type)


@app.get("/api/symbol/{node_id:path}")
def symbol(node_id: str) -> dict:
    return get_engine().get_symbol(node_id)


@app.get("/api/impact/{node_id:path}")
def impact(node_id: str, depth: int | None = None) -> dict:
    return get_engine().impact(node_id, depth=depth)


@app.get("/api/source/{node_id:path}")
def source(node_id: str, relations: bool = True) -> dict:
    """A symbol's real source code plus (optionally) its callers/callees, so the
    chat UI can turn a cited symbol into a browsable code panel."""
    eng = get_engine()
    out = eng.read_source(node_id)
    if relations and "error" not in out:
        out["callers"] = eng.callers(node_id, limit=30)
        out["callees"] = eng.callees(node_id, limit=30)
    return out


@app.get("/api/communities")
def communities(q: str | None = None, limit: int = 30) -> list[dict]:
    return get_engine().list_communities(query=q, limit=limit)


# --- documents (docx/pdf/csv/xls knowledge source) -----------------------
class DocsFolders(BaseModel):
    folders: list[str] = []


@app.get("/api/docs/folders")
def get_doc_folders() -> dict:
    """Configured document folders + the resolved roots actually being scanned."""
    cfg = load_docs_config()
    base = _upload_dir().resolve()
    dirs = sorted(
        str(p.relative_to(base)) for p in base.rglob("*") if p.is_dir()
    )
    return {
        "folders": cfg["folders"],
        "roots": [str(r) for r in document_roots()],
        "upload_dir": str(config.docs_root() / "uploads"),
        "supported": list(SUPPORTED_EXTENSIONS),
        "dirs": dirs,  # every upload subfolder, so empty ones still render in the tree
    }


@app.put("/api/docs/folders")
def put_doc_folders(body: DocsFolders) -> dict:
    save_docs_config(body.folders)
    return {"ok": True, "folders": len(body.folders)}


@app.get("/api/docs")
def list_docs() -> list[dict]:
    if not _GRAPH_PATH.exists():
        return []
    return get_engine().list_documents()


@app.get("/api/docs/detail")
def doc_detail(id: str) -> dict:
    """A document's metadata + ordered section list (for the preview panel)."""
    return get_engine().get_document(id)


@app.get("/api/docs/section")
def doc_section(id: str) -> dict:
    """Full text of one document section + the code symbols it mentions. `id`
    is passed as a query param since section ids contain '#'."""
    return get_engine().read_passage(id)


def _upload_dir() -> Path:
    d = config.docs_root() / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_under_uploads(rel: str, *, allow_empty: bool) -> Path:
    """Resolve a user-supplied relative path under the uploads dir, rejecting
    absolute paths and any '..' escape. `allow_empty` permits the uploads root
    itself (for a target folder); otherwise a path is required (for a file)."""
    base = _upload_dir().resolve()
    parts = [p for p in Path(rel or "").parts if p not in ("", ".")]
    if any(p == ".." for p in parts) or Path(rel or "").is_absolute():
        raise HTTPException(400, "invalid path")
    if not parts:
        if allow_empty:
            return base
        raise HTTPException(400, "path required")
    dest = (base / Path(*parts)).resolve()
    if dest != base and base not in dest.parents:
        raise HTTPException(400, "path escapes the uploads directory")
    return dest


@app.post("/api/docs/upload")
async def upload_doc(file: UploadFile = File(...), path: str = Form("")) -> dict:
    """Save an uploaded document under .docs/uploads/[<path>/]<name>. `path` is an
    optional relative subfolder (e.g. 'guides/onboarding') — a folder drop passes the
    file's own relative directory here to preserve the tree. Does not index; the
    client triggers /api/docs/reindex afterwards."""
    name = Path(file.filename or "").name
    if not name:
        raise HTTPException(400, "missing filename")
    if Path(name).suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            400, f"unsupported type; allowed: {', '.join(SUPPORTED_EXTENSIONS)}"
        )
    folder = _safe_under_uploads(path, allow_empty=True)
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / name
    data = await file.read()
    dest.write_bytes(data)
    rel = dest.resolve().relative_to(_upload_dir().resolve())
    return {"ok": True, "name": name, "path": str(rel), "size": len(data)}


@app.delete("/api/docs/upload/{relpath:path}")
def delete_upload(relpath: str) -> dict:
    """Delete an uploaded file by its path relative to .docs/uploads/ (reindex
    afterwards to drop it). Prunes parent folders left empty by the deletion."""
    target = _safe_under_uploads(relpath, allow_empty=False)
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "no such uploaded file")
    target.unlink()
    _prune_empty(target.parent)
    return {"ok": True, "path": str(target.relative_to(_upload_dir().resolve()))}


def _prune_empty(start: Path) -> None:
    """Remove now-empty folders from `start` up to (not including) the uploads root."""
    base = _upload_dir().resolve()
    d = start
    while d != base and d.is_dir() and not any(d.iterdir()):
        d.rmdir()
        d = d.parent


class MoveBody(BaseModel):
    src: str  # path relative to .docs/uploads/
    dst: str  # new path relative to .docs/uploads/


@app.post("/api/docs/move")
def move_upload(body: MoveBody) -> dict:
    """Rename or move a file/folder within .docs/uploads/ (reindex to apply)."""
    src = _safe_under_uploads(body.src, allow_empty=False)
    dst = _safe_under_uploads(body.dst, allow_empty=False)
    if not src.exists():
        raise HTTPException(404, "source does not exist")
    if dst.exists():
        raise HTTPException(409, "destination already exists")
    if src.is_file() and dst.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            400, f"unsupported type; allowed: {', '.join(SUPPORTED_EXTENSIONS)}"
        )
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    _prune_empty(src.parent)
    base = _upload_dir().resolve()
    return {"ok": True, "src": body.src, "dst": str(dst.relative_to(base))}


class FolderBody(BaseModel):
    path: str  # new folder path relative to .docs/uploads/


@app.post("/api/docs/folder")
def create_folder(body: FolderBody) -> dict:
    """Create an empty folder under .docs/uploads/. No reindex needed — an empty
    folder holds no documents; it just becomes a drag/upload target in the tree."""
    target = _safe_under_uploads(body.path, allow_empty=False)
    if target.exists():
        raise HTTPException(409, "folder already exists")
    target.mkdir(parents=True, exist_ok=False)
    base = _upload_dir().resolve()
    return {"ok": True, "path": str(target.relative_to(base))}


@app.delete("/api/docs/folder/{relpath:path}")
def delete_folder(relpath: str) -> dict:
    """Delete a folder and everything under it, within .docs/uploads/ (reindex to
    apply)."""
    import shutil

    target = _safe_under_uploads(relpath, allow_empty=False)
    if not target.exists() or not target.is_dir():
        raise HTTPException(404, "no such folder")
    shutil.rmtree(target)
    _prune_empty(target.parent)
    return {"ok": True, "path": relpath}


@app.post("/api/docs/reindex")
def reindex_docs() -> dict:
    # No graph yet is fine: reindex_documents opens an empty store and writes a
    # docs-only graph. Docs become searchable standalone — only the doc↔code
    # mention bridges are skipped until a code graph is built.
    return {
        "job_id": _start_job(
            "docs-reindex", lambda: docs_reindex.reindex_documents(_GRAPH_PATH)
        )
    }


@app.get("/api/docs/search")
def docs_search(q: str, limit: int = 8) -> list[dict]:
    return get_engine().search_docs(q, limit=limit)


# --- answer personas (the "type" library) ---------------------------------
# Built-in `business`/`technical` plus any custom types the user adds; each
# shapes how an answer is written. `generate` drafts one from a description.
@app.get("/api/personas")
def get_personas() -> dict:
    return {"personas": personas_module.list_personas()}


@app.post("/api/personas")
def upsert_persona(body: PersonaIn) -> dict:
    try:
        return personas_module.upsert(body.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/personas/{persona_id}")
def delete_persona(persona_id: str) -> dict:
    try:
        personas_module.delete(persona_id)
    except ValueError as e:  # built-in — can't delete
        raise HTTPException(status_code=400, detail=str(e))
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown type.")
    return {"ok": True}


@app.post("/api/personas/generate")
def generate_persona(body: PersonaGenerateIn) -> dict:
    """Draft a persona from a plain-language description (not saved — the client
    previews/edits, then POSTs it back to /api/personas to save)."""
    if not ask_module.is_available():
        raise HTTPException(
            status_code=503,
            detail="Set OPENAI_API_KEY to generate a type from a description.",
        )
    token_param = os.environ.get("ATHENA_TOKENS_PARAM", "max_tokens")
    try:
        draft = personas_module.generate_instruction(
            ask_module._client(),
            ask_module._model(),
            body.description,
            body.label,
            **{token_param: 1400},
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # LLM/provider error — surface cleanly, no 500
        raise HTTPException(status_code=502, detail=f"{type(e).__name__}: {e}")
    return draft


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


# --- management dashboard (static web UI; registered last so /api/* wins) --
# This service hosts the management dashboard only. The chat UI lives on the
# separate chat backend (example/backend, default :8100) so history is persisted.
if _UI_DIR.exists():
    app.mount("/", StaticFiles(directory=str(_UI_DIR), html=True), name="ui")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
