"""Athena L5 — MCP server over the unified knowledge graph.

Thin MCP wrapper around query/engine.py (the same GraphQuery the HTTP API and
natural-language Q&A use). Loads `.knowledge/graph.json` and exposes query tools
to an AI agent.

Run (stdio):  python src/query/server.py
Env:          ATHENA_GRAPH=/path/to/graph.json   (default: <repo>/.knowledge/graph.json)
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow `from graph...` / `from query...` imports whether launched as script or module.
_SRC = Path(__file__).resolve().parents[1]
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from mcp.server import MCPServer  # noqa: E402

import config  # noqa: E402
from query.engine import GraphQuery  # noqa: E402

config.load_env()
GRAPH_PATH = config.graph_path()

Q = GraphQuery(GRAPH_PATH)
_REPOS = ", ".join(Q.repos()) or "(none)"

server = MCPServer(
    name="athena",
    instructions=(
        f"Query the Athena code knowledge graph built from these repos: {_REPOS}. "
        "Node ids look like 'cg:<repo>:<kind>:<hash>'. Start with search_symbols to "
        "get ids, then get_symbol / callers / callees / impact / find_path."
    ),
)


@server.tool()
def overview() -> dict:
    """Graph stats: totals, node types, repos, and the largest concept communities."""
    return Q.overview()


@server.tool()
def search_symbols(
    query: str, limit: int = 20, repo: str | None = None, type: str | None = None
) -> list[dict]:
    """Find symbols by name substring. Filter by repo
    and node type (Class|Method|Function|File|Enum|Constant|Community...)."""
    return Q.search_symbols(query, limit=limit, repo=repo, type=type)


@server.tool()
def get_symbol(node_id: str) -> dict:
    """Full detail for one symbol, incl. incoming/outgoing relation breakdown."""
    return Q.get_symbol(node_id)


@server.tool()
def neighbors(
    node_id: str, direction: str = "out", relation: str | None = None, limit: int = 50
) -> list[dict]:
    """Neighbouring symbols. direction: out|in|both. Optional relation filter
    (CALLS, REFERENCES, IMPORTS, CONTAINS, EXTENDS, ...)."""
    return Q.neighbors(node_id, direction=direction, relation=relation, limit=limit)


@server.tool()
def callers(node_id: str, limit: int = 50) -> list[dict]:
    """Symbols that call/reference this one (incoming CALLS/REFERENCES/INSTANTIATES)."""
    return Q.callers(node_id, limit=limit)


@server.tool()
def callees(node_id: str, limit: int = 50) -> list[dict]:
    """Symbols this one calls/references (outgoing CALLS/REFERENCES/INSTANTIATES)."""
    return Q.callees(node_id, limit=limit)


@server.tool()
def impact(node_id: str, depth: int = 2, limit: int = 100) -> dict:
    """Change blast radius: symbols transitively depending on this one, up to
    `depth` hops backwards over dependency relations."""
    return Q.impact(node_id, depth=depth, limit=limit)


@server.tool()
def find_path(source_id: str, target_id: str, max_len: int = 6) -> dict:
    """Shortest relationship path between two symbols (undirected)."""
    return Q.find_path(source_id, target_id, max_len=max_len)


@server.tool()
def list_communities(query: str | None = None, limit: int = 30) -> list[dict]:
    """List concept communities (Leiden clusters), largest first; optional name filter."""
    return Q.list_communities(query=query, limit=limit)


@server.tool()
def community_members(community: str, limit: int = 50) -> dict:
    """Members of a concept community (by community id or name substring)."""
    return Q.community_members(community, limit=limit)


if __name__ == "__main__":
    server.run(transport="stdio")
