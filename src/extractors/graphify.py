"""L2/L4 extractor — Graphify (concepts, communities, doc semantics).

Runs `graphify update <repo>` (tree-sitter extraction, no LLM) to produce
`<repo>/graphify-out/graph.json`, then normalises it into schema Nodes/Edges.

graph.json is NetworkX node-link JSON:
    {directed, multigraph, graph, nodes:[...], links:[...], hyperedges:[...]}

  * node: id, label, file_type, source_file, source_location, _origin,
          community (int), community_name         -- no explicit kind field
  * link: source, target, relation, confidence (EXTRACTED|INFERRED), weight...

Graphify may lack a grammar for the repo's language, so its own AST nodes can be
sparse (only files it has a grammar for). Its lasting value here is the
CONCEPT / COMMUNITY layer:
the Leiden `community` / `community_name` on each node. `communities()` turns
those into COMMUNITY nodes + membership edges (L4).
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Iterator
from pathlib import Path

from graph.schema import Edge, EdgeType, Node, NodeType, Provenance, Source

_OUT_DIR = "graphify-out"
_GRAPH_JSON = "graph.json"

# graphify link `relation` -> our EdgeType
_RELATION_TO_EDGETYPE = {
    "contains": EdgeType.CONTAINS,
    "imports": EdgeType.IMPORTS,
    "imports_from": EdgeType.IMPORTS,
    "calls": EdgeType.CALLS,
    "references": EdgeType.REFERENCES,
    "uses": EdgeType.USES,
    "inherits": EdgeType.EXTENDS,
    "method": EdgeType.MEMBER_OF,
    "rationale_for": EdgeType.RELATES_TO,
}
_NODE_EXTRA_KEYS = ("file_type", "source_file", "source_location", "_origin")


class GraphifyExtractor:
    def __init__(self, repo_path: str | Path, *, cli: str = "graphify"):
        self.repo_path = Path(repo_path)
        self.repo = self.repo_path.name
        self.cli = cli

    @property
    def out_dir(self) -> Path:
        return self.repo_path / _OUT_DIR

    # --- run -------------------------------------------------------------
    def build(self, *, cluster: bool = True) -> None:
        """Run `graphify update` to (re)build graph.json for this repo."""
        cmd = [self.cli, "update", str(self.repo_path)]
        if not cluster:
            cmd.append("--no-cluster")
        subprocess.run(
            cmd,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    # --- read ------------------------------------------------------------
    def _load(self) -> dict:
        path = self.out_dir / _GRAPH_JSON
        if not path.exists():
            raise FileNotFoundError(f"{path} not found; run build() first")
        return json.loads(path.read_text())

    def nodes(self) -> Iterator[Node]:
        """graphify's own nodes (concept/semantic view) + one node per community."""
        data = self._load()
        seen_communities: set[str] = set()
        for raw in data.get("nodes", []):
            yield Node(
                id=self._nid(raw.get("id")),
                type=NodeType.CONCEPT,
                name=raw.get("label") or str(raw.get("id")),
                source=Source.GRAPHIFY,
                repo=self.repo,
                path=raw.get("source_file") or None,
                properties={
                    k: raw[k] for k in _NODE_EXTRA_KEYS if raw.get(k) not in (None, "")
                },
            )
            cid = raw.get("community")
            if cid is not None:
                comm_id = self._community_id(cid)
                if comm_id not in seen_communities:
                    seen_communities.add(comm_id)
                    yield Node(
                        id=comm_id,
                        type=NodeType.COMMUNITY,
                        name=raw.get("community_name") or f"Community {cid}",
                        source=Source.GRAPHIFY,
                        repo=self.repo,
                    )

    def edges(self) -> Iterator[Edge]:
        """Relation links + membership edges (node -> its community)."""
        data = self._load()
        for raw in data.get("links", []):
            etype = _RELATION_TO_EDGETYPE.get(
                str(raw.get("relation", "")).lower(), EdgeType.USES
            )
            provenance = (
                Provenance.EXTRACTED
                if str(raw.get("confidence", "")).upper() == "EXTRACTED"
                else Provenance.INFERRED
            )
            props = {}
            if raw.get("weight") is not None:
                props["weight"] = raw["weight"]
            if raw.get("context"):
                props["context"] = raw["context"]
            yield Edge(
                src=self._nid(raw.get("source")),
                dst=self._nid(raw.get("target")),
                type=etype,
                source=Source.GRAPHIFY,
                provenance=provenance,
                properties=props,
            )
        # community membership (node -> community)
        for raw in data.get("nodes", []):
            cid = raw.get("community")
            if cid is not None:
                yield Edge(
                    src=self._nid(raw.get("id")),
                    dst=self._community_id(cid),
                    type=EdgeType.RELATES_TO,
                    source=Source.GRAPHIFY,
                    provenance=Provenance.INFERRED,
                    properties={"role": "community"},
                )

    def _nid(self, raw: object) -> str:
        return f"gf:{self.repo}:{raw}"

    def _community_id(self, cid: object) -> str:
        return f"gf:{self.repo}:community:{cid}"
