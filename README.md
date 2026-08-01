<h1><img src="example/logo-owl-solid.svg" alt="" width="30" height="30" align="absmiddle" /> Athena</h1>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io/)

**Turn your Git repositories into a queryable code knowledge graph — then ask
questions about how the product works in plain language.**

<p align="center"><img src="example/screenshot.png" alt="Athena chat UI" width="720" /></p>

> **Screenshot:** replace this line with a screenshot of the chat UI (see comment above).

Athena clones your repos, extracts their structure into a unified graph (symbols,
call/reference edges, concept communities), and serves it three ways over one
shared query engine: a **web chat UI**, an **HTTP API**, and an **MCP server**.
The natural-language Q&A reads the _real_ source code and explains it — for
business stakeholders and developers alike.

---

## Highlights

- **Ask in plain language** — the Q&A agent plans, searches the graph, reads the
  actual code, and explains a flow step by step. It cites where things live.
- **Two audiences, one question** — a **Business** mode (non-technical, no jargon)
  and a **Technical** mode (call paths, files, snippets), toggled per chat.
- **Streaming answers** — responses stream in token by token, with live status
  ("Searching the code…", "Reading the source…") as the agent investigates.
- **Built for reading** — Markdown + syntax-highlighted code blocks, copy and
  regenerate on every answer, and English / Tiếng Việt UI + response language.
- **Scoped questions** — type `@repo` to focus on one app or `#symbol` to focus
  on a specific feature/screen.
- **Structured access too** — the same graph powers a REST API and an MCP server
  for editors and agents.

## Architecture

```
repos (sources.yaml)
   └─ L0 fetch         git clone → .sources/
      └─ L1 CodeGraph  multi-lang AST → structure           (npm: codegraph)
         └─ L4 Graphify cluster bridge → concept communities (pip: graphifyy)
            └─ L3 store  unified graph → .knowledge/graph.json (networkx)
               └─ L5 GraphQuery  ── MCP server   (src/query/server.py)
                                 ├─ HTTP API      (src/api/app.py)
                                 └─ NL Q&A        (src/query/ask.py, OpenAI)
```

Everything downstream of L5 depends only on **`GraphQuery`**. See
[`INTEGRATION.md`](INTEGRATION.md) for embedding Athena into your own system.

## Quick start

**Prerequisites:** Python 3.10+ · Node 22.5+ (for the `codegraph` extractor) ·
an OpenAI API key (optional — only for natural-language Q&A).

```bash
# 1. Install
pip install -r requirements.txt
npm i -g @colbymchenry/codegraph        # L1 extractor (needs Node 22.5+)

# 2. Point Athena at your repos
#    edit sources.yaml  (see example.sources.yaml)

# 3. Build the knowledge graph  (fetch + extract + merge)
python src/main.py all                  # or: fetch | build

# 4. Enable natural-language Q&A
cp example.env .env                      # then set OPENAI_API_KEY

# 5. Run the web app + API
python -m uvicorn api.app:app --app-dir src   # → http://127.0.0.1:8000
```

Open <http://127.0.0.1:8000> to manage repos, build the graph, and browse it;
<http://127.0.0.1:8000/chat> for the chat UI. Without `OPENAI_API_KEY` the graph
and structured search still work — only the natural-language Q&A is disabled.

### Docker

The image bundles everything the pipeline needs — Python deps, the `codegraph`
CLI (Node 22), Graphify, and `git`/`ssh` for cloning repos. It serves the web UI

- API on port **8000**. Requires Docker with Compose v2.

```bash
# 1. Config + files the container mounts from the host.
#    Create these *before* the first run — otherwise Docker creates the two
#    YAML files as empty directories on the bind mount.
cp example.env .env                       # then set OPENAI_API_KEY
cp example.sources.yaml sources.yaml      # your repos (editable later from the UI)
touch workspace.yaml                      # pipeline state (starts empty)
mkdir -p .sources .knowledge              # cloned repos + built graph, persisted to host

# 2. Build the image and start the app.
docker compose up --build                 # → http://localhost:8000  (Ctrl-C to stop)
#   or run detached:  docker compose up --build -d

# 3. Build the knowledge graph (fetch + extract + merge). Either click through the
#    web UI at http://localhost:8000, or run the pipeline inside the container:
docker compose exec athena python src/main.py all
```

Notes:

- **Private repos over SSH** — Compose mounts `~/.ssh` read-only so the container
  can clone `git@…` remotes with your keys.
- **Persistence** — `sources.yaml`, `workspace.yaml`, `.sources/`, and
  `.knowledge/` are bind-mounted, so your config and the built graph survive
  `docker compose down` and rebuilds.
- **Live code edits** — `src/` and `example/` are mounted; apply changes with
  `docker compose restart` (no rebuild needed).
- **Q&A** — as with the local setup, without `OPENAI_API_KEY` in `.env` only the
  graph and structured search work; natural-language Q&A stays disabled.

Stop and clean up with `docker compose down`.

## Configuration

Copy `example.env` to `.env` (loaded automatically by the API and MCP server).

| Variable                | Default                 | Purpose                                            |
| ----------------------- | ----------------------- | -------------------------------------------------- |
| `OPENAI_API_KEY`        | —                       | Enables natural-language Q&A. Unset → search only. |
| `ATHENA_ASK_MODEL`      | `gpt-4.1-nano`          | Any OpenAI model with tool support.                |
| `ATHENA_GRAPH`          | `.knowledge/graph.json` | Path to the built graph.                           |
| `ATHENA_TEMPERATURE`    | `0.3`                   | Q&A sampling temperature (lower = more focused).   |
| `ATHENA_MAX_TOKENS`     | `2048`                  | Max tokens for a Q&A answer.                       |
| `ATHENA_MAX_STEPS`      | `16`                    | Max tool-calling rounds per question.              |
| `ATHENA_MAX_CODE_LINES` | `5000`                  | Max lines returned by one source read.             |
| `ATHENA_CODE_CONTEXT`   | `100`                   | Extra lines shown around a symbol.                 |
| `ATHENA_IMPACT_DEPTH`   | `10`                    | Default hops for impact / blast-radius.            |
| `ATHENA_PATH_MAX_LEN`   | `20`                    | Default max hops for shortest-path search.         |

## HTTP API

| Method  | Path                                    | Purpose                                      |
| ------- | --------------------------------------- | -------------------------------------------- |
| GET     | `/api/status`                           | graph stats, repos, whether Q&A is available |
| GET/PUT | `/api/sources`                          | read / write `sources.yaml`                  |
| POST    | `/api/fetch` · `/api/build`             | start pipeline jobs → `{job_id}`             |
| GET     | `/api/jobs/{id}`                        | job status (`running`/`succeeded`/`failed`)  |
| GET     | `/api/search?q=&repo=&type=`            | symbol search                                |
| GET     | `/api/symbol/{id}` · `/api/impact/{id}` | detail · blast radius                        |
| GET     | `/api/communities?q=`                   | concept clusters                             |
| POST    | `/api/ask` `{question}`                 | natural-language answer (+ tool trace)       |
| POST    | `/api/ask/stream` `{question}`          | same, streamed as Server-Sent Events         |

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
  api/app.py           FastAPI HTTP API + static web UI host
example/               web UI (chat + manage) served at /
```

## Contributing

Issues and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for local setup and guidelines, and [`SECURITY.md`](SECURITY.md) to report a
vulnerability privately.

## License

Released under the MIT License — see [`LICENSE`](LICENSE).
