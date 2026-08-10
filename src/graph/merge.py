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

import re
from collections.abc import Iterable
from pathlib import Path

from extractors.codegraph import CodeGraphExtractor
from extractors.graphify import GraphifyExtractor
from graph import doc_store, graphify_io
from graph.schema import (
    Edge,
    EdgeType,
    KnowledgeGraph,
    Node,
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
    progress=None,
) -> KnowledgeGraph:
    """Merge many repos into one graph, then run the L4 cluster bridge.

    `progress(phase, current, total, detail)` is an optional status callback (used
    by the API job runner to drive the dashboard's live build progress).
    """
    kg = KnowledgeGraph()
    paths = list(repo_paths)
    total = len(paths)
    for i, path in enumerate(paths):
        if progress:
            progress("extract", i, total, Path(path).name)
        sub = build_repo_graph(
            path, run_tools=run_tools, with_graphify_docs=with_graphify_docs
        )
        kg.extend(sub.nodes.values(), sub.edges.values())

    if cluster:
        if progress:
            progress("cluster", total, total, "")
        n = graphify_io.cluster_graph(
            kg, workdir=cluster_workdir, run=run_tools
        )
        print(f"L4: detected {n} communities via graphify cluster bridge")

    return kg


# --- L2 document layer ----------------------------------------------------
# code-node types worth linking a document mention to (skip Files/Imports)
_MENTION_TYPES = {
    NodeType.CLASS,
    NodeType.WIDGET,
    NodeType.FUNCTION,
    NodeType.METHOD,
    NodeType.ENUM,
    NodeType.CONSTANT,
    NodeType.TYPE_ALIAS,
}
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{3,}")
_MAX_MENTIONS_PER_SECTION = 15
_MAX_TARGETS_PER_NAME = 3


def build_docs(
    kg: KnowledgeGraph,
    *,
    run_tools: bool = True,
    embed_docs: bool = True,
) -> int:
    """Ingest documents into `kg` and persist their passages.

    Runs the DocumentExtractor over every configured root, adds Document /
    DocSection nodes, computes embeddings (best-effort), writes the passage
    sidecar store, then bridges sections to the code they mention. Returns the
    number of documents ingested. `run_tools=False` reuses the existing passage
    store (mirrors the code extractors' skip-work switch)."""
    from extractors.documents import DocumentExtractor
    from utils.docs import document_roots

    if not run_tools:
        _reattach_docs_from_store(kg)
        return sum(
            1 for n in kg.nodes.values() if n.type is NodeType.DOCUMENT
        )

    roots = document_roots()
    if not roots:
        print("L2 docs: no document roots configured — skipping")
        return 0

    ex = DocumentExtractor(roots).build()
    passages = ex.passages()
    if not passages:
        print("L2 docs: no readable documents found")
        doc_store.clear()
        return 0

    _embed_passages(passages, embed_docs)
    doc_store.write_passages(passages)
    kg.extend(ex.nodes(), ex.edges())

    doc_count = sum(1 for n in ex.nodes() if n.type is NodeType.DOCUMENT)
    mentions = _bridge_docs_to_code(kg, passages)
    print(
        f"L2 docs: ingested {doc_count} document(s), {len(passages)} sections, "
        f"{mentions} code mention(s)"
        + (f"; {len(ex.errors)} skipped" if ex.errors else "")
    )
    for err in ex.errors:
        print(f"  ! {err}")
    return doc_count


def _embed_passages(passages: list, embed_docs: bool) -> None:
    """Fill passage embeddings in place (best-effort — BM25 still works without)."""
    if not embed_docs:
        return
    from query import embeddings as embed

    if not embed.is_available():
        print("L2 docs: no embedding provider — indexing with BM25 only")
        return
    try:
        vecs = embed.embed_texts([p.text for p in passages])
    except Exception as e:  # noqa: BLE001 — degrade to BM25, don't fail the build
        print(f"L2 docs: embedding failed ({type(e).__name__}) — BM25 only")
        return
    if vecs:
        for p, v in zip(passages, vecs):
            p.embedding = v
        print(f"L2 docs: embedded {len(vecs)} sections ({embed.model()})")


def _bridge_docs_to_code(kg: KnowledgeGraph, passages: list) -> int:
    """Link a DocSection to the code symbols it names (MENTIONS edges).

    Builds a name index of distinctive code symbols, then scans each passage for
    identifier-like tokens matching one. Bounded per section and per name so a
    generic word can't fan out into thousands of edges."""
    name_index: dict[str, list[str]] = {}
    for node in kg.nodes.values():
        if node.type in _MENTION_TYPES and node.name and _codeish(node.name):
            name_index.setdefault(node.name.lower(), []).append(node.id)
    if not name_index:
        return 0

    total = 0
    for p in passages:
        tokens = {
            t.lower() for t in _IDENT_RE.findall(p.text) if _codeish(t)
        }
        linked = 0
        for tok in tokens:
            for target in name_index.get(tok, [])[:_MAX_TARGETS_PER_NAME]:
                kg.add_edge(
                    Edge(
                        src=p.id,
                        dst=target,
                        type=EdgeType.MENTIONS,
                        source=Source.BRIDGE,
                        provenance=Provenance.INFERRED,
                    )
                )
                total += 1
                linked += 1
            if linked >= _MAX_MENTIONS_PER_SECTION:
                break
    return total


def _codeish(name: str) -> bool:
    """A distinctive identifier: long enough and camelCase or snake_case — so
    'PaymentService'/'get_user' match but generic words like 'data'/'build' don't."""
    if len(name) < 5:
        return False
    has_underscore = "_" in name
    has_mixed = any(c.isupper() for c in name) and any(c.islower() for c in name)
    return has_underscore or has_mixed


def _reattach_docs_from_store(kg: KnowledgeGraph) -> None:
    """When reusing tool outputs (run_tools=False), rebuild Document/DocSection
    nodes from the persisted passage store so the graph still reflects docs."""
    passages = list(doc_store.read_passages())
    if not passages:
        return
    seen_docs: set[str] = set()
    for p in passages:
        if p.doc_id not in seen_docs:
            seen_docs.add(p.doc_id)
            kg.add_node(
                Node(
                    id=p.doc_id,
                    type=NodeType.DOCUMENT,
                    name=p.doc_name,
                    source=Source.DOCS,
                    path=p.path,
                )
            )
        kg.add_node(
            Node(
                id=p.id,
                type=NodeType.DOC_SECTION,
                name=p.title,
                source=Source.DOCS,
                path=p.path,
                properties={"locator": p.locator, "document": p.doc_name},
            )
        )
        kg.add_edge(
            Edge(p.doc_id, p.id, EdgeType.CONTAINS, Source.DOCS, Provenance.EXTRACTED)
        )
    _bridge_docs_to_code(kg, passages)


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
