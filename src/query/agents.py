"""Agents — named, reusable bundles over the personas + scope + tools + model.

Where a *persona* decides HOW an answer reads (voice + shape), an *agent* decides
WHO is answering and WHAT it may use:

    agent = base persona  (voice/shape, reused from personas.py)
          + extra instruction   (optional, agent-specific)
          + knowledge scope      (which repos / documents it looks at)
          + allowed toolset      (which built-in graph tools + which MCP servers)
          + model settings       (model / temperature / max reasoning steps)

Selecting an agent applies that whole configuration at once, instead of the user
re-picking a persona, scoping repos, and choosing tools on every question.

Agents are stored in agents.yaml (beside personas.yaml / sources.yaml),
overridable via ATHENA_AGENTS. There are no built-in agents — the library starts
empty and users create their own (hand-written or from the dashboard). Nothing
here talks to the LLM; ask.py consumes `effective()` to drive one answer.
"""

from __future__ import annotations

import re
import time

import yaml

import config
from query import personas

# --- schema ---------------------------------------------------------------
# Plain string fields and their defaulting is handled in _clean(); the nested
# scope/tools/params blocks are normalised explicitly so a hand-edited YAML with
# missing or mistyped keys still resolves to a safe, predictable shape.
_STR_FIELDS = ("id", "label", "description", "persona", "instruction", "model")


def _slug(text: str) -> str:
    """Kebab-case id from a label. 'Security Auditor' -> 'security-auditor'."""
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return s[:48]


def _str_list(v) -> list[str]:
    return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []


def _clean(entry: dict) -> dict:
    """Keep only known agent fields from a raw store/API dict, coercing types and
    normalising the nested scope/tools/params blocks into a stable shape."""
    out: dict = {}
    for k in _STR_FIELDS:
        if entry.get(k) is not None:
            out[k] = str(entry[k]).strip()

    scope = entry.get("scope") or {}
    out["scope"] = {
        "repos": _str_list(scope.get("repos")),
        "docs": _str_list(scope.get("docs")),
    }

    tools = entry.get("tools") or {}
    out["tools"] = {
        # builtin: [] means "all built-in tools" (empty allow-list = no restriction).
        "builtin": _str_list(tools.get("builtin")),
        # mcp_servers: [] means "no external MCP tools" (opt-in per agent).
        "mcp_servers": _str_list(tools.get("mcp_servers")),
    }

    # Model overrides — each optional; absent/blank means "use the global default".
    if entry.get("model"):
        out["model"] = str(entry["model"]).strip()
    temp = entry.get("temperature")
    if temp is not None and str(temp).strip() != "":
        try:
            out["temperature"] = float(temp)
        except (TypeError, ValueError):
            pass
    steps = entry.get("max_steps")
    if steps is not None and str(steps).strip() != "":
        try:
            out["max_steps"] = max(1, int(steps))
        except (TypeError, ValueError):
            pass
    return out


# --- store (agents.yaml) --------------------------------------------------

def _load_store() -> list[dict]:
    path = config.agents_path()
    if not path.exists():
        return []
    try:
        data = yaml.safe_load(path.read_text()) or {}
    except Exception:
        return []
    return data.get("agents", []) or []


def _save_store(agents: list[dict]) -> None:
    config.ensure_config_dir()
    config.agents_path().write_text(
        yaml.safe_dump({"agents": agents}, sort_keys=False, allow_unicode=True)
    )


# --- read API -------------------------------------------------------------

def list_agents() -> list[dict]:
    """Every stored agent, normalised. Each dict carries id/label/description,
    a base `persona` id, optional `instruction`, `scope`, `tools`, and model
    overrides. Order preserved from the file (creation order)."""
    out: list[dict] = []
    seen: set[str] = set()
    for entry in _load_store():
        clean = _clean(entry)
        aid = _slug(clean.get("id") or clean.get("label", ""))
        if not aid or aid in seen:
            continue
        seen.add(aid)
        clean["id"] = aid
        clean.setdefault("persona", personas.DEFAULT_PERSONA)
        out.append(clean)
    return out


