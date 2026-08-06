# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First public release. Athena turns Git repositories (and, optionally, product
documents) into a queryable code knowledge graph and serves it over a shared
query engine.

### Added

- **Knowledge-graph pipeline** — fetch repos (L0), extract structure with
  CodeGraph (L1), bridge concept communities with Graphify (L4), and merge into a
  unified NetworkX graph (`.knowledge/graph.json`), driven by `src/main.py`
  (`fetch | build | all`).
- **Shared query engine** — `GraphQuery` (`src/query/engine.py`) exposes symbol
  search, symbol detail, neighbors, callers/callees, impact (blast radius),
  shortest-path, and concept communities.
- **Natural-language Q&A** — an agentic, streaming answer engine
  (`src/query/ask.py`) that plans, searches the graph, reads real source and
  uploaded docs, and cites where each claim lives, with a live investigation
  trace. Works with any OpenAI-compatible provider.
- **Answer types (personas)** — built-in **Business** and **Technical** types
  plus user-defined types generated from a one-line description, each with its own
  greeting, starter questions, and one-tap refine buttons; persisted to
  `config/personas.yaml` and served over `/api/personas`.
- **Document layer (L2)** — upload docx/pdf/csv/xls; passages are chunked,
  embedded (with BM25 fallback), searchable in chat, and linked to the code
  symbols they mention via incremental reindex (no full rebuild).
- **HTTP API** — FastAPI service (`src/api/app.py`, `:8000`) for status, sources,
  pipeline jobs, search, symbols, impact, communities, documents, personas, and
  `ask` / `ask/stream` (Server-Sent Events).
- **MCP server** — `src/query/server.py` exposes the graph as MCP tools
  (`overview`, `search_symbols`, `get_symbol`, `neighbors`, `callers`, `callees`,
  `impact`, `find_path`, `list_communities`, `community_members`).
- **Management dashboard** — web UI (`dashboard/`) to add repos, build the graph,
  describe repos and their relations for cross-repo answers, upload documents, and
  browse the graph.
- **Chat app** — web UI (`example/frontend`) + backend (`example/backend`,
  `:8100`) with server-side conversation history (SQLite), streaming answers,
  suggested follow-ups, regenerate, edit-&-resend, scope commands
  (`/repo`, `/document`, `@tool`, `#symbol`), Markdown + syntax highlighting,
  rendered Mermaid diagrams with fullscreen zoom, Markdown export, a
  `⌘/Ctrl-K` command palette, and English / Tiếng Việt UI.
- **Code & source explorers** — click a cited `path:line` or symbol to open its
  real source with callers/callees; click a document citation to read the exact
  passage. The right-hand slide-over sheets are drag-to-resize (double-click the
  grip to reset), with the chosen width shared across panels and persisted.
- **Docker** — a single image bundling the full pipeline (Python, Node 22 for
  CodeGraph, Graphify, git/ssh), with Compose running the dashboard/API (`:8000`)
  and chat app (`:8100`) as two services.

[Unreleased]: https://github.com/coder0211/Athena/commits/dev
