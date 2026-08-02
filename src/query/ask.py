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
    return os.environ.get("ATHENA_ASK_MODEL", "gpt-4.1-nano")


def _client():
    """OpenAI-compatible client. Works with any provider that speaks the OpenAI
    Chat Completions API — OpenAI, a local server (Ollama, vLLM, LM Studio),
    OpenRouter, Together, etc. — by pointing ATHENA_API_BASE at its endpoint.
      ATHENA_API_BASE / OPENAI_BASE_URL  base URL (unset → OpenAI's default)
      ATHENA_API_KEY   / OPENAI_API_KEY  API key   (a local endpoint may need none)
    """
    from openai import OpenAI  # imported lazily so the rest of the app runs without it

    kwargs: dict = {}
    base = os.environ.get("ATHENA_API_BASE") or os.environ.get("OPENAI_BASE_URL")
    if base:
        kwargs["base_url"] = base
    key = os.environ.get("ATHENA_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if key:
        kwargs["api_key"] = key
    return OpenAI(**kwargs)


# Generation params (env-overridable). A lower temperature makes the tool-using
# loop converge faster (fewer wandering round-trips); the token cap bounds the
# final answer; parallel_tool_calls lets the model batch lookups into one turn.
# Each is conditionally included so reasoning models (o-series, gpt-5) that reject
# `temperature`/`parallel_tool_calls` or rename `max_tokens` still work:
#   ATHENA_TEMPERATURE=none        omit temperature (also: off/default/empty)
#   ATHENA_TOKENS_PARAM=max_completion_tokens   rename the token-limit param
#   ATHENA_PARALLEL_TOOL_CALLS=false            omit parallel_tool_calls
def _gen_params() -> dict:
    params: dict = {}
    temp = os.environ.get("ATHENA_TEMPERATURE")
    if temp is None:
        params["temperature"] = 0.3
    elif temp.strip().lower() not in ("", "none", "off", "default"):
        params["temperature"] = config.float_env("ATHENA_TEMPERATURE", 0.3)
    token_param = os.environ.get("ATHENA_TOKENS_PARAM", "max_tokens")
    params[token_param] = config.int_env("ATHENA_MAX_TOKENS", 2048)
    if config.bool_env("ATHENA_PARALLEL_TOOL_CALLS", True):
        params["parallel_tool_calls"] = True
    return params


def _error_hint(name: str, e: Exception) -> str:
    """Turn an LLM API exception into a clean, user-facing message (no 500s)."""
    if "RateLimit" in name:
        return (
            "Rate limit hit (tokens/min). Wait a few seconds and retry, or set a "
            "lighter model via ATHENA_ASK_MODEL in .env."
        )
    return f"LLM API error: {name}: {e}"


def _tool_content(output) -> str:
    """Serialise a tool result for the model, capped so a large result (a wide
    search, a deep impact scan) can't balloon the context on every later round.
    ATHENA_TOOL_RESULT_CHARS bounds the per-result size (0 = uncapped)."""
    s = json.dumps(output, default=str)
    cap = config.int_env("ATHENA_TOOL_RESULT_CHARS", 12000)
    if cap and len(s) > cap:
        s = s[:cap] + f"… [truncated {len(s) - cap} chars — narrow the query if needed]"
    return s


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
    "1b. ALSO consult the DOCUMENTS with search_docs whenever the question touches "
    "requirements, business rules, policies, pricing, limits, or 'what is it supposed "
    "to do' — the answer may be written in a spec/PDF/spreadsheet, not the code. Then "
    "read_passage the best hits to quote them exactly, and follow their mentioned code "
    "to confirm the docs match the implementation (flag any mismatch).\n"
    "2. To explain a flow or behaviour you MUST read_source / read_file the key symbols "
    "and follow callers/callees — DO NOT describe a flow from symbol names alone; names "
    "mislead. Searching only tells you where to look; the answer comes from reading.\n"
    "3. HARD RULE — no guessing: if you're about to write 'likely', 'probably', "
    "'possibly', 'seems', 'I assume', 'implied', or a placeholder like ':line X', STOP and "
    "read the actual source until you know. Ship an answer only once its key claims come "
    "from code you read, not from names you saw. Spend your tool budget — reading three "
    "more files beats one confident-sounding guess.\n"
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
    "- GO DEEP ENOUGH to be specific: follow callers/callees until you can name the "
    "concrete steps end to end and the exact conditions/values that drive them. A vague "
    "summary means you stopped too early — read one more file. Name the real value (an "
    "amount, a timeout, a status, a branch), never a hand-wavy 'it validates the input'.\n"
    "- VERIFY before answering: every statement you make must trace to code you actually "
    "read; if a claim is not backed by what you saw, verify it or drop it. Distinguish "
    "what the code proves from what you're inferring, and never invent names or numbers.\n"
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

# Appended to both audiences: the chat UI renders ```mermaid fenced blocks as
# live diagrams. The syntax rules matter — an LLM-written diagram that doesn't
# parse renders as nothing, so the constraints below keep it valid.
_DIAGRAM = (
    "\n\nDIAGRAMS — the chat UI renders any ```mermaid fenced block as a real "
    "diagram (Mermaid.js), so use one whenever it makes the answer clearer.\n"
    "WHEN: include ONE mermaid diagram, alongside the prose (never instead of it), "
    "when the answer describes a multi-step flow, a sequence of interactions between "
    "parts/apps/services, a decision tree, or how components relate. Skip it for "
    "simple factual or single-step answers where it would add nothing.\n"
    "HOW: put it in a fenced ```mermaid block. Use `flowchart TD` (or `LR`) for "
    "flows/architecture and `sequenceDiagram` for request/response interactions. "
    "Keep it focused on the main path — roughly 5–12 nodes, not the whole system.\n"
    "SYNTAX (a diagram that fails to parse shows as nothing, so follow these exactly):\n"
    '- ALWAYS quote node text: `A["Charge the card"]`, never `A[Charge the card]`. '
    "This is required whenever the label contains a space, parenthesis, slash, colon, "
    "comma, dot, or any punctuation.\n"
    "- Node IDs are bare alphanumeric tokens (A, B, step1); the human text goes inside "
    "the quoted brackets, not in the ID.\n"
    "- No backticks, markdown, HTML, or code snippets inside the diagram; labels are "
    'plain text only. Keep edge labels short: `A -->|"if declined"| B`.\n'
    "- Write the diagram in the same language as the rest of the answer.\n"
    "LABELS: plain-language, product-level labels for a business reader (no code "
    "identifiers); real class/method/file names for a developer."
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
    + "You are a sharp PRODUCT ANALYST writing for NON-TECHNICAL readers (product, "
    "operations, business, support). Your job is to turn code into a clear product story "
    "that makes the reader think 'now I finally understand how this actually works' — "
    "concrete, confident, and completely free of engineering jargon.\n\n"
    + _INVESTIGATE
    + "VOICE & HARD RULES (this is what makes a business answer good):\n"
    "- Write in the user's language, in plain business terms a smart non-engineer uses.\n"
    "- NEVER show code identifiers — no class/method/function/variable/file names, no "
    "'PaymentService.charge'. Translate every internal name into the product concept the "
    "reader knows (customer, order, refund, ticket, seat, wallet). If you catch yourself "
    "writing a code name, rephrase it as what it DOES for the business.\n"
    "- Talk about the PRODUCT and the PEOPLE, not the program: what the customer does, "
    "what they see, what the business rule is, what outcome results. Never mention code "
    "structure, functions, or 'the system calls…'.\n"
    "- Be specific, not generic. Every claim should carry a real detail from the code — an "
    "amount, a fee, a limit, a hold/expiry time, a retry count, a status change. 'It "
    "validates the order' is weak; 'the order is rejected if the seat was released after "
    "the 15-minute hold' is strong. Concrete numbers are what make it feel authoritative.\n"
    "- Say what the customer actually experiences at each step (a screen, a message, an "
    "email/SMS, a status), and what they see when it goes wrong.\n\n"
    "SHAPE THE ANSWER LIKE THIS (use these as short headings; skip a part only if it "
    "truly doesn't apply — never pad):\n"
    "1. **In short** — 1–2 sentences that answer the question directly, up top.\n"
    "2. **Who's involved** — the people and outside services in plain terms (customer, "
    "staff, the app, the payment provider, the SMS/email service).\n"
    "3. **How it works, step by step** — a numbered journey ('First the customer…, then "
    "the app…, if the card is declined…'), each step saying what happens, why (the rule), "
    "and what the customer sees.\n"
    "4. **Rules, limits & numbers** — the concrete business rules, validations, amounts, "
    "fees, timers, and limits the code enforces.\n"
    "5. **When things go wrong** — the main failure paths and exactly what the customer "
    "experiences in each.\n"
    "6. **Where this lives** — one plain-language line naming the app + screen/feature "
    "(a file path may follow, brief and secondary).\n"
    "- If a price/rule/policy is configured elsewhere or decided outside the code, say so "
    "plainly instead of guessing. Don't paste code." + _COMPLETENESS + _DIAGRAM
)

_ANSWER_TECHNICAL = (
    _IDENTITY
    + "You are a SENIOR ENGINEER giving a precise code walkthrough to another developer "
    "who will act on it. Assume full software fluency — skip basics. Be exact and dense: "
    "real symbol names, real control flow, and evidence for every claim. A great answer "
    "reads like the notes of someone who actually traced the code, not a summary.\n\n"
    + _INVESTIGATE
    + "VOICE & HARD RULES (this is what makes a technical answer good):\n"
    "- Use REAL names — exact classes, methods, functions, fields — and CITE the source "
    "for every key claim as `repo/path:line` (use the ranges tools give you). An uncited "
    "claim about behaviour is a red flag; if you didn't read it, don't assert it.\n"
    "- Explain actual CONTROL FLOW, not a feature description: who calls what, in what "
    "order, guarded by which conditions (callers → callees). Name the branch that matters "
    "('returns early when status != PENDING'), not 'it checks the status'.\n"
    "- Include short, high-signal code snippets (a few lines) only where they clarify a "
    "condition or shape — each with its file path. Don't paste whole functions.\n"
    "- Prefer precision over prose: exact types, enum values, error classes, config keys.\n\n"
    "SHAPE THE ANSWER LIKE THIS (use these as headings; skip a part only if it truly "
    "doesn't apply — never pad):\n"
    "1. **Summary** — 1–2 sentences: what happens and where it's implemented.\n"
    "2. **Entry point(s)** — where the flow starts (class/method + `path:line`) and what "
    "triggers it (route, event, tap, cron).\n"
    "3. **Flow** — the call path step by step, caller → callee, each step with its "
    "`path:line` and the condition that gates it. This is the core — make it traceable.\n"
    "4. **Key logic & data** — the important branches/rules, the models/state touched, "
    "side effects, and what gets persisted or emitted.\n"
    "5. **Errors & edge cases** — error handling, retries, timeouts, null/empty paths, "
    "concurrency — the failure modes and how the code responds.\n"
    "6. **Gotchas / where to look** — anything surprising (tight coupling, perf, TODOs, "
    "implicit assumptions) plus the key files to open next.\n"
    "- If behaviour depends on config, DI, or generated/external code you can't see, say "
    "so and name where it's wired, instead of guessing." + _COMPLETENESS + _DIAGRAM
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
    (
        "search_docs",
        "Hybrid (keyword + semantic) search over ingested DOCUMENTS (product specs, "
        "PDFs, spec sheets, spreadsheets — docx/pdf/csv/xls/md). Use this for "
        "requirements, business rules, policies, pricing, and anything documented in "
        "prose/tables rather than code. Returns ranked passages with a snippet and a "
        "section id to read in full.",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        },
    ),
    (
        "read_passage",
        "Read the FULL text of a document section (by the id from search_docs), plus "
        "the code symbols it mentions. Use this to quote a spec/rule accurately and to "
        "jump from a document into the code that implements it.",
        {
            "type": "object",
            "properties": {"section_id": {"type": "string"}},
            "required": ["section_id"],
        },
    ),
    (
        "get_document",
        "Metadata + the ordered section list of one document (by document id).",
        {
            "type": "object",
            "properties": {"doc_id": {"type": "string"}},
            "required": ["doc_id"],
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
    # Any of these enables Q&A: an OpenAI key, a provider-agnostic key, or a
    # custom endpoint (a local server may need no key at all).
    return bool(
        os.environ.get("OPENAI_API_KEY")
        or os.environ.get("ATHENA_API_KEY")
        or os.environ.get("ATHENA_API_BASE")
        or os.environ.get("OPENAI_BASE_URL")
    )


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


# Tools that actually inspect code / relationships (vs. locate-only search). If
# the model tries to answer a symbol question having only searched — never read —
# we nudge it to read the source first. Bounded so it can't loop forever.
_READ_TOOLS = {
    "read_source",
    "read_file",
    "read_passage",
    "get_symbol",
    "callers",
    "callees",
    "impact",
    "find_path",
    "community_members",
}
_MAX_NUDGES = 2
_READ_NUDGE = (
    "[investigation check — internal, do not mention this] You are about to answer, "
    "but you have not opened any source yet — you only searched for names, and names "
    "do not prove behaviour. Call read_source (or read_file) on the most relevant "
    "symbols and follow callers/callees, THEN answer from what you actually read."
)


def _needs_read_nudge(steps: list[dict], nudges: int) -> bool:
    """True when the model is trying to answer a code question it only searched for
    (found symbols) but never actually read — and we still have nudge budget."""
    if nudges >= _MAX_NUDGES:
        return False
    searched = any(s["tool"] == "search_symbols" for s in steps)
    read_done = any(s["tool"] in _READ_TOOLS for s in steps)
    return searched and not read_done


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
    the search. Non-streaming: drains the shared agentic loop and returns
    {available, answer, steps[, error]}."""
    parts: list[str] = []
    steps: list[dict] = []
    error: str | None = None
    for ev in _stream_answer(question, engine, history, scope, mode, lang):
        if "unavailable" in ev:
            return {"available": False, "reason": ev["unavailable"]}
        if "delta" in ev:
            parts.append(ev["delta"])
        elif ev.get("done"):
            steps = ev.get("steps", [])
            error = ev.get("error")
    out: dict = {"available": True, "answer": "".join(parts), "steps": steps}
    if error:
        out["error"] = error
    return out


def answer_stream(
    question: str,
    engine: GraphQuery,
    history: list | None = None,
    scope: dict | None = None,
    mode: str = "business",
    lang: str = "auto",
):
    """Streaming variant of answer(): forwards the shared loop's events for the
    SSE endpoint to relay frame by frame. Events:
      {'unavailable': reason} | {'delta': text} | {'tool': name} |
      {'steps': [...], 'done': True[, 'error': name]}
    """
    yield from _stream_answer(question, engine, history, scope, mode, lang)


def _stream_answer(
    question: str,
    engine: GraphQuery,
    history: list | None,
    scope: dict | None,
    mode: str,
    lang: str,
):
    """The single agentic loop behind both answer() and answer_stream().

    Runs plan → call tools → observe → refine for up to ATHENA_MAX_STEPS rounds,
    then streams the final answer token by token. The answer text is buffered
    until the model has actually read source (see _READ_TOOLS): while it hasn't,
    an unread (guessed) answer is intercepted and sent back to read first
    (_READ_NUDGE), so a guess never reaches the caller. Yields:
      {'unavailable': reason} | {'delta': text} | {'tool': name} |
      {'steps': [...], 'done': True[, 'error': name]}
    """
    if not is_available():
        yield {
            "unavailable": "No LLM key or endpoint configured — natural-language "
            "Q&A is disabled. Set OPENAI_API_KEY (or ATHENA_API_BASE) in .env."
        }
        return

    client = _client()
    messages = _init_messages(question, engine, history, scope, mode, lang)
    steps: list[dict] = []
    tool_cache: dict = {}
    nudges = 0
    max_steps = config.int_env("ATHENA_MAX_STEPS", 16)

    for _ in range(max_steps):
        # Stream live only once the model has read something. Until then, buffer
        # this round's text so an unread (guessed) answer can be intercepted.
        live = any(s["tool"] in _READ_TOOLS for s in steps)
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
            yield {"delta": _error_hint(name, e)}
            yield {"steps": steps, "done": True, "error": name}
            return

        content_parts: list[str] = []
        tool_calls: dict[int, dict] = {}  # index → {id, name, args}
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if getattr(delta, "content", None):
                content_parts.append(delta.content)
                if live:
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
            if not live and _needs_read_nudge(steps, nudges):
                # Answered without reading — drop the buffered draft, send it back.
                nudges += 1
                messages.append(
                    {"role": "assistant", "content": "".join(content_parts) or None}
                )
                messages.append({"role": "user", "content": _READ_NUDGE})
                continue
            if not live:  # buffered a good answer → flush it now
                yield {"delta": "".join(content_parts)}
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
                    "content": _tool_content(output),
                }
            )

    yield {"delta": "(stopped: too many reasoning steps)"}
    yield {"steps": steps, "done": True}
