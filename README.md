<h1><img src="example/frontend/logo.svg" alt="" width="30" height="30" align="absmiddle" /> Athena</h1>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io/)

**Turn your Git repositories into a queryable code knowledge graph — then ask
questions about how the product works in plain language.**

<p align="center"><img src="example/screenshot.png" alt="Athena chat UI" width="720" /></p>

Athena ingests your Git repositories — and, optionally, your product documents
(specs, PDFs, spreadsheets) — extracts their structure (symbols, call/reference
edges, concept communities), and serves it over one shared query engine: a
**management dashboard**, a **chat app** with saved history, an **HTTP API**, and
an **MCP server**. The natural-language Q&A reads the _real_ source code — and the
docs you upload — and explains it, for business stakeholders and developers alike.

---

## Highlights

- **Ask in plain language** — the Q&A agent plans, searches the graph, reads the
  actual code, and explains a flow step by step. It cites where things live.
- **Answer types you can extend** — built-in **Business** (non-technical, no jargon)
  and **Technical** (call paths, files, snippets) types, plus your own (Sales,
  Marketing, Support, …): describe the reader in plain language and Athena writes
  the instruction for you. Pick a type per chat.
- **Streaming answers** — responses stream in token by token, with live status
  ("Searching the code…", "Reading the source…") as the agent investigates.
- **Built for reading** — Markdown + syntax-highlighted code blocks, rendered
  Mermaid diagrams for flows, copy and regenerate on every answer, and
  English / Tiếng Việt UI + response language.
- **Saved history** — conversations persist server-side (SQLite); a sidebar lets
  you revisit, rename, and delete past chats.
- **Scoped questions** — type `@repo` to focus on one app or `#symbol` to focus
  on a specific feature/screen.
- **Bring your own docs** — upload specs, PDFs, or spreadsheets from the dashboard.
  They're chunked, embedded, made searchable in chat, and automatically linked to
  the code symbols they mention — no full rebuild required.
- **Structured access too** — the same graph powers a REST API and an MCP server
  for editors and agents.

## Architecture

```
repos (config/sources.yaml)
   └─ L0 fetch         git clone → .sources/
      └─ L1 CodeGraph  multi-lang AST → structure           (npm: codegraph)
         └─ L4 Graphify cluster bridge → concept communities (pip: graphifyy)
            └─ L3 store  unified graph → .knowledge/graph.json (networkx)
               └─ L5 GraphQuery  ── MCP server   (src/query/server.py)
                                 ├─ HTTP API      (src/api/app.py, OpenAI Q&A)
                                 └─ NL Q&A        (src/query/ask.py)

documents (uploads / config/docs.yaml)
   └─ L2 docs ingest   docx·pdf·csv·xls → passages, embedded, linked to code
                       (merged into the same graph; incremental reindex, no rebuild)

web front-ends
   :8000  dashboard  (dashboard/)          manage repos & docs, build, browse the graph
   :8100  chat app   (example/frontend +   ask questions, with saved history;
                      example/backend)     proxies Q&A to the API on :8000
```

Everything downstream of L5 depends only on **`GraphQuery`**. The two web apps
run as separate services — the dashboard is hosted by the API, and the chat app
is a thin stateful layer (SQLite) that proxies to it. See
[`INTEGRATION.md`](INTEGRATION.md) for embedding Athena into your own system.

## Quick start

**Prerequisites:** Python 3.10+ · Node 22.5+ (for the `codegraph` extractor) ·
an OpenAI API key (optional — only for natural-language Q&A).

```bash
# 1. Install
pip install -r requirements.txt
npm i -g @colbymchenry/codegraph        # L1 extractor (needs Node 22.5+)

# 2. Point Athena at your repos
#    edit config/sources.yaml  (see config/sources.example.yaml)

# 3. Build the knowledge graph  (fetch + extract + merge)
python src/main.py all                  # or: fetch | build

# 4. Enable natural-language Q&A
cp example.env .env                      # then set OPENAI_API_KEY

# 5. Run the management dashboard + API
python -m uvicorn api.app:app --app-dir src            # → http://127.0.0.1:8000

# 6. Run the chat app (persists history; proxies Q&A to the API above)
python -m uvicorn app:app --app-dir example/backend    # → http://127.0.0.1:8100
```

