"""Hybrid document retrieval: BM25 (keyword) fused with embeddings (semantic).

Built once per engine instance from the passage store (graph/doc_store.py):

  * BM25 always runs — pure Python (rank_bm25), no external service.
  * Embeddings run only when passages carry vectors AND a provider is configured
    (query/embeddings.py); otherwise retrieval degrades gracefully to BM25-only.

Scores from each method are min-max normalised over the corpus and combined as a
weighted sum (ATHENA_BM25_WEIGHT / ATHENA_EMBED_WEIGHT), so neither dominates by
raw scale. `search()` returns ranked passages with a query-focused snippet.
"""

from __future__ import annotations

import re

import numpy as np

import config
from graph.doc_store import Passage
from query import embeddings as embed

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


def _norm(arr: np.ndarray) -> np.ndarray:
    """Min-max to [0,1]; flat arrays (all-equal) map to zeros (no signal)."""
    if arr.size == 0:
        return arr
    lo, hi = float(arr.min()), float(arr.max())
    if hi - lo < 1e-9:
        return np.zeros_like(arr)
    return (arr - lo) / (hi - lo)


def _snippet(text: str, query: str, width: int = 320) -> str:
    """A window of `text` centred on the first query-term hit, else the head."""
    text = " ".join(text.split())
    if len(text) <= width:
        return text
    terms = _tokenize(query)
    low = text.lower()
    pos = next((low.find(t) for t in terms if low.find(t) != -1), -1)
    if pos < 0:
        return text[:width].rstrip() + "…"
    start = max(0, pos - width // 3)
    end = min(len(text), start + width)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return prefix + text[start:end].strip() + suffix


class DocRetriever:
    def __init__(self, passages: list[Passage]):
        self.passages = passages
        self._bm25 = None
        self._emb: np.ndarray | None = None
        if passages:
            self._build()

    def _build(self) -> None:
        from rank_bm25 import BM25Okapi

        self._bm25 = BM25Okapi([_tokenize(p.text) for p in self.passages])
        vecs = [p.embedding for p in self.passages]
        if all(v is not None for v in vecs):
            m = np.asarray(vecs, dtype="float32")
            # L2-normalise rows so a dot product IS cosine similarity.
            norms = np.linalg.norm(m, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            self._emb = m / norms

    @property
    def count(self) -> int:
        return len(self.passages)

    @property
    def semantic(self) -> bool:
        """True when the semantic half is actually usable this query."""
        return self._emb is not None and embed.is_available()

    def search(self, query: str, limit: int = 8) -> list[dict]:
        if not self.passages or not query.strip():
            return []

        bm = np.asarray(self._bm25.get_scores(_tokenize(query)), dtype="float32")
        scores = _norm(bm) * config.float_env("ATHENA_BM25_WEIGHT", 0.5)
        used_semantic = False

        if self.semantic:
            try:
                qv = embed.embed_query(query)
            except Exception:  # API hiccup → silently fall back to BM25 only
                qv = None
            if qv is not None:
                q = np.asarray(qv, dtype="float32")
                n = np.linalg.norm(q) or 1.0
                cos = self._emb @ (q / n)
                scores = scores + _norm(cos) * config.float_env(
                    "ATHENA_EMBED_WEIGHT", 0.5
                )
                used_semantic = True

        top = np.argsort(-scores)[: max(limit, 1)]
        out = []
        for i in top:
            i = int(i)
            if scores[i] <= 0:
                continue
            p = self.passages[i]
            out.append(
                {
                    "id": p.id,
                    "doc_id": p.doc_id,
                    "document": p.doc_name,
                    "title": p.title,
                    "locator": p.locator,
                    "path": p.path,
                    "score": round(float(scores[i]), 4),
                    "snippet": _snippet(p.text, query),
                    "retrieval": "hybrid" if used_semantic else "bm25",
                }
            )
        return out
