"""NetworkX-backed store for the unified KnowledgeGraph (default L3 backend).

Pure Python — no native build, so it works everywhere Kuzu's wheels don't
(e.g. Python 3.14). Persists to a node-link `graph.json` (and optionally
GraphML for Gephi/yEd). Same surface as KuzuStore (`load` / `query` / `close`)
so the two are interchangeable via the store factory in main.py.

Graph model: a directed multigraph (`MultiDiGraph`) — multiple typed edges may
exist between the same pair of nodes (e.g. CALLS and IMPORTS).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import networkx as nx

from graph.schema import Edge, EdgeType, KnowledgeGraph, Node, NodeType, Provenance, Source


class NetworkXStore:
    def __init__(self, db_path: str | Path = ".knowledge/graph.json"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.g: nx.MultiDiGraph = nx.MultiDiGraph()

    # --- write -----------------------------------------------------------
    def load(self, graph: KnowledgeGraph) -> None:
        """Ingest the in-memory graph and persist to disk."""
        for node in graph.nodes.values():
            self.g.add_node(
                node.id,
                type=node.type.value,
                name=node.name,
                source=node.source.value,
                repo=node.repo,
                path=node.path,
                qualified_name=node.qualified_name,
                language=node.language,
                **node.properties,
            )
        for edge in graph.edges.values():
            self.g.add_edge(
                edge.src,
                edge.dst,
                key=edge.type.value,
                type=edge.type.value,
                source=edge.source.value,
                provenance=edge.provenance.value,
                **edge.properties,
            )
        self.save()

    def save(self) -> None:
        data = nx.node_link_data(self.g, edges="edges")
        self.db_path.write_text(json.dumps(data, indent=2, default=str))

    def to_graphml(self, path: str | Path | None = None) -> Path:
        """Export for Gephi/yEd visual inspection.

        GraphML cannot represent None, so null-valued attributes are dropped
        from a throwaway copy before writing.
        """
        out = Path(path) if path else self.db_path.with_suffix(".graphml")
        clean = nx.MultiDiGraph()
        for nid, attrs in self.g.nodes(data=True):
            clean.add_node(nid, **{k: v for k, v in attrs.items() if v is not None})
        for src, dst, key, attrs in self.g.edges(keys=True, data=True):
            clean.add_edge(
                src, dst, key=key,
                **{k: v for k, v in attrs.items() if v is not None},
            )
        nx.write_graphml(clean, out)
        return out

    # --- read ------------------------------------------------------------
    @classmethod
    def open(cls, db_path: str | Path = ".knowledge/graph.json") -> "NetworkXStore":
        store = cls(db_path)
        if store.db_path.exists():
            data = json.loads(store.db_path.read_text())
            store.g = nx.node_link_graph(
                data, directed=True, multigraph=True, edges="edges"
            )
        return store

    def nodes_by_type(self, ntype: NodeType) -> Iterator[str]:
        for nid, attrs in self.g.nodes(data=True):
            if attrs.get("type") == ntype.value:
                yield nid

    def find(self, name: str) -> list[str]:
        """Case-insensitive node lookup by name."""
        needle = name.lower()
        return [
            nid
            for nid, attrs in self.g.nodes(data=True)
            if needle in str(attrs.get("name", "")).lower()
        ]

    def neighbors(self, node_id: str, *, edge_type: EdgeType | None = None) -> list[str]:
        out = []
        for _, dst, attrs in self.g.out_edges(node_id, data=True):
            if edge_type is None or attrs.get("type") == edge_type.value:
                out.append(dst)
        return out

    def query(self, name: str) -> list[str]:
        """Parity with KuzuStore.query — here a simple name search."""
        return self.find(name)

    def stats(self) -> dict[str, int]:
        return {"nodes": self.g.number_of_nodes(), "edges": self.g.number_of_edges()}

    def close(self) -> None:  # symmetry with KuzuStore
        pass
