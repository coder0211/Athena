"""Persist the unified KnowledgeGraph into an embedded Kuzu graph DB (L3).

Kuzu is the default backend: embedded (no server), file-based, Cypher + vector
index. It stays behind this thin interface so swapping to Neo4j/NetworkX later
touches only this file — extractors and schema stay unchanged.

We use a single generic `Entity` node table and a single `REL` table, both
carrying `type` as a property. That keeps the store schema-stable as we add new
NodeType/EdgeType values without DDL migrations.
"""

from __future__ import annotations

from pathlib import Path

from graph.schema import KnowledgeGraph

try:
    import kuzu
except ImportError:  # keep the skeleton importable before the dep is installed
    kuzu = None


class KuzuStore:
    def __init__(self, db_path: str | Path = ".knowledge/kuzu"):
        if kuzu is None:
            raise ImportError("kuzu not installed — `pip install kuzu`")
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db = kuzu.Database(str(self.db_path))
        self.conn = kuzu.Connection(self.db)
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        self.conn.execute(
            "CREATE NODE TABLE IF NOT EXISTS Entity("
            "id STRING, type STRING, name STRING, source STRING, "
            "repo STRING, path STRING, qualified_name STRING, language STRING, "
            "PRIMARY KEY(id))"
        )
        self.conn.execute(
            "CREATE REL TABLE IF NOT EXISTS REL("
            "FROM Entity TO Entity, type STRING, source STRING, provenance STRING)"
        )

    def load(self, graph: KnowledgeGraph) -> None:
        """Upsert the whole in-memory graph into Kuzu."""
        for node in graph.nodes.values():
            self.conn.execute(
                "MERGE (n:Entity {id: $id}) "
                "SET n.type=$type, n.name=$name, n.source=$source, "
                "n.repo=$repo, n.path=$path, n.qualified_name=$qn, n.language=$lang",
                {
                    "id": node.id,
                    "type": node.type.value,
                    "name": node.name,
                    "source": node.source.value,
                    "repo": node.repo,
                    "path": node.path,
                    "qn": node.qualified_name,
                    "lang": node.language,
                },
            )
        for edge in graph.edges.values():
            self.conn.execute(
                "MATCH (a:Entity {id:$src}), (b:Entity {id:$dst}) "
                "MERGE (a)-[r:REL {type:$type}]->(b) "
                "SET r.source=$source, r.provenance=$prov",
                {
                    "src": edge.src,
                    "dst": edge.dst,
                    "type": edge.type.value,
                    "source": edge.source.value,
                    "prov": edge.provenance.value,
                },
            )

    def query(self, cypher: str):
        return self.conn.execute(cypher)

    def close(self) -> None:
        # Kuzu closes on GC; explicit hook kept for symmetry with other stores.
        self.conn = None
        self.db = None
