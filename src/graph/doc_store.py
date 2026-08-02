"""Sidecar store for document passages (and their embeddings).

The unified `graph.json` only holds Document / DocSection *metadata* (title,
locator, byte size) so it stays lean. The actual passage TEXT — which can be
large — plus any embedding vector live here, keyed by the DocSection node id, in
a JSONL file beside the graph:

    .knowledge/docs/passages.jsonl   one JSON object per line:
        {id, doc_id, doc_name, path, title, locator, text, embedding?}

The engine loads this once at startup to build the BM25 + embedding indexes
(see query/retrieval.py). Rebuilding the graph rewrites this file wholesale, so
the two never drift apart.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, Iterator

import config

_PASSAGES = "passages.jsonl"


@dataclass(slots=True)
class Passage:
    id: str                 # == the DocSection node id
    doc_id: str             # the parent Document node id
    doc_name: str           # file name, for display
    path: str               # source path (for display / opening)
    title: str              # section title (heading / "p3" / "Sheet1")
    locator: str            # human locator: "page 3", "Sheet 'Fees' rows 1-50"
    text: str               # the retrievable body text
    embedding: list[float] | None = field(default=None)


def passages_path() -> Path:
    return config.docs_store_dir() / _PASSAGES


def write_passages(passages: Iterable[Passage]) -> int:
    """Overwrite the passage store with `passages`. Returns the count written."""
    out = passages_path()
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out.open("w", encoding="utf-8") as f:
        for p in passages:
            f.write(json.dumps(asdict(p), ensure_ascii=False) + "\n")
            n += 1
    return n


def read_passages(path: str | Path | None = None) -> Iterator[Passage]:
    """Stream stored passages (empty if the store doesn't exist yet)."""
    p = Path(path) if path else passages_path()
    if not p.exists():
        return
    with p.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            yield Passage(**rec)


def clear() -> None:
    """Remove the passage store (used when docs are disabled / reset)."""
    passages_path().unlink(missing_ok=True)
