# Athena Chat backend

A small stateful service that adds **conversations + chat history** on top of the
stateless graph API (`src/api`). It stores every turn in SQLite and relays the
answer stream from the upstream graph API unchanged.

```
frontend ──▶ this backend (:8100)  ── conversations, messages, history (SQLite)
                    └──▶ graph API (:8000)  /api/ask/stream, /api/search, …
```

## Run

Start the graph API first (it owns the knowledge graph and the LLM Q&A):

```bash
uvicorn api.app:app --app-dir src --port 8000
```

Then this backend (serves the chat UI too):

```bash
uvicorn app:app --app-dir example/backend --port 8100 --reload
# or: python example/backend/app.py
```

Open <http://127.0.0.1:8100/chat>.

## Config (env)

| Var                | Default                        | Meaning                     |
| ------------------ | ------------------------------ | --------------------------- |
| `ATHENA_GRAPH_API` | `http://127.0.0.1:8000`        | Upstream graph API base URL |
| `ATHENA_CHAT_DB`   | `example/backend/data/chat.db` | SQLite file (auto-created)  |
| `ATHENA_CHAT_PORT` | `8100`                         | Port for `python app.py`    |

## API

Conversations / history (owned here):

| Method   | Path                      | Purpose                                                           |
| -------- | ------------------------- | ----------------------------------------------------------------- |
| `POST`   | `/api/conversations`      | Create a conversation                                             |
| `GET`    | `/api/conversations`      | List (newest first, with preview + count)                         |
| `GET`    | `/api/conversations/{id}` | Conversation + all messages                                       |
| `PATCH`  | `/api/conversations/{id}` | Rename                                                            |
| `DELETE` | `/api/conversations/{id}` | Delete (cascades to messages)                                     |
| `POST`   | `/api/ask/stream`         | Ask a turn — persists the question, streams + persists the answer |

`POST /api/ask/stream` body: `{question, conversation_id?, scope?, mode?, lang?}`.
If `conversation_id` is omitted a new conversation is created; the first SSE frame
is `{"conversation": {id, title, new}}`, followed by the upstream answer frames
(`{delta}`, `{tool}`, `{steps,done}`). Prior history is loaded server-side, so the
client does not resend it.

Everything else under `/api/*` (`/api/search`, `/api/status`, `/api/workspace`, …)
is proxied straight to the graph API.

## Storage

Single-user for now — every conversation carries a `user_id` (default `'default'`),
so making it multi-user later is a config change, not a migration. SQLite runs in
WAL mode with writes serialised through a lock.
