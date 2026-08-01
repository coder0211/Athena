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

# Read at CALL time (not import), so values from .env — which config.load_env()
# loads at app startup, after this module is imported — are actually picked up.
def _model() -> str:
    return os.environ.get("ATHENA_ASK_MODEL", "gpt-4o")


# Generation params (env-overridable). A lower temperature makes the tool-using
# loop converge faster (fewer wandering round-trips); max_tokens caps the final
# answer; parallel_tool_calls lets the model batch lookups into one turn.
def _gen_params() -> dict:
    return {
        "temperature": config.float_env("ATHENA_TEMPERATURE", 0.3),
        "max_tokens": config.int_env("ATHENA_MAX_TOKENS", 2048),
        "parallel_tool_calls": True,
    }

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
    "HOW TO REASON (internal chain-of-thought — think step by step, but never print "
    "this scratchpad):\n"
    "- Restate the question as the concrete thing to find, and name any assumption you "
    "are making.\n"
    "- Work iteratively (plan → act → observe → refine): form a hypothesis about where "
    "the answer lives, use tools to test it, read what comes back, and revise the "
    "hypothesis until the evidence is solid. Prefer one more tool call over a guess.\n"
    "- Decompose non-trivial questions into sub-questions and resolve each from the code "
    "before you compose the overall answer.\n"
    "- Be efficient with round-trips: batch INDEPENDENT lookups into a single turn "
    "(e.g. issue several search_symbols calls at once, or search different repos "
    "together) instead of one tool per turn, and go straight from finding a symbol to "
    "read_source. Fewer round-trips means a faster answer.\n"
    "- VERIFY before answering: every statement you make must trace to code you actually "
    "read; if a claim is not backed by what you saw, verify it or drop it.\n"
    "- Then output ONLY the finished, reader-facing answer — do not reveal these steps, "
    "your hypotheses, or your tool scratchpad.\n\n"
)

# Appended to both audiences: push for one thorough, self-contained answer so the
# user rarely has to come back with a follow-up.
_COMPLETENESS = (
    "\n\nBE COMPLETE — aim to fully resolve the question in a single answer so the "
    "reader rarely needs a follow-up:\n"
    "- Do NOT reply with a clarifying question. If the request is ambiguous, choose the "
    "most likely interpretation, state that assumption in one short line, and answer it "
    "in full; if two readings are both plausible, cover both.\n"
    "- Give the whole picture end to end — the full flow, the main branches, and what "
    "happens on success, on failure, and in the important edge cases — not just the "
    "happy path.\n"
    "- Proactively answer the natural next questions: what triggers it, what it depends "
    "on, what can go wrong, and where to look next.\n"
    "- Prefer a thorough, self-contained answer over a terse one, but no filler: use "
    "headings, numbered steps and bullets so a longer answer stays easy to scan.\n"
    "- Ask the user for something back ONLY as a last resort, when you genuinely cannot "
    "proceed without a specific detail that only they can provide."
)

# Shared persona/identity (prepended to both audiences).
_IDENTITY = (
    "Your name is Athena — an assistant that reads a project's real source code (via a "
    "code knowledge graph) to explain how the product works. Speak as Athena in the "
    "first person. Introduce yourself as Athena when you greet the user or when they ask "
    "who/what you are; otherwise just answer, without repeating your name in every "
    "message.\n\n"
)

_ANSWER_BUSINESS = (
    _IDENTITY
    + "You are a friendly product analyst explaining to NON-TECHNICAL people (product, "
    "operations, business stakeholders).\n\n"
    + _INVESTIGATE
    + "HOW TO ANSWER (audience is NON-TECHNICAL — this matters most):\n"
    "- Answer in the user's language, in plain business terms. Avoid code jargon; if a "
    "technical term is unavoidable, explain it in a few words.\n"
    "- NEVER show raw code identifiers in the body — no node IDs, class/function names, "
    "variable names, or qualified names (e.g. not 'PaymentService.charge' but 'the step "
    "that charges the card'). Translate every internal name into the product concept a "
    "business reader recognises (customer, order, refund, ticket).\n"
    "- Start with a 1–2 sentence plain-language summary of what happens.\n"
    "- Name who and what is involved, in plain terms — the customer, staff/admin, the app "
    "itself, and any outside service it relies on (e.g. the payment provider, email/SMS) — "
    "so the reader knows who does what.\n"
    "- Then tell the flow as a numbered, step-by-step story: 'First the user…, then the "
    "system…, if X the app…'. Describe WHAT happens and WHY (the business rules and "
    "conditions), not the code syntax.\n"
    "- At each key step, say what the customer actually sees or receives (a screen, a "
    "message, an email/SMS, a status change) — and what they experience when something "
    "goes wrong.\n"
    "- Call out the important business rules, validations, limits, and the behaviour on "
    "success vs failure / edge cases.\n"
    "- Surface concrete values when the code contains them: amounts, fees, limits, "
    "hold/expiry times, retries, and whether a step is instant or takes time (e.g. 'the "
    "seat is held for 15 minutes', 'a refund can take 3–5 days').\n"
    "- Where a rule or outcome is subtle, add a short concrete example ('e.g. if the card "
    "is declined, the customer sees … and the order stays unpaid') — it lands better than "
    "an abstract rule.\n"
    "- Be clear about the limits of what the code shows: if a rule, price, or policy is "
    "configured elsewhere or decided outside the code, say so instead of guessing.\n"
    "- Keep code to a minimum. Prefer describing the logic over pasting code.\n"
    "- Stay complete but concise for a non-technical reader: lead with the answer, keep "
    "steps tight, and put secondary detail in brief bullets rather than long prose.\n"
    "- End with a short 'Where this lives:' line naming the app (and screen/feature) in "
    "plain terms; a file path may follow but keep it brief and secondary."
    + _COMPLETENESS
)

