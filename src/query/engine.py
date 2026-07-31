"""Shared query engine over the unified knowledge graph.

One implementation, three front-ends: the MCP server (query/server.py), the HTTP
API (api/app.py), and the natural-language Q&A (query/ask.py) all call these
methods. Every method returns plain JSON-serializable dicts/lists.
"""

from __future__ import annotations

import os
from collections import Counter
from pathlib import Path

import networkx as nx

import config
from graph.store_networkx import NetworkXStore
from utils.workspace import load_workspace

# Where the cloned repos live, so we can read actual source for a symbol.
_SOURCES_ROOT = Path(
    os.environ.get("ATHENA_SOURCES", Path(__file__).resolve().parents[2] / ".sources")
)

# Tunable limits (env-overridable, read at call time — see config.int_env / example.env):
#   ATHENA_MAX_CODE_LINES  max lines returned by a source read      (default 160)
#   ATHENA_CODE_CONTEXT    extra lines shown around a symbol         (default 3)
#   ATHENA_IMPACT_DEPTH    default hops for impact()                 (default 2)
#   ATHENA_PATH_MAX_LEN    default max length for find_path()        (default 6)

_DEPENDENCY_RELATIONS = {
    "CALLS",
    "REFERENCES",
    "INSTANTIATES",
    "EXTENDS",
    "IMPLEMENTS",
    "IMPORTS",
}
_USE_RELATIONS = {"CALLS", "REFERENCES", "INSTANTIATES"}


