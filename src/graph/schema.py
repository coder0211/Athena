"""Unified knowledge-graph schema (L3).

Both extractors normalise their output into these Node/Edge types so they can
be merged into a single multi-repo graph:

  * CodeGraph  -> precise AST structure (symbols, calls, imports...)
  * Graphify   -> concepts, communities, semantic edges from docs

Keeping a single schema means store.py / query never need to know which engine
a node came from (only `Source` records that, for provenance).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable


class Source(str, Enum):
    """Which engine produced a node/edge."""

    CODEGRAPH = "codegraph"  # precise AST structure (L1)
    GRAPHIFY = "graphify"    # concepts / semantic docs (L2/L4)
    BRIDGE = "bridge"        # synthesised while merging (code <-> concept)


class NodeType(str, Enum):
    REPO = "Repo"
    DIRECTORY = "Directory"
    FILE = "File"
    CLASS = "Class"
    WIDGET = "Widget"          # UI widget (a specialised class; inferred)
    FUNCTION = "Function"
    METHOD = "Method"
    CONSTANT = "Constant"      # codegraph: constant
    ENUM = "Enum"              # codegraph: enum
    ENUM_MEMBER = "EnumMember"  # codegraph: enum_member
    TYPE_ALIAS = "TypeAlias"   # codegraph: type_alias
    IMPORT = "Import"          # codegraph: import directive as a node
    CONCEPT = "Concept"        # graphify semantic concept
    COMMUNITY = "Community"    # graphify Leiden cluster
    FEATURE = "Feature"        # L4 cross-repo domain/feature


class EdgeType(str, Enum):
    CONTAINS = "CONTAINS"          # file->class, class->method ...
    IMPORTS = "IMPORTS"
    CALLS = "CALLS"
    REFERENCES = "REFERENCES"      # codegraph: references
    INSTANTIATES = "INSTANTIATES"  # codegraph: instantiates
    EXTENDS = "EXTENDS"
    IMPLEMENTS = "IMPLEMENTS"
    USES = "USES"                  # fallback for unmapped code relations
    MEMBER_OF = "MEMBER_OF"        # method -> class
    RELATES_TO = "RELATES_TO"      # concept <-> concept
    REALIZES = "REALIZES"          # code symbol -> concept/feature (bridge, L3)


class Provenance(str, Enum):
    """Mirrors graphify's tagging: was the edge explicit or resolved?"""

    EXTRACTED = "EXTRACTED"  # explicit in source
    INFERRED = "INFERRED"    # resolved / guessed


@dataclass(slots=True)
class Node:
    id: str
    type: NodeType
    name: str
    source: Source
    repo: str | None = None
    path: str | None = None
    qualified_name: str | None = None
    language: str | None = None
    properties: dict[str, Any] = field(default_factory=dict)

    def merge(self, other: "Node") -> None:
        """Fold another view of the same id into this one (first non-null wins)."""
        self.qualified_name = self.qualified_name or other.qualified_name
        self.path = self.path or other.path
        self.repo = self.repo or other.repo
        self.language = self.language or other.language
        for k, v in other.properties.items():
            self.properties.setdefault(k, v)


@dataclass(slots=True)
class Edge:
    src: str
    dst: str
    type: EdgeType
    source: Source
    provenance: Provenance = Provenance.EXTRACTED
    properties: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.src, self.dst, self.type.value)


@dataclass
class KnowledgeGraph:
    """In-memory unified graph; graph/store.py persists it."""

    nodes: dict[str, Node] = field(default_factory=dict)
    edges: dict[tuple[str, str, str], Edge] = field(default_factory=dict)

    def add_node(self, node: Node) -> None:
        existing = self.nodes.get(node.id)
        if existing is not None:
            existing.merge(node)
        else:
            self.nodes[node.id] = node

    def add_edge(self, edge: Edge) -> None:
        self.edges.setdefault(edge.key, edge)

    def extend(
        self,
        nodes: Iterable[Node] = (),
        edges: Iterable[Edge] = (),
    ) -> None:
        for n in nodes:
            self.add_node(n)
        for e in edges:
            self.add_edge(e)

    def stats(self) -> dict[str, int]:
        return {"nodes": len(self.nodes), "edges": len(self.edges)}