_ANSWER_TECHNICAL = (
    _IDENTITY
    + "You are a senior engineer explaining to DEVELOPERS.\n\n"
    + _INVESTIGATE
    + "HOW TO ANSWER (audience is a DEVELOPER):\n"
    "- Answer in the user's language, precise and concise.\n"
    "- Explain the flow at the code level: name the concrete classes / methods / "
    "functions and the key conditions, and how control flows across them (callers → "
    "callees).\n"
    "- Include short, relevant code snippets when they clarify, each with its file path.\n"
    "- Cite repo and file path (with line numbers when known) for every key part.\n"
    "- Note important edge cases, error handling, side effects, and state changes.\n"
    "- Don't over-explain common concepts; assume software fluency." + _COMPLETENESS
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


def _init_messages(
    question: str,
    engine: GraphQuery,
    history: list | None,
    scope: dict | None,
    mode: str,
    lang: str,
) -> list[dict]:
    """Build the initial message list (system + capped history + user turn)."""
    repos = ", ".join(engine.repos()) or "(none)"
    messages: list[dict] = [
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
    return messages


def _run_tool(engine: GraphQuery, name: str, arguments: str, cache: dict) -> tuple:
    """Execute one tool call, memoized within a single request so repeated
    (name, args) pairs don't recompute. Returns (parsed_args, output)."""
    key = (name, arguments or "")
    if key in cache:
        return cache[key]
    method = getattr(engine, name, None)
    try:
        args = json.loads(arguments or "{}")
        output = method(**args) if method else {"error": f"unknown tool {name}"}
    except Exception as e:  # surface tool errors to the model, don't crash
        args, output = {}, {"error": f"{type(e).__name__}: {e}"}
    result = (args if isinstance(args, dict) else {}, output)
    cache[key] = result
    return result


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
    messages = _init_messages(question, engine, history, scope, mode, lang)
    steps: list[dict] = []
    tool_cache: dict = {}
    max_steps = config.int_env("ATHENA_MAX_STEPS", 8)

    for _ in range(max_steps):
        try:
            resp = client.chat.completions.create(
                model=_model(),
                messages=messages,
                tools=_TOOLS,
                tool_choice="auto",
                **_gen_params(),
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
            args, output = _run_tool(
                engine, call.function.name, call.function.arguments, tool_cache
            )
            steps.append({"tool": call.function.name, "input": args})
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


def answer_stream(
    question: str,
    engine: GraphQuery,
    history: list | None = None,
    scope: dict | None = None,
    mode: str = "business",
    lang: str = "auto",
):
    """Streaming variant of answer(). Yields event dicts as the answer is
    produced; the agentic tool loop runs internally and only the final answer
    text is streamed token by token. Events:
      {'unavailable': reason} | {'delta': text} | {'tool': name} |
      {'steps': [...], 'done': True} | {'error': msg}
    """
    if not is_available():
        yield {
            "unavailable": "OPENAI_API_KEY not set — natural-language Q&A is disabled."
        }
        return

    from openai import OpenAI  # lazy import (SDK/key optional for the rest of the app)

    client = OpenAI()
    messages = _init_messages(question, engine, history, scope, mode, lang)
    steps: list[dict] = []
    tool_cache: dict = {}
    max_steps = config.int_env("ATHENA_MAX_STEPS", 8)

    for _ in range(max_steps):
        try:
            stream = client.chat.completions.create(
                model=_model(),
                messages=messages,
                tools=_TOOLS,
                tool_choice="auto",
                stream=True,
                **_gen_params(),
            )
        except Exception as e:  # rate limits / API errors → clean message, no crash
            name = type(e).__name__
            if "RateLimit" in name:
                hint = (
                    "OpenAI rate limit hit (tokens/min). Wait a few seconds and retry, "
                    "or set a lighter model like gpt-4o-mini in .env (ATHENA_ASK_MODEL)."
                )
            else:
                hint = f"OpenAI API error: {name}: {e}"
            yield {"delta": hint}
            yield {"steps": steps, "done": True}
            return

        content_parts: list[str] = []
        tool_calls: dict[int, dict] = {}  # index → {id, name, args}
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if getattr(delta, "content", None):
                content_parts.append(delta.content)
                yield {"delta": delta.content}
            for tc in getattr(delta, "tool_calls", None) or []:
                slot = tool_calls.setdefault(
                    tc.index, {"id": None, "name": "", "args": ""}
                )
                if tc.id:
                    slot["id"] = tc.id
                if tc.function and tc.function.name:
                    slot["name"] += tc.function.name
                if tc.function and tc.function.arguments:
                    slot["args"] += tc.function.arguments

        if not tool_calls:  # no tools this round → the final answer is complete
            yield {"steps": steps, "done": True}
            return

        # Replay the assistant turn (with its tool_calls) so the next round has context.
        ordered = [tool_calls[i] for i in sorted(tool_calls)]
        messages.append(
            {
                "role": "assistant",
                "content": "".join(content_parts) or None,
                "tool_calls": [
                    {
                        "id": s["id"],
                        "type": "function",
                        "function": {"name": s["name"], "arguments": s["args"]},
                    }
                    for s in ordered
                ],
            }
        )
        for s in ordered:
            args, output = _run_tool(engine, s["name"], s["args"], tool_cache)
            steps.append({"tool": s["name"], "input": args})
            yield {"tool": s["name"]}
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": s["id"],
                    "content": json.dumps(output, default=str),
                }
            )

    yield {"delta": "(stopped: too many reasoning steps)"}
    yield {"steps": steps, "done": True}
