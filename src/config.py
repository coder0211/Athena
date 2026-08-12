"""Tiny .env loader + shared config paths.

Loads KEY=VALUE lines from the project-root .env into os.environ (without
overriding values already set in the real environment). Kept dependency-free so
the pipeline and MCP server don't require python-dotenv.
"""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
# System config files (sources/workspace/docs/personas .yaml + mcp_servers.json)
# live here so the project root stays clean; Docker bind-mounts the whole folder.
CONFIG_DIR = PROJECT_ROOT / "config"


def ensure_config_dir() -> Path:
    """The config directory, created on demand so a first write never fails."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    return CONFIG_DIR


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


def _resolve(raw: str | None, default: Path) -> Path:
    """Resolve an env-configured path, allowing it to be relative to the project."""
    if not raw:
        return default
    p = Path(raw)
    return p if p.is_absolute() else PROJECT_ROOT / p


def docs_config_path() -> Path:
    """config/docs.yaml — folders to scan for documents (ATHENA_DOCS_CONFIG)."""
    return _resolve(os.environ.get("ATHENA_DOCS_CONFIG"), CONFIG_DIR / "docs.yaml")


def personas_path() -> Path:
    """config/personas.yaml — user-defined answer 'types' (ATHENA_PERSONAS). Holds
    only custom personas / built-in overrides; the two built-ins are seeded in
    code."""
    return _resolve(os.environ.get("ATHENA_PERSONAS"), CONFIG_DIR / "personas.yaml")


def agents_path() -> Path:
    """config/agents.yaml — user-defined agents (ATHENA_AGENTS). An agent bundles a
    base persona, a knowledge scope (repos/docs), an allowed toolset, and model
    settings into one named, reusable configuration."""
    return _resolve(os.environ.get("ATHENA_AGENTS"), CONFIG_DIR / "agents.yaml")


def workflows_path() -> Path:
    """config/workflows.yaml — user-defined workflows (ATHENA_WORKFLOWS). A workflow
    wires saved agents into a directed graph (nodes = agents, edges = execution
    order); running it feeds each step's answer into its successors."""
    return _resolve(os.environ.get("ATHENA_WORKFLOWS"), CONFIG_DIR / "workflows.yaml")


def docs_root() -> Path:
    """Root under which dashboard uploads are stored + scanned (ATHENA_DOCS)."""
    return _resolve(os.environ.get("ATHENA_DOCS"), PROJECT_ROOT / ".docs")


def docs_store_dir() -> Path:
    """Where extracted passages + embeddings live, beside the graph so a rebuild
    replaces both together (ATHENA_DOCS_STORE)."""
    return _resolve(
        os.environ.get("ATHENA_DOCS_STORE"), PROJECT_ROOT / ".knowledge" / "docs"
    )


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


def bool_env(name: str, default: bool) -> bool:
    """Read a bool env var at call time. True: 1/true/yes/on; False: 0/false/no/off
    (case-insensitive). Unset or unrecognised → `default`."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    val = raw.strip().lower()
    if val in ("1", "true", "yes", "on"):
        return True
    if val in ("0", "false", "no", "off"):
        return False
    return default
