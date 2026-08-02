"""Incremental document re-index — update the docs layer without a full rebuild.

A full `python src/main.py build` re-extracts every code repo (slow). When only
DOCUMENTS change (a file uploaded, a folder edited), this rebuilds just the L2
layer against the already-persisted graph:

  1. drop the existing Document / DocSection nodes (and their edges)
  2. re-extract every document root, embed, rewrite the passage store
  3. add the fresh doc nodes/edges back
  4. re-bridge sections to the code symbols they mention
  5. save graph.json

The engine reloads automatically on the file's mtime change, so a reindex is
picked up without a restart.
"""

from __future__ import annotations

from pathlib import Path

from extractors.documents import DocumentExtractor
from graph import doc_store
from graph.merge import (
    _MAX_MENTIONS_PER_SECTION,
    _MAX_TARGETS_PER_NAME,
    _IDENT_RE,
    _codeish,
)
from graph.schema import KnowledgeGraph
from graph.store_networkx import NetworkXStore
from utils.docs import document_roots

_DOC_TYPES = {"Document", "DocSection"}
# nx node `type` strings a mention may target (mirrors merge._MENTION_TYPES).
_MENTION_TYPE_STR = {
    "Class",
    "Widget",
    "Function",
    "Method",
    "Enum",
    "Constant",
    "TypeAlias",
}


def reindex_documents(graph_path: str | Path, *, embed_docs: bool = True) -> dict:
    """Rebuild only the document layer over the persisted graph. Returns a summary."""
    store = NetworkXStore.open(graph_path)
    g = store.g

    old = [n for n, a in g.nodes(data=True) if a.get("type") in _DOC_TYPES]
    g.remove_nodes_from(old)

    roots = document_roots()
    ex = DocumentExtractor(roots).build()
    passages = ex.passages()

    if not passages:
        doc_store.clear()
        store.save()
        return {"documents": 0, "sections": 0, "mentions": 0, "errors": ex.errors}

    _embed(passages, embed_docs)
    doc_store.write_passages(passages)

    kg = KnowledgeGraph()
    kg.extend(ex.nodes(), ex.edges())
    store.add(kg)

    mentions = _bridge_nx(g, passages)
    store.save()

    return {
        "documents": sum(1 for n in ex.nodes() if n.type.value == "Document"),
        "sections": len(passages),
        "mentions": mentions,
        "errors": ex.errors,
    }


def _embed(passages: list, embed_docs: bool) -> None:
    if not embed_docs:
        return
    from query import embeddings as embed

    if not embed.is_available():
        return
    try:
        vecs = embed.embed_texts([p.text for p in passages])
    except Exception:  # noqa: BLE001 — degrade to BM25 silently
        return
    if vecs:
        for p, v in zip(passages, vecs):
            p.embedding = v


def _bridge_nx(g, passages: list) -> int:
    """Same mention-bridge as merge._bridge_docs_to_code, but over the live nx graph."""
    name_index: dict[str, list[str]] = {}
    for nid, a in g.nodes(data=True):
        name = a.get("name")
        if a.get("type") in _MENTION_TYPE_STR and name and _codeish(str(name)):
            name_index.setdefault(str(name).lower(), []).append(nid)
    if not name_index:
        return 0

    total = 0
    for p in passages:
        tokens = {t.lower() for t in _IDENT_RE.findall(p.text) if _codeish(t)}
        linked = 0
        for tok in tokens:
            for target in name_index.get(tok, [])[:_MAX_TARGETS_PER_NAME]:
                g.add_edge(
                    p.id, target,
                    key="MENTIONS", type="MENTIONS",
                    source="bridge", provenance="INFERRED",
                )
                total += 1
                linked += 1
            if linked >= _MAX_MENTIONS_PER_SECTION:
                break
    return total
