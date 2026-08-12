"""SQLite persistence for chat conversations + messages.

Single-user for now, but every conversation carries a `user_id` (defaulting to
'default') so turning this multi-user later is a config change, not a migration.
Writes are serialised through a process-wide lock — SQLite allows one writer at
a time — and the DB runs in WAL mode so reads never block the writer.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path

_DEFAULT_DB = Path(__file__).resolve().parent / "data" / "chat.db"
DB_PATH = Path(os.environ.get("ATHENA_CHAT_DB", _DEFAULT_DB))
DEFAULT_USER = "default"

_write_lock = threading.Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT 'default',
  title      TEXT NOT NULL DEFAULT 'New chat',
  mode       TEXT NOT NULL DEFAULT 'business',
  agent      TEXT NOT NULL DEFAULT '',
  workflow   TEXT NOT NULL DEFAULT '',
  lang       TEXT NOT NULL DEFAULT 'en',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  scope_json      TEXT,
  steps_json      TEXT,
  sources_json    TEXT,
  created_at      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _write_lock, _connect() as conn:
        conn.executescript(_SCHEMA)
        # Migrate older DBs that predate the sources column (answer citations).
        cols = {r[1] for r in conn.execute("PRAGMA table_info(messages)")}
        if "sources_json" not in cols:
            conn.execute("ALTER TABLE messages ADD COLUMN sources_json TEXT")
        # Migrate older DBs that predate the agent/workflow columns.
        conv_cols = {r[1] for r in conn.execute("PRAGMA table_info(conversations)")}
        if "agent" not in conv_cols:
            conn.execute("ALTER TABLE conversations ADD COLUMN agent TEXT NOT NULL DEFAULT ''")
        if "workflow" not in conv_cols:
            conn.execute("ALTER TABLE conversations ADD COLUMN workflow TEXT NOT NULL DEFAULT ''")


def _now() -> float:
    return time.time()


def _new_id() -> str:
    return uuid.uuid4().hex[:16]


def _loads(val: str | None):
    if not val:
        return None
    try:
        return json.loads(val)
    except (TypeError, ValueError):
        return None


def derive_title(text: str, limit: int = 60) -> str:
    """A conversation's display title, taken from its first user message."""
    line = (text or "").strip().splitlines()[0] if (text or "").strip() else "New chat"
    line = " ".join(line.split())
    return (line[: limit - 1] + "…") if len(line) > limit else line


# --- conversations --------------------------------------------------------
def create_conversation(
    title: str = "New chat",
    mode: str = "business",
    lang: str = "en",
    user_id: str = DEFAULT_USER,
    agent: str = "",
    workflow: str = "",
) -> dict:
    cid, now = _new_id(), _now()
    with _write_lock, _connect() as conn:
        conn.execute(
            "INSERT INTO conversations (id, user_id, title, mode, agent, workflow, lang, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (cid, user_id, title, mode, agent, workflow, lang, now, now),
        )
    return {
        "id": cid,
        "user_id": user_id,
        "title": title,
        "mode": mode,
        "agent": agent,
        "workflow": workflow,
        "lang": lang,
        "created_at": now,
        "updated_at": now,
        "message_count": 0,
    }


def list_conversations(user_id: str = DEFAULT_USER) -> list[dict]:
    """Newest-first list with a message count and a short preview of the last turn."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT c.*,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                   (SELECT m.content FROM messages m WHERE m.conversation_id = c.id
                      ORDER BY m.created_at DESC LIMIT 1) AS last_message
            FROM conversations c
            WHERE c.user_id = ?
            ORDER BY c.updated_at DESC
            """,
            (user_id,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        preview = (d.pop("last_message", None) or "").strip().replace("\n", " ")
        d["preview"] = preview[:120]
        out.append(d)
    return out


def get_conversation(cid: str, user_id: str = DEFAULT_USER) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ? AND user_id = ?", (cid, user_id)
        ).fetchone()
        if not row:
            return None
        msgs = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (cid,),
        ).fetchall()
    conv = dict(row)
    conv["messages"] = [
        {
            "id": m["id"],
            "role": m["role"],
            "content": m["content"],
            "scope": _loads(m["scope_json"]),
            "steps": _loads(m["steps_json"]),
            "sources": _loads(m["sources_json"]),
            "created_at": m["created_at"],
        }
        for m in msgs
    ]
    return conv


def rename_conversation(cid: str, title: str, user_id: str = DEFAULT_USER) -> bool:
    with _write_lock, _connect() as conn:
        cur = conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            (title, _now(), cid, user_id),
        )
        return cur.rowcount > 0


def delete_conversation(cid: str, user_id: str = DEFAULT_USER) -> bool:
    with _write_lock, _connect() as conn:
        cur = conn.execute(
            "DELETE FROM conversations WHERE id = ? AND user_id = ?", (cid, user_id)
        )
        return cur.rowcount > 0


def conversation_exists(cid: str, user_id: str = DEFAULT_USER) -> bool:
    with _connect() as conn:
        return (
            conn.execute(
                "SELECT 1 FROM conversations WHERE id = ? AND user_id = ?",
                (cid, user_id),
            ).fetchone()
            is not None
        )


# --- messages -------------------------------------------------------------
def add_message(
    conversation_id: str,
    role: str,
    content: str,
    scope: dict | None = None,
    steps: list | None = None,
    title_if_first: str | None = None,
    sources: list | None = None,
) -> dict:
    """Append a message. Bumps the conversation's updated_at; if `title_if_first`
    is given and the conversation still has its default title, set it (used to
    name a conversation from its first user turn)."""
    mid, now = _new_id(), _now()
    with _write_lock, _connect() as conn:
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, scope_json, steps_json, sources_json, created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (
                mid,
                conversation_id,
                role,
                content,
                json.dumps(scope) if scope else None,
                json.dumps(steps) if steps else None,
                json.dumps(sources) if sources else None,
                now,
            ),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (now, conversation_id),
        )
        if title_if_first:
            conn.execute(
                "UPDATE conversations SET title = ? WHERE id = ? AND title = 'New chat'",
                (title_if_first, conversation_id),
            )
    return {"id": mid, "role": role, "content": content, "created_at": now}


def delete_last_assistant(conversation_id: str) -> None:
    """Drop the answer only if it's the most recent turn (used when regenerating).
    If the last turn is a user message — e.g. the previous attempt errored before
    an answer was saved — this deletes nothing, so a retry can't wipe an earlier
    good answer sitting further back in the conversation."""
    with _write_lock, _connect() as conn:
        row = conn.execute(
            "SELECT id, role FROM messages WHERE conversation_id = ?"
            " ORDER BY created_at DESC LIMIT 1",
            (conversation_id,),
        ).fetchone()
        if row and row["role"] == "assistant":
            conn.execute("DELETE FROM messages WHERE id = ?", (row["id"],))


def update_last_user(conversation_id: str, content: str, scope: dict | None = None) -> None:
    """Rewrite the most recent user message's text (and scope) in place — used when
    the user edits a question and resends, so the stored turn matches the new answer."""
    with _write_lock, _connect() as conn:
        row = conn.execute(
            "SELECT id FROM messages WHERE conversation_id = ? AND role = 'user'"
            " ORDER BY created_at DESC LIMIT 1",
            (conversation_id,),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE messages SET content = ?, scope_json = ? WHERE id = ?",
                (content, json.dumps(scope) if scope else None, row["id"]),
            )


def get_history(conversation_id: str) -> list[dict]:
    """Prior turns as [{role, content}] for feeding the LLM (text only)."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,),
        ).fetchall()
    return [{"role": r["role"], "content": r["content"]} for r in rows]
