"""Tiny .env loader + shared config paths.

Loads KEY=VALUE lines from the project-root .env into os.environ (without
overriding values already set in the real environment). Kept dependency-free so
the pipeline and MCP server don't require python-dotenv.
"""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_env(path: str | Path | None = None) -> None:
    """Load a .env file into os.environ (real env vars win over the file)."""
    env_path = Path(path) if path else PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def graph_path() -> Path:
    """Resolved path to the knowledge graph (ATHENA_GRAPH or the default)."""
    raw = os.environ.get("ATHENA_GRAPH")
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else PROJECT_ROOT / p
    return PROJECT_ROOT / ".knowledge" / "graph.json"


def int_env(name: str, default: int) -> int:
    """Read an int env var at call time, falling back to `default` if unset/invalid."""
    try:
        return int(os.environ[name])
    except (KeyError, ValueError, TypeError):
        return default


def float_env(name: str, default: float) -> float:
    """Read a float env var at call time, falling back to `default` if unset/invalid."""
    try:
        return float(os.environ[name])
    except (KeyError, ValueError, TypeError):
        return default
