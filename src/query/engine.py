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
from graph import doc_store
from graph.store_networkx import NetworkXStore
from utils.workspace import load_workspace

# Where the cloned repos live, so we can read actual source for a symbol.
_SOURCES_ROOT = Path(
    os.environ.get("ATHENA_SOURCES", Path(__file__).resolve().parents[2] / ".sources")
)

# Tunable limits (env-overridable, read at call time — see config.int_env / example.env).
# Defaults below MUST stay in sync with example.env:
#   ATHENA_MAX_CODE_LINES  max lines returned by a source read      (default 400)
#   ATHENA_CODE_CONTEXT    extra lines shown around a symbol         (default 15)
#   ATHENA_IMPACT_DEPTH    default hops for impact()                 (default 10)
#   ATHENA_PATH_MAX_LEN    default max length for find_path()        (default 20)

_DEPENDENCY_RELATIONS = {
    "CALLS",
    "REFERENCES",
    "INSTANTIATES",
    "EXTENDS",
    "IMPLEMENTS",
    "IMPORTS",
}
_USE_RELATIONS = {"CALLS", "REFERENCES", "INSTANTIATES"}

# Search relevance: when scores tie, surface the more "code-central" kinds first.
_TYPE_RANK = {
    "Class": 0,
    "Widget": 0,
    "Enum": 0,
    "Method": 1,
    "Function": 1,
    "Constant": 2,
    "Community": 3,
    "File": 4,
}


def _ws_node_id(ref: str) -> str:
    """Resolve a workspace relation endpoint to a graph node id. Already-prefixed
    ids ('repo:web', 'doc:ab12') pass through; a bare name is treated as a repo."""
    return ref if ":" in ref else f"repo:{ref}"


def _initials(name: str) -> str:
    """Acronym of a symbol name from word starts — camelCase and separator
    boundaries. 'PaymentService' -> 'ps', 'get_user_by_id' -> 'gubi'. Lets a
    query like 'ps' or 'gubi' match without typing the whole name."""
    out = []
    prev = ""
    for ch in name:
        if ch.isalnum():
            if not prev.isalnum():  # first letter of a word
                out.append(ch)
            elif ch.isupper() and prev.islower():  # camelCase boundary
                out.append(ch)
            elif ch.isdigit() and not prev.isdigit():
                out.append(ch)
        prev = ch
    return "".join(out).lower()


def _subseq_pos(hay: str, needle: str) -> int | None:
    """If every char of `needle` appears in `hay` in order (not necessarily
    contiguous), return the index of the first matched char; else None.
    Enables fuzzy matches like 'paysvc' -> 'paymentservice'."""
    ni = 0
    first = -1
    for idx, ch in enumerate(hay):
        if ch == needle[ni]:
            if ni == 0:
                first = idx
            ni += 1
            if ni == len(needle):
                return first
    return None


