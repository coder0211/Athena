"""Natural-language Q&A over the knowledge graph (L5), via the OpenAI API.

Runs an agentic function-calling loop: the model plans, calls the GraphQuery
tools, and synthesises an answer. Requires OPENAI_API_KEY. If the key is absent,
`answer()` returns available=False so callers can fall back to structured search.
"""

from __future__ import annotations

import json
import os

import config
from query.engine import GraphQuery

MODEL = os.environ.get("ATHENA_ASK_MODEL", "gpt-4o")

SYSTEM = (
    "You answer questions about repositories."
    "You have a code knowledge graph for navigation AND tools to "
    "read the real source code.\n\n"
    "Workflow:\n"
    "0. For cross-repo questions (which repo does X, how do repos relate, which is "
    "the backend of which), call repos_info and repo_relations first.\n"
    "1. search_symbols to find relevant symbols. Node ids look like "
    "'cg:<repo>:<kind>:<hash>'. Try SEVERAL terms and synonyms — for a payment flow "
    "try Payment, Checkout, Order, Transaction, Pay, Billing; for booking try Book, "
    "Order, Reserve, Ticket. Also list_communities / community_members to find a "
    "feature area.\n"
    "2. For questions about LOGIC, FLOW, or 'how does X work', you MUST read the "
    "actual code with read_source(node_id) (or read_file(repo, path)). Then follow "
    "callees / callers and read those too, to trace the flow across methods.\n"
    "3. Answer in the user's language, concisely, citing concrete symbols, repos, "
    "and file paths. Explain the flow step by step from the code you read.\n"
    "Only say the codebase lacks something after actually searching multiple terms "
    "and reading the relevant files."
)

# Tool specs — each maps to a GraphQuery method of the same name.
_TOOL_SPECS = [
    (
        "overview",
        "High-level stats of the whole graph: totals, node types, repos, biggest concept communities.",
        {"type": "object", "properties": {}},
    ),
    (
        "search_symbols",
        "Find symbols by name substring. Filter by repo and type (Class|Method|Function|File|Enum|Constant|Community).",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer"},
                "repo": {"type": "string"},
                "type": {"type": "string"},
            },
            "required": ["query"],
        },
    ),
    (
        "get_symbol",
        "Full detail for a symbol id, including relation-type breakdown.",
        {
            "type": "object",
            "properties": {"node_id": {"type": "string"}},
            "required": ["node_id"],
        },
    ),
    (
        "callers",
        "Symbols that call/reference this one (who uses it).",
        {
            "type": "object",
            "properties": {"node_id": {"type": "string"}, "limit": {"type": "integer"}},
            "required": ["node_id"],
        },
    ),
    (
        "callees",
        "Symbols this one calls/references (what it depends on).",
        {
            "type": "object",
            "properties": {"node_id": {"type": "string"}, "limit": {"type": "integer"}},
            "required": ["node_id"],
        },
    ),
    (
        "impact",
        "Change blast radius: symbols transitively depending on this one, up to `depth` hops.",
        {
            "type": "object",
            "properties": {
                "node_id": {"type": "string"},
                "depth": {"type": "integer"},
                "limit": {"type": "integer"},
            },
            "required": ["node_id"],
        },
    ),
    (
        "find_path",
        "Shortest relationship path between two symbol ids.",
        {
            "type": "object",
            "properties": {
                "source_id": {"type": "string"},
                "target_id": {"type": "string"},
                "max_len": {"type": "integer"},
            },
            "required": ["source_id", "target_id"],
        },
    ),
    (
        "list_communities",
        "List concept communities (Leiden clusters), largest first; optional name filter.",
        {
            "type": "object",
            "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}},
        },
    ),
    (
        "community_members",
        "Members of a concept community (by id or name substring).",
        {
            "type": "object",
            "properties": {
                "community": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["community"],
        },
    ),
    (
        "repos_info",
        "List each repository with its curated description, role, tags and code-node count.",
        {"type": "object", "properties": {}},
    ),
    (
        "repo_relations",
        "List declared typed relations between repositories (e.g. calls_api_of, backend_of).",
        {"type": "object", "properties": {}},
    ),
    (
        "read_source",
        "Read the ACTUAL source code of a symbol (by node id). Use this to explain logic/flows.",
        {
            "type": "object",
            "properties": {
                "node_id": {"type": "string"},
                "before": {"type": "integer"},
                "after": {"type": "integer"},
            },
            "required": ["node_id"],
        },
    ),
    (
        "read_file",
        "Read a slice of a source file under a repo (repo = one of the indexed repo names; path relative to repo root).",
        {
            "type": "object",
            "properties": {
                "repo": {"type": "string"},
                "path": {"type": "string"},
                "start": {"type": "integer"},
                "end": {"type": "integer"},
            },
            "required": ["repo", "path"],
        },
    ),
]

