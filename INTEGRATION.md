# Integrating Athena

Athena turns a set of Git repositories into a queryable **code knowledge graph**
and exposes it three ways — an HTTP API, an MCP server, and a web UI — all over
one shared query engine (`src/query/engine.py`). This is a reference layout you
can drop into your own system.

## Architecture

```
repos (sources.yaml)
   └─ L0 fetch         git clone → .sources/
      └─ L1 CodeGraph  Dart/多-lang AST → structure          (npm: codegraph)
         └─ L4 Graphify cluster bridge → concept communities  (pip: graphifyy)
            └─ L3 store  unified graph → .knowledge/graph.json (networkx)
               └─ L5 GraphQuery  ── MCP server   (src/query/server.py)
                                 ├─ HTTP API      (src/api/app.py)
                                 └─ NL Q&A        (src/query/ask.py, Claude)
```

To embed Athena elsewhere, depend on **`GraphQuery`** (structured queries) and,
optionally, **`ask.answer()`** (natural language). Both take a path to
`graph.json`.

```python
from query.engine import GraphQuery
q = GraphQuery(".knowledge/graph.json")
q.search_symbols("SomeService", type="Class")
q.impact("cg:<repo>:class:<hash>", depth=2)       # change blast radius
```

## Run the web app + API

```bash
pip install -r requirements.txt
npm i -g @colbymchenry/codegraph          # L1 engine (needs Node 22.5+)
python -m uvicorn api.app:app --app-dir src   # → http://127.0.0.1:8000
```

The UI lets you: manage repos, run Fetch/Build, browse graph stats, search
symbols, and ask natural-language questions. Set `OPENAI_API_KEY` to enable
Q&A (model via `ATHENA_ASK_MODEL`, default `gpt-4o`); without it, the UI falls
back to structured search.

## Run with Docker

```bash
cp example.env .env      # then fill in OPENAI_API_KEY
docker compose up --build   # → http://localhost:8000
```

`docker-compose.yaml` mounts `sources.yaml`, `.sources/`, `.knowledge/`, and your
`~/.ssh` (read-only, for cloning private repos), and loads secrets from `.env`.

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

## MCP server

Registered in `.mcp.json` as `athena`. Tools: `overview`, `search_symbols`,
`get_symbol`, `neighbors`, `callers`, `callees`, `impact`, `find_path`,
`list_communities`, `community_members`. Point any MCP client at:

```
python src/query/server.py     # stdio; ATHENA_GRAPH=/path/to/graph.json
```
