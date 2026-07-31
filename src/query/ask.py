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

# Shared investigation instructions (same for both audiences).
_INVESTIGATE = (
    "You have a code knowledge graph for navigation and tools to read the real "
    "source code.\n\n"
    "HOW TO INVESTIGATE (do this silently, using the tools):\n"
    "0. For cross-repo questions (which app does X, how apps relate, which is the "
    "backend of which), call repos_info and repo_relations first.\n"
    "1. search_symbols to find the relevant parts. Try SEVERAL terms and synonyms — "
    "for payment try Payment, Checkout, Order, Transaction, Pay, Billing; for booking "
    "try Book, Order, Reserve, Ticket. Use list_communities to find a feature area.\n"
    "2. To explain a flow or behaviour you MUST read the real code with read_source / "
    "read_file, and follow callers/callees so the explanation is accurate. Never guess.\n"
    "Only say the codebase lacks something after actually searching several terms and "
    "reading the relevant files.\n\n"
)

_ANSWER_BUSINESS = (
    "You are a friendly product analyst explaining to NON-TECHNICAL people (product, "
    "operations, business stakeholders).\n\n"
    + _INVESTIGATE
    + "HOW TO ANSWER (audience is NON-TECHNICAL — this matters most):\n"
    "- Answer in the user's language, in plain business terms. Avoid code jargon; if a "
    "technical term is unavoidable, explain it in a few words.\n"
    "- Start with a 1–2 sentence plain-language summary of what happens.\n"
    "- Then tell the flow as a numbered, step-by-step story: 'First the user…, then the "
    "system…, if X the app…'. Describe WHAT happens and WHY (the business rules and "
    "conditions), not the code syntax.\n"
    "- Call out the important business rules, validations, limits, and the behaviour on "
    "success vs failure / edge cases.\n"
    "- Keep code to a minimum. Prefer describing the logic over pasting code.\n"
    "- End with a short 'Where this lives:' line naming the app (repo) and file(s)."
)

_ANSWER_TECHNICAL = (
    "You are a senior engineer explaining to DEVELOPERS.\n\n"
    + _INVESTIGATE
    + "HOW TO ANSWER (audience is a DEVELOPER):\n"
    "- Answer in the user's language, precise and concise.\n"
    "- Explain the flow at the code level: name the concrete classes / methods / "
    "functions and the key conditions, and how control flows across them (callers → "
    "callees).\n"
    "- Include short, relevant code snippets when they clarify, each with its file path.\n"
    "- Cite repo and file path (with line numbers when known) for every key part.\n"
    "- Note important edge cases, error handling, side effects, and state changes.\n"
    "- Don't over-explain common concepts; assume software fluency."
)


def _system(mode: str) -> str:
    return _ANSWER_TECHNICAL if mode == "technical" else _ANSWER_BUSINESS


_LANG_NOTE = {
    "en": "\n\nAlways write your answer in English.",
    "vi": "\n\nAlways write your answer in Vietnamese (tiếng Việt).",
}


def _lang_note(lang: str) -> str:
    return _LANG_NOTE.get(lang, "")  # "auto"/unknown → keep the user's language


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
    mode: str = "business",
    lang: str = "auto",
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
        {
            "role": "system",
            "content": f"{_system(mode)}{_lang_note(lang)}\n\nIndexed repositories: {repos}.",
        },
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
