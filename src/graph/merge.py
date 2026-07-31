"""L3 merge + L4 concept layer.

  L1  CodeGraph  -> precise code structure (always)
  L2  Graphify   -> doc/markdown semantics (optional; needs supported files)
  L4  cluster    -> Graphify Leiden communities over the CodeGraph structure,
                    via the cluster bridge (graph/graphify_io.py)

Pipeline entry points:
  * build_repo_graph      — one repo
  * build_workspace_graph — many repos -> cross-repo graph (+ clustering)
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from extractors.codegraph import CodeGraphExtractor
from extractors.graphify import GraphifyExtractor
from graph import graphify_io
from graph.schema import (
    Edge,
    EdgeType,
    KnowledgeGraph,
    NodeType,
    Provenance,
    Source,
)

_CONCEPT_TYPES = (NodeType.CONCEPT, NodeType.COMMUNITY, NodeType.FEATURE)


def build_repo_graph(
    repo_path: str | Path,
    *,
    run_tools: bool = True,
    with_graphify_docs: bool = False,
) -> KnowledgeGraph:
    """Extract one repo. CodeGraph always; Graphify's own extraction optional.

    When graphify lacks a grammar for the repo's language it cannot parse code, so
    `with_graphify_docs` is off by default — the concept layer comes from the
    cluster bridge instead (see build_workspace_graph).
    """
    kg = KnowledgeGraph()

    cg = CodeGraphExtractor(repo_path)
    if run_tools:
        cg.build()
    kg.extend(cg.nodes(), cg.edges())

    if with_graphify_docs:
        gf = GraphifyExtractor(repo_path)
        if run_tools:
            gf.build()
        kg.extend(gf.nodes(), gf.edges())
        _bridge_code_to_concept(kg)

    return kg


def build_workspace_graph(
    repo_paths: Iterable[str | Path],
    *,
    run_tools: bool = True,
    with_graphify_docs: bool = False,
    cluster: bool = True,
    cluster_workdir: str | Path = ".knowledge/cluster",
) -> KnowledgeGraph:
    """Merge many repos into one graph, then run the L4 cluster bridge."""
    kg = KnowledgeGraph()
    for path in repo_paths:
        sub = build_repo_graph(
            path, run_tools=run_tools, with_graphify_docs=with_graphify_docs
        )
        kg.extend(sub.nodes.values(), sub.edges.values())

    if cluster:
        n = graphify_io.cluster_graph(
            kg, workdir=cluster_workdir, run=run_tools
        )
        print(f"L4: detected {n} communities via graphify cluster bridge")

    return kg


def _bridge_code_to_concept(kg: KnowledgeGraph) -> None:
    """Link a CodeGraph symbol to a Graphify concept sharing a name.

    Naive case-insensitive name match for the skeleton — good enough to wire the
    two layers together. Replace with embedding / fuzzy matching later. Emitted
    edges are REALIZES, tagged Source.BRIDGE + Provenance.INFERRED so they are
    always distinguishable from engine-native edges.
    """
    concepts = {
        node.name.lower(): node
        for node in kg.nodes.values()
        if node.type in _CONCEPT_TYPES
    }
    if not concepts:
        return

    for node in list(kg.nodes.values()):
        if node.source is not Source.CODEGRAPH:
            continue
        target = concepts.get(node.name.lower())
        if target is not None and target.id != node.id:
            kg.add_edge(
                Edge(
                    src=node.id,
                    dst=target.id,
                    type=EdgeType.REALIZES,
                    source=Source.BRIDGE,
                    provenance=Provenance.INFERRED,
                )
            )
