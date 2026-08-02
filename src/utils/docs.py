"""docs.yaml loader + document-root resolution.

Two ways documents enter Athena (both feed the same scan):
  1. folders listed in docs.yaml — external dirs the user points at, e.g.
        folders:
          - ./product-specs
          - /Users/me/Drive/specs
  2. files uploaded through the dashboard, saved under the docs root (.docs/).

`document_roots()` returns every existing path to scan; the extractor walks them.
"""

from __future__ import annotations

from pathlib import Path

import yaml

import config


def load_docs_config() -> dict:
    """{'folders': [...]} from docs.yaml (empty if the file is absent)."""
    path = config.docs_config_path()
    if not path.exists():
        return {"folders": []}
    data = yaml.safe_load(path.read_text()) or {}
    folders = [str(f).strip() for f in data.get("folders", []) if str(f).strip()]
    return {"folders": folders}


def save_docs_config(folders: list[str]) -> None:
    cfg = {"folders": [f.strip() for f in folders if f and f.strip()]}
    config.docs_config_path().write_text(yaml.safe_dump(cfg, sort_keys=False))


def _resolve(folder: str) -> Path:
    p = Path(folder).expanduser()
    return p if p.is_absolute() else config.PROJECT_ROOT / p


def document_roots() -> list[Path]:
    """Every existing root to scan: the upload dir + each configured folder."""
    roots: list[Path] = []
    up = config.docs_root()
    if up.exists():
        roots.append(up)
    for folder in load_docs_config()["folders"]:
        r = _resolve(folder)
        if r.exists() and r.resolve() not in {x.resolve() for x in roots}:
            roots.append(r)
    return roots


def has_documents() -> bool:
    """True if any root exists (so the pipeline knows whether to run docs)."""
    return bool(document_roots()) or config.docs_config_path().exists()