def get(agent_id: str | None) -> dict | None:
    """An agent by id, or None when unknown/empty (callers fall back to a plain
    persona answer when there's no agent)."""
    if not agent_id:
        return None
    for a in list_agents():
        if a["id"] == agent_id:
            return a
    return None


def exists(agent_id: str) -> bool:
    return get(agent_id) is not None


# --- write API ------------------------------------------------------------

def upsert(entry: dict) -> dict:
    """Create or update an agent. Requires a label; the base persona must exist
    (falls back to the default if the given one is unknown). Returns the saved
    agent."""
    clean = _clean(entry)
    label = clean.get("label", "")
    if not label:
        raise ValueError("An agent needs a label.")
    aid = _slug(clean.get("id") or label)
    if not aid:
        raise ValueError("An agent needs a name with at least one letter or digit.")
    persona_id = clean.get("persona") or personas.DEFAULT_PERSONA
    if not personas.exists(persona_id):
        persona_id = personas.DEFAULT_PERSONA
    clean["id"] = aid
    clean["persona"] = persona_id
    clean.setdefault("created_at", int(time.time()))

    store = [e for e in _load_store() if _slug(e.get("id") or e.get("label", "")) != aid]
    store.append(clean)
    _save_store(store)
    return get(aid)


def delete(agent_id: str) -> None:
    """Remove an agent by id. Raises KeyError if there's nothing to remove."""
    store = _load_store()
    kept = [e for e in store if _slug(e.get("id") or e.get("label", "")) != agent_id]
    if len(kept) == len(store):
        raise KeyError(agent_id)
    _save_store(kept)


# --- resolve to an effective run configuration ----------------------------

def effective(agent: dict | None, request_scope: dict | None) -> dict:
    """Fold an agent + the request's ad-hoc scope into one config the answer loop
    consumes. Returns a dict:

        {
          "persona": <persona id>,          # voice/shape
          "instruction": <str>,             # extra agent instruction ("" if none)
          "scope": {repos, docs, symbols, tools},  # merged (agent ∪ request)
          "builtin": [names] | None,        # allow-list; None = all built-in tools
          "mcp_servers": [names],           # MCP servers this agent may use ([] = none)
          "model": <str> | None,
          "temperature": <float> | None,
          "max_steps": <int> | None,
        }

    Merge rule: the agent supplies the baseline scope (repos/docs); anything the
    user pins ad-hoc for this one question (an @mention scope) is unioned on top,
    so a per-question focus can narrow further without losing the agent's frame.
    """
    req = request_scope or {}

    def _union(a, b):
        out, seen = [], set()
        for x in list(a or []) + list(b or []):
            key = x.get("name") if isinstance(x, dict) else x
            if key and key not in seen:
                seen.add(key)
                out.append(x)
        return out

    if not agent:
        return {
            "persona": None,
            "instruction": "",
            "scope": req,
            "builtin": None,
            "mcp_servers": None,  # None = keep legacy behaviour (all MCP tools)
            "model": None,
            "temperature": None,
            "max_steps": None,
        }

    a_scope = agent.get("scope") or {}
    scope = {
        "repos": _union(a_scope.get("repos"), req.get("repos")),
        "docs": _union(a_scope.get("docs"), req.get("docs")),
        "symbols": req.get("symbols") or [],
        "tools": req.get("tools") or [],
    }
    tools = agent.get("tools") or {}
    builtin = tools.get("builtin") or []
    return {
        "persona": agent.get("persona") or personas.DEFAULT_PERSONA,
        "instruction": agent.get("instruction") or "",
        "scope": scope,
        "builtin": builtin or None,  # empty allow-list = no restriction
        "mcp_servers": tools.get("mcp_servers") or [],  # [] = no external tools
        "model": agent.get("model") or None,
        "temperature": agent.get("temperature"),
        "max_steps": agent.get("max_steps"),
    }