class GraphQuery:
    def __init__(self, graph_path: str | Path):
        self.graph_path = Path(graph_path)
        if not self.graph_path.exists():
            raise FileNotFoundError(
                f"Graph not found at {self.graph_path}. Run `python src/main.py build`."
            )
        self.store = NetworkXStore.open(self.graph_path)
        self.g: nx.MultiDiGraph = self.store.g
        self.workspace = load_workspace()
        self._overlay_workspace()

    # --- workspace overlay (repo metadata + inter-repo relations) ---------
    def _overlay_workspace(self) -> None:
        """Add a Repo node per repo (with curated metadata) and a typed edge per
        declared relation, into the in-memory graph — no rebuild needed."""
        meta = self.workspace.get("repos", {})
        names = set(self.repos()) | set(meta.keys())
        for name in names:
            m = meta.get(name, {})
            self.g.add_node(
                f"repo:{name}",
                type="Repo",
                name=name,
                repo=name,
                role=m.get("role"),
                description=m.get("description") or "",
                tags=m.get("tags", []),
            )
        for rel in self.workspace.get("relations", []):
            src, dst = rel.get("source"), rel.get("target")
            if not src or not dst:
                continue
            self.g.add_edge(
                f"repo:{src}",
                f"repo:{dst}",
                key=rel.get("type", "related_to"),
                type=(rel.get("type") or "related_to").upper(),
                role="repo_relation",
                description=rel.get("description") or "",
            )

    # --- helpers ---------------------------------------------------------
    def _view(self, node_id: str) -> dict:
        a = self.g.nodes[node_id]
        return {
            "id": node_id,
            "type": a.get("type"),
            "name": a.get("name"),
            "repo": a.get("repo"),
            "path": a.get("path"),
            "qualified_name": a.get("qualified_name"),
            "community": a.get("community"),
            "community_name": a.get("community_name"),
        }

    def _resolve_community(self, community: str) -> str | None:
        if (
            community in self.g.nodes
            and self.g.nodes[community].get("type") == "Community"
        ):
            return community
        needle = community.lower()
        for nid, a in self.g.nodes(data=True):
            if (
                a.get("type") == "Community"
                and needle in str(a.get("name", "")).lower()
            ):
                return nid
        return None

    # --- queries ---------------------------------------------------------
    def repos(self) -> list[str]:
        """Distinct repo names present in the graph (data-driven, not hardcoded)."""
        return sorted(
            {a.get("repo") for _, a in self.g.nodes(data=True) if a.get("repo")}
        )

    def repos_info(self) -> list[dict]:
        """Per-repo metadata + code node counts (workspace layer)."""
        meta = self.workspace.get("repos", {})
        counts: Counter = Counter(
            a.get("repo") for _, a in self.g.nodes(data=True) if a.get("repo")
        )
        out = []
        for name in sorted(set(self.repos()) | set(meta.keys())):
            m = meta.get(name, {})
            # code nodes exclude the synthetic Repo node itself
            n = counts.get(name, 0) - (1 if f"repo:{name}" in self.g else 0)
            out.append(
                {
                    "name": name,
                    "description": m.get("description") or "",
                    "role": m.get("role"),
                    "tags": m.get("tags", []),
                    "nodes": max(0, n),
                }
            )
        return out

    def repo_relations(self) -> list[dict]:
        """Declared typed relations between repos."""
        return [
            {
                "source": r.get("source"),
                "type": r.get("type"),
                "target": r.get("target"),
                "description": r.get("description") or "",
            }
            for r in self.workspace.get("relations", [])
        ]

    def overview(self) -> dict:
        types = Counter(a.get("type") for _, a in self.g.nodes(data=True))
        repos = Counter(
            a.get("repo") for _, a in self.g.nodes(data=True) if a.get("repo")
        )
        comm_size: Counter = Counter()
        for _, dst, a in self.g.edges(data=True):
            if a.get("role") == "community":
                comm_size[dst] += 1
        top = [
            {"name": self.g.nodes[c].get("name"), "members": n}
            for c, n in comm_size.most_common(15)
        ]
        return {
            "nodes": self.g.number_of_nodes(),
            "edges": self.g.number_of_edges(),
            "node_types": dict(types),
            "by_repo": dict(repos),
            "top_communities": top,
        }

    def search_symbols(
        self,
        query: str,
        limit: int = 20,
        repo: str | None = None,
        type: str | None = None,
    ) -> list[dict]:
        needle = query.lower()
        out = []
        for nid, a in self.g.nodes(data=True):
            if needle not in str(a.get("name", "")).lower():
                continue
            if repo and a.get("repo") != repo:
                continue
            if type and a.get("type") != type:
                continue
            out.append(self._view(nid))
            if len(out) >= limit:
                break
        return out

    def get_symbol(self, node_id: str) -> dict:
        if node_id not in self.g.nodes:
            return {"error": f"unknown node id: {node_id}"}
        out_rel = Counter(
            a.get("type") for *_, a in self.g.out_edges(node_id, data=True)
        )
        in_rel = Counter(a.get("type") for *_, a in self.g.in_edges(node_id, data=True))
        skip = {
            "type",
            "name",
            "repo",
            "path",
            "qualified_name",
            "community",
            "community_name",
        }
        return {
            **self._view(node_id),
            "properties": {
                k: v for k, v in self.g.nodes[node_id].items() if k not in skip
            },
            "out_relations": dict(out_rel),
            "in_relations": dict(in_rel),
        }

    def neighbors(
        self,
        node_id: str,
        direction: str = "out",
        relation: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        if node_id not in self.g.nodes:
            return [{"error": f"unknown node id: {node_id}"}]
        rel = relation.upper() if relation else None
        out: list[dict] = []

        def collect(edges, other_idx):
            for edge in edges:
                attrs = edge[-1]
                if rel and attrs.get("type") != rel:
                    continue
                out.append(
                    {"relation": attrs.get("type"), **self._view(edge[other_idx])}
                )
                if len(out) >= limit:
                    return True
            return False

        if direction in ("out", "both") and collect(
            self.g.out_edges(node_id, data=True), 1
        ):
            return out
        if direction in ("in", "both"):
            collect(self.g.in_edges(node_id, data=True), 0)
        return out

    def callers(self, node_id: str, limit: int = 50) -> list[dict]:
        out = []
        for src, _, a in self.g.in_edges(node_id, data=True):
            if a.get("type") in _USE_RELATIONS:
                out.append({"relation": a.get("type"), **self._view(src)})
                if len(out) >= limit:
                    break
        return out

    def callees(self, node_id: str, limit: int = 50) -> list[dict]:
        out = []
        for _, dst, a in self.g.out_edges(node_id, data=True):
            if a.get("type") in _USE_RELATIONS:
                out.append({"relation": a.get("type"), **self._view(dst)})
                if len(out) >= limit:
                    break
        return out

    def impact(self, node_id: str, depth: int | None = None, limit: int = 100) -> dict:
        if node_id not in self.g.nodes:
            return {"error": f"unknown node id: {node_id}"}
        if depth is None:
            depth = config.int_env("ATHENA_IMPACT_DEPTH", 2)
        seen = {node_id}
        frontier = {node_id}
        by_hop: dict[int, list[dict]] = {}
        for hop in range(1, depth + 1):
            nxt = set()
            for target in frontier:
                for src, _, a in self.g.in_edges(target, data=True):
                    if a.get("type") in _DEPENDENCY_RELATIONS and src not in seen:
                        seen.add(src)
                        nxt.add(src)
            if not nxt:
                break
            by_hop[hop] = [self._view(n) for n in list(nxt)[:limit]]
            frontier = nxt
        return {
            "root": self._view(node_id),
            "total_affected": len(seen) - 1,
            "by_hop": by_hop,
        }

    def find_path(
        self, source_id: str, target_id: str, max_len: int | None = None
    ) -> dict:
        if source_id not in self.g.nodes or target_id not in self.g.nodes:
            return {"error": "unknown source or target id"}
        if max_len is None:
            max_len = config.int_env("ATHENA_PATH_MAX_LEN", 6)
        ug = self.g.to_undirected(as_view=True)
        try:
            nodes = nx.shortest_path(ug, source_id, target_id)
        except nx.NetworkXNoPath:
            return {"path": [], "reason": "no path"}
        if len(nodes) - 1 > max_len:
            return {"path": [], "reason": f"shortest path longer than {max_len}"}
        steps = [self._view(nodes[0])]
        for a_id, b_id in zip(nodes, nodes[1:]):
            rel = None
            if self.g.has_edge(a_id, b_id):
                rel = next(iter(self.g.get_edge_data(a_id, b_id).values())).get("type")
            elif self.g.has_edge(b_id, a_id):
                rel = next(iter(self.g.get_edge_data(b_id, a_id).values())).get("type")
            steps.append({"relation": rel, **self._view(b_id)})
        return {"length": len(nodes) - 1, "path": steps}

    def list_communities(self, query: str | None = None, limit: int = 30) -> list[dict]:
        size: Counter = Counter()
        for _, dst, a in self.g.edges(data=True):
            if a.get("role") == "community":
                size[dst] += 1
        needle = query.lower() if query else None
        out = []
        for cid, n in size.most_common():
            name = self.g.nodes[cid].get("name", "")
            if needle and needle not in str(name).lower():
                continue
            out.append({"id": cid, "name": name, "members": n})
            if len(out) >= limit:
                break
        return out

    def community_members(self, community: str, limit: int = 50) -> dict:
        cid = self._resolve_community(community)
        if cid is None:
            return {"error": f"no community matching {community!r}"}
        members = []
        for src, _, a in self.g.in_edges(cid, data=True):
            if a.get("role") == "community":
                members.append(self._view(src))
                if len(members) >= limit:
                    break
        return {
            "community": {"id": cid, "name": self.g.nodes[cid].get("name")},
            "member_count": len(members),
            "members": members,
        }

    # --- source access (for explaining logic/flows) ----------------------
    def _read_slice(self, repo: str, path: str, start: int, end: int) -> dict:
        f = _SOURCES_ROOT / repo / path
        if not f.exists():
            return {"error": f"source file not found: {repo}/{path}"}
        lines = f.read_text(errors="replace").splitlines()
        max_lines = config.int_env("ATHENA_MAX_CODE_LINES", 160)
        start = max(1, start)
        end = min(len(lines), end)
        if end - start + 1 > max_lines:
            end = start + max_lines - 1
        body = "\n".join(f"{i}: {lines[i - 1]}" for i in range(start, end + 1))
        return {"file": f"{repo}/{path}", "lines": f"{start}-{end}", "code": body}

    def read_source(
        self, node_id: str, before: int | None = None, after: int | None = None
    ) -> dict:
        """Actual source code of a symbol (uses its stored file + line range)."""
        if node_id not in self.g.nodes:
            return {"error": f"unknown node id: {node_id}"}
        ctx = config.int_env("ATHENA_CODE_CONTEXT", 3)
        before = ctx if before is None else before
        after = ctx if after is None else after
        a = self.g.nodes[node_id]
        path, repo = a.get("path"), a.get("repo")
        if not path or not repo:
            return {"error": "symbol has no source location"}
        start = a.get("start_line")
        end = a.get("end_line") or start
        if not start:
            slice_ = self._read_slice(repo, path, 1, 200)  # whole-file head fallback
        else:
            slice_ = self._read_slice(repo, path, int(start) - before, int(end) + after)
        return {"node": self._view(node_id), **slice_}

    def read_file(self, repo: str, path: str, start: int = 1, end: int = 300) -> dict:
        """Read an arbitrary slice of a source file under a repo."""
        return self._read_slice(repo, path, start, end)