_TOOLS = [
    {
        "type": "function",
        "function": {"name": name, "description": desc, "parameters": params},
    }
    for name, desc, params in _TOOL_SPECS
]


def is_available() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY"))


def _scope_note(scope: dict | None) -> str:
    """Turn a mention scope ({repos:[], symbols:[...]}) into a system-style hint."""
    if not scope:
        return ""
    repos = [r for r in (scope.get("repos") or []) if r]
    syms = [s for s in (scope.get("symbols") or []) if s]
    parts = []
    if repos:
        parts.append(
            "Restrict analysis to these repositories ONLY: "
            + ", ".join(repos)
            + ". Always pass repo=<name> to search_symbols."
        )
    if syms:
        names = [s.get("name") if isinstance(s, dict) else str(s) for s in syms]
        parts.append(
            "Focus on these symbols: "
            + ", ".join(n for n in names if n)
            + ". Search for and read_source them first."
        )
    return ("\n\n[SCOPE — narrowed by the user]\n" + "\n".join(parts)) if parts else ""


def answer(
    question: str,
    engine: GraphQuery,
    history: list | None = None,
    scope: dict | None = None,
) -> dict:
    """Answer a NL question with optional prior conversation `history`
    ([{role, content}]) and a mention `scope` ({repos, symbols}) that narrows
    the search. Returns {available, answer, steps}."""
    if not is_available():
        return {
            "available": False,
            "reason": "OPENAI_API_KEY not set — natural-language Q&A is disabled.",
        }

    from openai import (
        OpenAI,
    )  # imported lazily so the API/server run without the SDK/key

    client = OpenAI()
    repos = ", ".join(engine.repos()) or "(none)"
    messages = [
        {"role": "system", "content": f"{SYSTEM}\n\nIndexed repositories: {repos}."},
    ]
    # carry prior turns (text only), capped so context/token use stays bounded
    for m in (history or [])[-12:]:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": str(m["content"])})
    messages.append({"role": "user", "content": question + _scope_note(scope)})
    steps: list[dict] = []
    max_steps = config.int_env("ATHENA_MAX_STEPS", 8)

    for _ in range(max_steps):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                tools=_TOOLS,
                tool_choice="auto",
            )
        except Exception as e:  # rate limits / API errors → clean message, no 500
            name = type(e).__name__
            if "RateLimit" in name:
                hint = (
                    "OpenAI rate limit hit (tokens/min). Wait a few seconds and retry, "
                    "or set a lighter model like gpt-4o-mini in .env (ATHENA_ASK_MODEL)."
                )
            else:
                hint = f"OpenAI API error: {name}: {e}"
            return {"available": True, "answer": hint, "error": name, "steps": steps}
        msg = resp.choices[0].message

        if not msg.tool_calls:
            return {"available": True, "answer": msg.content or "", "steps": steps}

        messages.append(msg)  # assistant turn carrying the tool_calls
        for call in msg.tool_calls:
            method = getattr(engine, call.function.name, None)
            try:
                args = json.loads(call.function.arguments or "{}")
                output = (
                    method(**args)
                    if method
                    else {"error": f"unknown tool {call.function.name}"}
                )
            except Exception as e:  # surface tool errors to the model, don't crash
                output = {"error": f"{type(e).__name__}: {e}"}
            steps.append(
                {
                    "tool": call.function.name,
                    "input": args if isinstance(args, dict) else {},
                }
            )
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(output, default=str),
                }
            )

    return {
        "available": True,
        "answer": "(stopped: too many reasoning steps)",
        "steps": steps,
    }
