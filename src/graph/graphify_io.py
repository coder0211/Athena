"""Cluster bridge — run Graphify's clustering over a graph CodeGraph produced.

Graphify may lack a tree-sitter grammar for the repo's language, so it cannot
extract structure from such repos itself. But its Leiden community detection +
god-node report only need a
`graph.json`. So we:

    1. serialize our unified KnowledgeGraph -> graphify node-link graph.json
    2. run `graphify cluster-only <dir> --no-viz`   (Leiden, no LLM required)
    3. read back each node's `community` / `community_name`
    4. materialise COMMUNITY nodes + membership edges (the L4 concept layer)

This gives graphify's conceptual layer over the code despite the missing
grammar — it borrows CodeGraph's AST.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

from graph.schema import (
    Edge,
    EdgeType,
    KnowledgeGraph,
    Node,
    NodeType,
    Provenance,
    Source,
)

_OUT_SUBDIR = "graphify-out"


def resolve_cli(cli: str) -> str:
    """Find the graphify binary, falling back to the one next to this venv's
    python (so it works even when the venv is not activated)."""
    if shutil.which(cli):
        return cli
    candidate = Path(sys.executable).parent / cli
    return str(candidate) if candidate.exists() else cli


# --- serialize -------------------------------------------------------------
def _node_to_gf(node: Node) -> dict:
    d: dict = {
        "id": node.id,
        "label": node.qualified_name or node.name,
        "file_type": "code",
        "_origin": "ast",
    }
    if node.path:
        d["source_file"] = node.path
    start = node.properties.get("start_line")
    if start is not None:
        d["source_location"] = f"L{start}"
    return d


def _edge_to_gf(edge: Edge) -> dict:
    return {
        "source": edge.src,
        "target": edge.dst,
        # cluster-only only needs topology; keep our type as the relation label.
        "relation": edge.type.value.lower(),
        "confidence": edge.provenance.value,
        "weight": float(edge.properties.get("weight", 1.0)),
    }


def to_graphify_json(kg: KnowledgeGraph) -> dict:
    """Serialize a KnowledgeGraph into graphify's node-link graph.json shape."""
    return {
        "directed": False,  # community detection is undirected
        "multigraph": False,
        "graph": {},
        "nodes": [_node_to_gf(n) for n in kg.nodes.values()],
        "links": [_edge_to_gf(e) for e in kg.edges.values()],
        "hyperedges": [],
    }


def write_graph(kg: KnowledgeGraph, workdir: str | Path) -> Path:
    """Write graph.json where `graphify cluster-only <workdir>` expects it."""
    out = Path(workdir) / _OUT_SUBDIR / "graph.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(to_graphify_json(kg)))
    return out


# --- run + read ------------------------------------------------------------
def run_cluster(
    workdir: str | Path,
    *,
    cli: str = "graphify",
    no_viz: bool = True,
) -> None:
    """Run Leiden clustering + report on the graph.json under `workdir`."""
    cmd = [resolve_cli(cli), "cluster-only", str(workdir)]
    if no_viz:
        cmd.append("--no-viz")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"graphify cluster-only failed ({proc.returncode}):\n"
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )


def read_communities(graph_json: str | Path) -> dict[str, tuple[int, str | None]]:
    """Map node id -> (community_id, community_name) from a clustered graph.json."""
    data = json.loads(Path(graph_json).read_text())
    out: dict[str, tuple[int, str | None]] = {}
    for raw in data.get("nodes", []):
        cid = raw.get("community")
        if cid is not None:
            out[raw["id"]] = (cid, raw.get("community_name"))
    return out


def apply_communities(
    kg: KnowledgeGraph,
    communities: dict[str, tuple[int, str | None]],
    *,
    label: str = "cluster",
) -> int:
    """Add COMMUNITY nodes + membership edges to kg. Returns #communities."""
    seen: set[int] = set()
    for node_id, (cid, cname) in communities.items():
        if node_id not in kg.nodes:
            continue
        comm_id = f"gf:{label}:community:{cid}"
        if cid not in seen:
            seen.add(cid)
            kg.add_node(
                Node(
                    id=comm_id,
                    type=NodeType.COMMUNITY,
                    name=cname or f"Community {cid}",
                    source=Source.GRAPHIFY,
                )
            )
        # annotate the code node and link it to its community
        kg.nodes[node_id].properties["community"] = cid
        if cname:
            kg.nodes[node_id].properties["community_name"] = cname
        kg.add_edge(
            Edge(
                src=node_id,
                dst=comm_id,
                type=EdgeType.RELATES_TO,
                source=Source.BRIDGE,
                provenance=Provenance.INFERRED,
                properties={"role": "community"},
            )
        )
    return len(seen)


def cluster_graph(
    kg: KnowledgeGraph,
    *,
    workdir: str | Path = ".knowledge/cluster",
    cli: str = "graphify",
    run: bool = True,
    label: str = "cluster",
) -> int:
    """Full bridge: serialize kg, run clustering, fold communities back in.

    Returns the number of communities detected.
    """
    graph_json = write_graph(kg, workdir)
    if run:
        run_cluster(workdir, cli=cli)
    return apply_communities(kg, read_communities(graph_json), label=label)
