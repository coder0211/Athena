"""Workspace layer — human-curated metadata about repos and how they relate.

Separate from sources.yaml (which only says *what to clone*). `workspace.yaml`
holds per-repo descriptions + typed relations between repos, e.g. "booking
calls_api_of payments-service". This overlays onto the knowledge graph so
queries and Q&A can reason across repositories.
"""

from __future__ import annotations

from pathlib import Path

import yaml

from config import PROJECT_ROOT

WORKSPACE_PATH = PROJECT_ROOT / "workspace.yaml"

# Controlled vocabularies (kept small + extensible; the UI offers these).
RELATION_TYPES = [
    "depends_on",
    "backend_of",
    "frontend_of",
    "calls_api_of",
    "shares_code_with",
    "forked_from",
    "related_to",
]
REPO_ROLES = ["mobile", "frontend", "backend", "service", "library", "infra", "other"]


def load_workspace() -> dict:
    """Return {'repos': {name: {...}}, 'docs': {id: {...}}, 'relations': [...]}.

    `repos`/`docs` entries may carry canvas positions (x, y) and curated metadata;
    `relations` reference node ids ('repo:<name>' or 'doc:<id>')."""
    if not WORKSPACE_PATH.exists():
        return {"repos": {}, "docs": {}, "relations": []}
    data = yaml.safe_load(WORKSPACE_PATH.read_text()) or {}
    data.setdefault("repos", {})
    data.setdefault("docs", {})
    data.setdefault("relations", [])
    return data


def save_workspace(data: dict) -> None:
    clean = {
        "repos": data.get("repos", {}) or {},
        "docs": data.get("docs", {}) or {},
        "relations": data.get("relations", []) or [],
    }
    WORKSPACE_PATH.write_text(
        yaml.safe_dump(clean, sort_keys=False, allow_unicode=True)
    )