Open <http://127.0.0.1:8000> to manage repos, build the graph, and browse it, and
<http://127.0.0.1:8100/chat> for the chat UI with saved conversation history.
Without `OPENAI_API_KEY` the graph and structured search still work — only the
natural-language Q&A is disabled.

### Docker

The image bundles everything the pipeline needs — Python deps, the `codegraph`
CLI (Node 22), Graphify, and `git`/`ssh` for cloning repos. Compose runs two
services from the one image: the **dashboard + API on 8000** and the **chat app
on 8100**. Requires Docker with Compose v2.

```bash
# 1. Config the container mounts from the host. Compose mounts the whole config/
#    folder, so you only need your repo list — everything else (workspace, MCP,
#    personas) is created there at runtime.
cp example.env .env                                     # then set OPENAI_API_KEY
cp config/sources.example.yaml config/sources.yaml      # your repos (editable later from the UI)
mkdir -p config .sources .knowledge                     # config + cloned repos + built graph

# 2. Build the image and start both services.
docker compose up --build                 # dashboard :8000 · chat :8100/chat  (Ctrl-C to stop)
#   or run detached:  docker compose up --build -d

# 3. Build the knowledge graph (fetch + extract + merge). Either click through the
#    web UI at http://localhost:8000, or run the pipeline inside the container:
docker compose exec athena python src/main.py all
```

Notes:

- **Private repos over SSH** — Compose mounts `~/.ssh` read-only so the container
  can clone `git@…` remotes with your keys.
- **Persistence** — the `config/` folder, `.sources/`, and
  `.knowledge/` are bind-mounted, so your config and the built graph survive
  `docker compose down` and rebuilds. Chat history lives on the `chat-data`
  volume (SQLite), so conversations survive restarts too.
- **Live code edits** — `src/`, `dashboard/`, and `example/` are mounted; apply
  changes with `docker compose restart` (no rebuild needed).
- **Q&A** — as with the local setup, without `OPENAI_API_KEY` in `.env` only the
  graph and structured search work; natural-language Q&A stays disabled.

Stop and clean up with `docker compose down`.

## Configuration

Copy `example.env` to `.env` (loaded automatically by the API and MCP server).

| Variable                     | Default                 | Purpose                                                                   |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `OPENAI_API_KEY`             | —                       | LLM API key. Enables Q&A; unset → structured search only.                 |
| `ATHENA_API_BASE`            | —                       | OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter, …). Unset → OpenAI. |
| `ATHENA_API_KEY`             | —                       | Provider-agnostic key alias (wins over `OPENAI_API_KEY`).                 |
| `ATHENA_ASK_MODEL`           | `gpt-4.1-nano`          | Any tool-capable model on your provider.                                  |
| `ATHENA_EMBED_MODEL`         | `text-embedding-3-small`| Embedding model for document search (falls back to BM25 if no API key).   |
| `ATHENA_GRAPH`               | `.knowledge/graph.json` | Path to the built graph.                                                  |
| `ATHENA_TEMPERATURE`         | `0.3`                   | Q&A sampling temperature; `none` to omit (reasoning models).              |
| `ATHENA_MAX_TOKENS`          | `2048`                  | Max tokens for a Q&A answer.                                              |
| `ATHENA_TOKENS_PARAM`        | `max_tokens`            | Token-limit param name (`max_completion_tokens` for o-series/gpt-5).      |
| `ATHENA_PARALLEL_TOOL_CALLS` | `true`                  | Batch independent tool calls; `false` if the model rejects it.            |
| `ATHENA_MAX_STEPS`           | `16`                    | Max tool-calling rounds per question.                                     |
| `ATHENA_TOOL_RESULT_CHARS`   | `12000`                 | Max chars of one tool result fed back (0 = uncapped).                     |
| `ATHENA_MAX_CODE_LINES`      | `400`                   | Max lines returned by one source read.                                    |
| `ATHENA_CODE_CONTEXT`        | `15`                    | Extra lines shown around a symbol.                                        |
| `ATHENA_IMPACT_DEPTH`        | `10`                    | Default hops for impact / blast-radius.                                   |
| `ATHENA_PATH_MAX_LEN`        | `20`                    | Default max hops for shortest-path search.                                |
| `ATHENA_MCP_ALLOW_STDIO`     | `1`                     | Allow local (stdio) MCP servers; `0` = remote http servers only.          |