def _match_rank(name_l: str, initials: str, needle: str) -> tuple[int, int] | None:
    """Score a candidate against `needle` (already lowercased). Returns
    (tier, position) with lower = more relevant, or None if it doesn't match.
    Tiers: 0 exact, 1 prefix, 2 word-boundary, 3 acronym, 4 substring, 5 fuzzy."""
    if name_l == needle:
        return (0, 0)
    pos = name_l.find(needle)
    if pos == 0:
        return (1, 0)
    if pos > 0 and not name_l[pos - 1].isalnum():
        return (2, pos)
    if len(needle) >= 2 and initials.startswith(needle):
        return (3, 0)
    if pos > 0:
        return (4, pos)
    if len(needle) >= 3:  # fuzzy is noisy for 1–2 chars; substring covers those
        sp = _subseq_pos(name_l, needle)
        if sp is not None:
            return (5, sp)
    return None


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
        # Derived-data caches — safe because the graph is immutable for this
        # instance (api.get_engine() rebuilds a fresh one when the files change).
        self._repos_cache: list[str] | None = None
        self._comm_sizes: Counter | None = None
        self._name_index: list[tuple] | None = None
        # Document retrieval (lazy — built on first search_docs call).
        self._retriever = None
        self._passages_by_id: dict | None = None
        self._overlay_workspace()

    # --- workspace overlay (repo metadata + inter-repo relations) ---------
    def _overlay_workspace(self) -> None:
        """Add a Repo node per repo (with curated metadata) and a typed edge per
        declared relation, into the in-memory graph — no rebuild needed."""
        meta = self.workspace.get("repos", {})
        names = set(self._distinct_repos()) | set(meta.keys())
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
        # Overlay curated metadata onto indexed Document nodes (so a doc's
        # human description/tags travel with it into search + Q&A).
        for doc_id, dm in self.workspace.get("docs", {}).items():
            if doc_id not in self.g.nodes:
                continue
            node = self.g.nodes[doc_id]
            if dm.get("description"):
                node["description"] = dm["description"]
            if dm.get("tags"):
                node["tags"] = dm["tags"]
        for rel in self.workspace.get("relations", []):
            src, dst = rel.get("source"), rel.get("target")
            if not src or not dst:
                continue
            # Relation endpoints are node ids: "repo:<name>" or "doc:<id>". Bare
            # names (legacy / repo-only) are treated as repos. A "doc:<id>" that
            # matches an indexed Document links curated metadata straight to it.
            self.g.add_edge(
                _ws_node_id(src),
                _ws_node_id(dst),
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

    # --- derived-data caches (graph is immutable per instance) -----------
    def _distinct_repos(self) -> list[str]:
        return sorted(
            {a.get("repo") for _, a in self.g.nodes(data=True) if a.get("repo")}
        )

    def _community_sizes(self) -> Counter:
        """Member count per Community node — scanned once, then reused."""
        if self._comm_sizes is None:
            c: Counter = Counter()
            for _, dst, a in self.g.edges(data=True):
                if a.get("role") == "community":
                    c[dst] += 1
            self._comm_sizes = c
        return self._comm_sizes

    def _search_rows(self) -> list[tuple]:
        """Prebuilt (id, name_lower, initials, degree, repo, type) index so
        search does a light list scan instead of walking the graph dict on every
        call. `initials` powers acronym search; `degree` (how connected a symbol
        is) breaks ties toward the more central, more-used symbol."""
        if self._name_index is None:
            rows = []
            for nid, a in self.g.nodes(data=True):
                name = a.get("name")
                if name:
                    name = str(name)
                    rows.append(
                        (
                            nid,
                            name.lower(),
                            _initials(name),
                            self.g.degree(nid),
                            a.get("repo"),
                            a.get("type"),
                        )
                    )
            self._name_index = rows
        return self._name_index

    # --- queries ---------------------------------------------------------
    def repos(self) -> list[str]:
        """Distinct repo names present in the graph (data-driven, not hardcoded)."""
        if self._repos_cache is None:
            self._repos_cache = self._distinct_repos()
        return self._repos_cache

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

    def _node_label(self, ref: str) -> str:
        """Human name for a workspace relation endpoint (repo name or document
        name); falls back to the bare id if the node isn't in the graph."""
        nid = _ws_node_id(ref)
        if nid in self.g.nodes:
            return self.g.nodes[nid].get("name") or ref
        return ref[len("repo:"):] if ref.startswith("repo:") else ref

    def repo_relations(self) -> list[dict]:
        """Declared typed relations between repositories and documents, with the
        endpoint kind so the reader knows what's being connected."""
        out = []
        for r in self.workspace.get("relations", []):
            src, dst = r.get("source", ""), r.get("target", "")
            out.append(
                {
                    "source": self._node_label(src),
                    "source_kind": "document" if _ws_node_id(src).startswith("doc:") else "repo",
                    "type": r.get("type"),
                    "target": self._node_label(dst),
                    "target_kind": "document" if _ws_node_id(dst).startswith("doc:") else "repo",
                    "description": r.get("description") or "",
                }
            )
        return out

    def overview(self) -> dict:
        types = Counter(a.get("type") for _, a in self.g.nodes(data=True))
        repos = Counter(
            a.get("repo") for _, a in self.g.nodes(data=True) if a.get("repo")
        )
        top = [
            {"name": self.g.nodes[c].get("name"), "members": n}
            for c, n in self._community_sizes().most_common(15)
        ]
        return {
            "nodes": self.g.number_of_nodes(),
            "edges": self.g.number_of_edges(),
            "node_types": dict(types),
            "by_repo": dict(repos),
            "top_communities": top,
        }

    def _ranked_ids(
        self,
        query: str,
        limit: int,
        repo: str | None,
        type: str | None,
    ) -> list[str]:
        """Node ids matching `query` most relevant first. Matching is exact >
        prefix > word-boundary > acronym > substring > fuzzy subsequence; ties
        break by match position, then more-connected symbol, then shorter name,
        then type priority."""
        needle = query.lower()
        matches = []
        for nid, name_l, initials, deg, r, ty in self._search_rows():
            if repo and r != repo:
                continue
            if type and ty != type:
                continue
            scored = _match_rank(name_l, initials, needle)
            if scored is None:
                continue
            tier, pos = scored
            # Tie-break order: match quality (tier, pos) → kind (prefer real code
            # symbols over community hubs) → centrality (-deg, more-used first) →
            # shorter name. So degree only decides between same-kind candidates.
            key = (name_l, ty, r)
            matches.append((tier, pos, _TYPE_RANK.get(ty, 99), -deg, len(name_l), nid, key))
        matches.sort(key=lambda m: m[:5])
        # Collapse duplicates that would look identical in the picker (same name,
        # type, and repo), keeping the best-ranked one.
        out, seen = [], set()
        for m in matches:
            if m[6] in seen:
                continue
            seen.add(m[6])
            out.append(m[5])
            if len(out) >= limit:
                break
        return out

    def search_symbols(
        self,
        query: str,
        limit: int = 20,
        repo: str | None = None,
        type: str | None = None,
    ) -> list[dict]:
        return [self._view(nid) for nid in self._ranked_ids(query, limit, repo, type)]

    def search_brief(
        self,
        query: str,
        limit: int = 20,
        repo: str | None = None,
        type: str | None = None,
    ) -> list[dict]:
        """Slim search results (id/name/repo/type only) for autocomplete pickers,
        avoiding the full _view payload (path, qualified_name, community, ...)."""
        out = []
        for nid in self._ranked_ids(query, limit, repo, type):
            a = self.g.nodes[nid]
            out.append(
                {
                    "id": nid,
                    "name": a.get("name"),
                    "repo": a.get("repo"),
                    "type": a.get("type"),
                }
            )
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
            depth = config.int_env("ATHENA_IMPACT_DEPTH", 10)
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
            max_len = config.int_env("ATHENA_PATH_MAX_LEN", 20)
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
        needle = query.lower() if query else None
        out = []
        for cid, n in self._community_sizes().most_common():
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
        max_lines = config.int_env("ATHENA_MAX_CODE_LINES", 400)
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
        ctx = config.int_env("ATHENA_CODE_CONTEXT", 15)
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

    # --- documents (docx/pdf/csv/xls knowledge source) -------------------
    def _load_docs(self) -> None:
        """Build the passage lookup + hybrid retriever once, on first use."""
        if self._retriever is not None:
            return
        from query.retrieval import DocRetriever

        passages = list(doc_store.read_passages())
        self._passages_by_id = {p.id: p for p in passages}
        self._retriever = DocRetriever(passages)

    def has_docs(self) -> bool:
        self._load_docs()
        return self._retriever.count > 0

    def search_docs(
        self, query: str, limit: int = 8, documents: list[str] | None = None
    ) -> list[dict]:
        """Hybrid (BM25 + embedding) search over ingested document passages.
        `documents` (names or ids) narrows the search to those documents only."""
        self._load_docs()
        return self._retriever.search(query, limit=limit, documents=documents)

    def list_documents(self) -> list[dict]:
        """Every ingested Document with its type, size and section count."""
        out = []
        for nid, a in self.g.nodes(data=True):
            if a.get("type") == "Document":
                out.append(
                    {
                        "id": nid,
                        "name": a.get("name"),
                        "path": a.get("path"),
                        "file_type": a.get("file_type"),
                        "sections": a.get("sections"),
                        "size_bytes": a.get("size_bytes"),
                    }
                )
        return sorted(out, key=lambda d: (d.get("name") or "").lower())

    def get_document(self, doc_id: str) -> dict:
        """A document's metadata plus the ordered list of its sections."""
        if doc_id not in self.g.nodes or self.g.nodes[doc_id].get("type") != "Document":
            return {"error": f"unknown document id: {doc_id}"}
        a = self.g.nodes[doc_id]
        sections = []
        for _, sid, ea in self.g.out_edges(doc_id, data=True):
            if ea.get("type") != "CONTAINS":
                continue
            s = self.g.nodes[sid]
            sections.append(
                {
                    "id": sid,
                    "title": s.get("name"),
                    "locator": s.get("locator"),
                    "index": s.get("index", 0),
                }
            )
        sections.sort(key=lambda s: s.get("index") or 0)
        return {
            "id": doc_id,
            "name": a.get("name"),
            "path": a.get("path"),
            "file_type": a.get("file_type"),
            "size_bytes": a.get("size_bytes"),
            "sections": sections,
        }

    def read_passage(self, section_id: str) -> dict:
        """Full text of a document section, plus the code symbols it mentions."""
        self._load_docs()
        p = (self._passages_by_id or {}).get(section_id)
        if p is None:
            return {"error": f"unknown document section id: {section_id}"}
        mentions = []
        if section_id in self.g.nodes:
            for _, dst, ea in self.g.out_edges(section_id, data=True):
                if ea.get("type") == "MENTIONS":
                    mentions.append(self._view(dst))
        out = {
            "id": p.id,
            "document": p.doc_name,
            "path": p.path,
            "title": p.title,
            "locator": p.locator,
            "text": p.text,
            "mentions_code": mentions,
        }
        # Curated workspace note on the parent document, if any (so the agent
        # reads the human context alongside the passage).
        da = self.g.nodes[p.doc_id] if p.doc_id in self.g.nodes else {}
        if da.get("description"):
            out["document_note"] = da["description"]
        if da.get("tags"):
            out["document_tags"] = da["tags"]
        return out