## HTTP API

| Method  | Path                                    | Purpose                                      |
| ------- | --------------------------------------- | -------------------------------------------- |
| GET     | `/api/status`                           | graph stats, repos, whether Q&A is available |
| GET/PUT | `/api/sources`                          | read / write `config/sources.yaml`           |
| POST    | `/api/fetch` · `/api/build`             | start pipeline jobs → `{job_id}`             |
| GET     | `/api/jobs/{id}`                        | job status (`running`/`succeeded`/`failed`)  |
| GET     | `/api/search?q=&repo=&type=`            | symbol search                                |
| GET     | `/api/symbol/{id}` · `/api/impact/{id}` | detail · blast radius                        |
| GET     | `/api/communities?q=`                   | concept clusters                             |
| GET     | `/api/docs`                             | list indexed documents                       |
| POST    | `/api/docs/upload` · `/api/docs/reindex`| upload a file · reindex the docs layer       |
| GET     | `/api/docs/search?q=`                   | search document passages                     |
| POST    | `/api/ask` `{question}`                 | natural-language answer (+ tool trace)       |
| POST    | `/api/ask/stream` `{question}`          | same, streamed as Server-Sent Events         |
| GET     | `/api/personas`                         | list answer types (built-in + custom)        |
| POST    | `/api/personas`                         | create / update a custom type                |
| DELETE  | `/api/personas/{id}`                    | delete a custom type                         |
| POST    | `/api/personas/generate` `{description}`| draft a type's instruction from a description|

The chat app (`example/backend`, :8100) adds conversation + history endpoints
(`/api/conversations…`) on top of this API — see
[`example/backend/README.md`](example/backend/README.md).

## MCP server

Registered in `.mcp.json` as `athena`. Tools: `overview`, `search_symbols`,
`get_symbol`, `neighbors`, `callers`, `callees`, `impact`, `find_path`,
`list_communities`, `community_members`.

```bash
python src/query/server.py     # stdio; ATHENA_GRAPH=/path/to/graph.json
```

## Embed the query engine

```python
from query.engine import GraphQuery

q = GraphQuery(".knowledge/graph.json")
q.search_symbols("PaymentService", type="Class")
q.impact("cg:<repo>:class:<hash>", depth=2)      # change blast radius
```

## Project layout

```
src/
  main.py              pipeline CLI (fetch | build | all)
  config.py            env + paths
  extractors/          L1 CodeGraph + L4 Graphify adapters
  graph/               merge, schema, NetworkX store
  query/
    engine.py          GraphQuery — the shared query surface
    ask.py             natural-language Q&A (agentic, streaming)
    server.py          MCP server
  api/app.py           FastAPI HTTP API + management dashboard host (:8000)
dashboard/             management web UI — repos, workspace, build (served by the API)
  index.html · css/ · js/
example/
  frontend/            chat web UI (ES modules + CSS)
  backend/             chat service — conversations + history in SQLite (:8100)
```

## Contributing

Issues and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for local setup and guidelines, and [`SECURITY.md`](SECURITY.md) to report a
vulnerability privately.

## License

Released under the MIT License — see [`LICENSE`](LICENSE).
