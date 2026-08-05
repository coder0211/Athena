"""Natural-language Q&A over the knowledge graph (L5), via the OpenAI API.

Runs an agentic function-calling loop: the model plans, calls the GraphQuery
tools, and synthesises an answer. Requires OPENAI_API_KEY. If the key is absent,
`answer()` returns available=False so callers can fall back to structured search.
"""

from __future__ import annotations

import json
import os
import re

import config
from query import mcp_bridge, personas
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
        "List declared typed relations between repositories AND documents (e.g. calls_api_of, backend_of, depends_on). Each endpoint has a name and kind (repo/document).",
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
                "documents": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Restrict the search to these document names/ids "
                    "only. When the user has scoped to specific documents, pass them.",
                },
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
    docs = [d for d in (scope.get("docs") or []) if d]
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
    if docs:
        names = [d.get("name") if isinstance(d, dict) else str(d) for d in docs]
        names = [n for n in names if n]
        parts.append(
            "Restrict DOCUMENT search to these documents ONLY: "
            + ", ".join(names)
            + ". Always pass documents=["
            + ", ".join(f'"{n}"' for n in names)
            + "] to search_docs, then read_passage the best hits."
        )
    tools = [t for t in (scope.get("tools") or []) if t]
    if tools:
        names = [t.get("name") if isinstance(t, dict) else str(t) for t in tools]
        names = [n for n in names if n]
        parts.append(
            "The user explicitly asked you to USE these external MCP tools for this "
            "question: " + ", ".join(names) + ". They are available as functions with "
            "those exact names — call the relevant one(s) and base the answer on what "
            "they return."
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
            "content": f"{personas.system_prompt(mode)}{_lang_note(lang)}\n\nIndexed repositories: {repos}.",
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
    (name, args) pairs don't recompute. Built-in tools dispatch to GraphQuery
    methods; ``mcp__*`` tools route to their third-party MCP server. Returns
    (parsed_args, output)."""
    key = (name, arguments or "")
    if key in cache:
        return cache[key]
    try:
        args = json.loads(arguments or "{}")
        args = args if isinstance(args, dict) else {}
        if mcp_bridge.is_mcp_tool(name):
            output = mcp_bridge.call_tool(name, args)
        else:
            method = getattr(engine, name, None)
            output = method(**args) if method else {"error": f"unknown tool {name}"}
    except Exception as e:  # surface tool errors to the model, don't crash
        args, output = {}, {"error": f"{type(e).__name__}: {e}"}
    result = (args if isinstance(args, dict) else {}, output)
    cache[key] = result
    return result


def _collect_source(output, sources: list[dict], seen: set) -> None:
    """Record a document passage the model actually read (read_passage output) as a
    citable source, de-duplicated by section id. These become the answer's refs."""
    if not isinstance(output, dict) or output.get("error"):
        return
    sid = output.get("id")
    # read_passage returns {id, document, path, title, locator, text, ...}. A search
    # result has no `text`, so this only fires for a passage that was opened & read.
    if not sid or sid in seen or "text" not in output:
        return
    seen.add(sid)
    sources.append(
        {
            "id": sid,
            "document": output.get("document"),
            "path": output.get("path"),
            "title": output.get("title"),
            "locator": output.get("locator"),
        }
    )


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
    "but you have not opened any source yet — you only searched (for code names or "
    "documents), and a search hit does not prove the answer. Open the best hits first: "
    "call read_source/read_file on the most relevant symbols (follow callers/callees), "
    "or read_passage on the top document hits to quote the exact figure/rule. THEN "
    "answer from what you actually read, and name the source document/section you used."
)

# Search tools that only LOCATE things — a hit from one still has to be read (via a
# _READ_TOOLS call) before it can back an answer.
_SEARCH_TOOLS = {"search_symbols", "search_docs"}


# A small model sometimes NARRATES a tool call as text ("I'll check the docs",
# then prints `functions.search_docs({...})`) instead of actually emitting one, so
# the turn ends having done nothing. This matches such pseudo-calls — a tool name
# (optionally `functions.`-prefixed) followed by `(`. Only consulted before any real
# tool has run (steps empty), where a legitimate answer can't yet contain one, so
# false positives are near-zero.
_PSEUDO_CALL = re.compile(
    r"(?:functions\.)?(?:" + "|".join(re.escape(n) for n, _, _ in _TOOL_SPECS) + r")\s*\(",
)
_CALL_NUDGE = (
    "[investigation check — internal, do not mention this] You wrote a tool call as "
    "text (or announced you would search) but did NOT actually call anything, so "
    "nothing ran. Do not print `functions.<tool>(...)` and do not narrate your intent. "
    "Invoke the tool now through the function-calling interface, silently, then answer "
    "from its result."
)


def _looks_like_pseudo_call(text: str) -> bool:
    return bool(text) and bool(_PSEUDO_CALL.search(text))


def _needs_read_nudge(steps: list[dict], nudges: int) -> bool:
    """True when the model is trying to answer a question it only searched for
    (found symbols/documents) but never actually read — and we have nudge budget."""
    if nudges >= _MAX_NUDGES:
        return False
    searched = any(s["tool"] in _SEARCH_TOOLS for s in steps)
    read_done = any(s["tool"] in _READ_TOOLS for s in steps)
    return searched and not read_done


# --- follow-up question suggestions ---------------------------------------
# After an answer, propose a few natural next questions the reader is likely to
# ask, so the chat UI can offer them as one-tap chips. Best-effort: a cheap,
# short, non-streamed call — any failure just yields no suggestions.
_FOLLOWUP_LANG = {"en": "English", "vi": "Vietnamese (tiếng Việt)"}


def _parse_followups(text: str, question: str) -> list[str]:
    """Pull a clean list of question strings out of the model's reply, tolerating
    a ```json fence or stray prose around the array."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.S).strip()
    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\[.*\]", text, re.S)
        try:
            data = json.loads(m.group(0)) if m else []
        except Exception:
            return []
    if not isinstance(data, list):
        return []
    out: list[str] = []
    q_norm = question.strip().lower()
    for item in data:
        s = str(item).strip().strip("-•").strip()
        if s and s.lower() != q_norm and s not in out:
            out.append(s)
    return out[:4]


def _followups(client, question: str, answer: str, mode: str, lang: str) -> list[str]:
    """Suggest up to 4 follow-up questions for the just-answered turn. Returns []
    when disabled (ATHENA_FOLLOWUPS=false), when there's no answer, or on any error."""
    if not config.bool_env("ATHENA_FOLLOWUPS", True) or not (answer or "").strip():
        return []
    lang_name = _FOLLOWUP_LANG.get(lang, "the same language as the answer")
    voice = personas.followup_voice(mode)
    prompt = (
        "A user asked a question about a software product and received the answer "
        "below.\n\n"
        f"QUESTION:\n{question}\n\nANSWER:\n{answer[:3000]}\n\n"
        "Suggest 3 concise follow-up questions the reader is most likely to ask next "
        "to go deeper or explore a closely related area — not ones the answer already "
        f"fully covers. {voice} Write them in {lang_name}, in the first person as the "
        "reader would type them, each under ~14 words. Return ONLY a JSON array of "
        "strings, nothing else."
    )
    try:
        params: dict = {os.environ.get("ATHENA_TOKENS_PARAM", "max_tokens"): 220}
        resp = client.chat.completions.create(
            model=_model(),
            messages=[{"role": "user", "content": prompt}],
            stream=False,
            **params,
        )
        return _parse_followups(resp.choices[0].message.content or "", question)
    except Exception:
        return []


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
    sources: list[dict] = []
    followups: list[str] = []
    error: str | None = None
    for ev in _stream_answer(question, engine, history, scope, mode, lang):
        if "unavailable" in ev:
            return {"available": False, "reason": ev["unavailable"]}
        if "delta" in ev:
            parts.append(ev["delta"])
        elif "followups" in ev:
            followups = ev["followups"]
        elif ev.get("done"):
            steps = ev.get("steps", [])
            sources = ev.get("sources", [])
            error = ev.get("error")
    out: dict = {
        "available": True,
        "answer": "".join(parts),
        "steps": steps,
        "sources": sources,
        "followups": followups,
    }
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
      {'followups': [...]} | {'steps': [...], 'done': True[, 'error': name]}
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
      {'followups': [...]} | {'steps': [...], 'done': True[, 'error': name]}
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
    sources: list[dict] = []  # documents actually read (read_passage) — shown as refs
    seen_sources: set = set()
    tool_cache: dict = {}
    nudges = 0
    max_steps = config.int_env("ATHENA_MAX_STEPS", 16)
    force_first = config.bool_env("ATHENA_FORCE_FIRST_TOOL", True)

    # Built-in tools + any configured third-party MCP server tools (discovered
    # once; empty if none/unreachable, so Q&A is unaffected when MCP isn't used).
    tools = _TOOLS + mcp_bridge.get_specs()

    def _create(tool_choice: str):
        return client.chat.completions.create(
            model=_model(),
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
            stream=True,
            **_gen_params(),
        )

    for _ in range(max_steps):
        # Stream live only once the model has read something. Until then, buffer
        # this round's text so an unread (guessed) answer can be intercepted.
        live = any(s["tool"] in _READ_TOOLS for s in steps)
        # Until a tool has actually run, FORCE one: a small model otherwise tends to
        # narrate ("I'll check the docs") or print `functions.x(...)` as text and
        # stop, having done nothing. `required` makes it emit a real call instead.
        want = "required" if (force_first and not steps) else "auto"
        # Fall back to auto if the provider rejects the forced choice (some don't
        # support "required"); the pseudo-call guard below then catches narration.
        stream = None
        last_err: Exception | None = None
        for choice in ([want, "auto"] if want != "auto" else ["auto"]):
            try:
                stream = _create(choice)
                break
            except Exception as e:  # rate limits / API errors / unsupported choice
                last_err = e
        if stream is None:
            name = type(last_err).__name__
            yield {"delta": _error_hint(name, last_err)}
            yield {"steps": steps, "sources": sources, "done": True, "error": name}
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
            text = "".join(content_parts)
            # No real tool ran yet, but the model wrote one as text (or announced it
            # and stopped) — re-drive it to actually call the tool.
            if not steps and nudges < _MAX_NUDGES and _looks_like_pseudo_call(text):
                nudges += 1
                messages.append({"role": "assistant", "content": text or None})
                messages.append({"role": "user", "content": _CALL_NUDGE})
                continue
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
            fups = _followups(client, question, "".join(content_parts), mode, lang)
            if fups:
                yield {"followups": fups}
            yield {"steps": steps, "sources": sources, "done": True}
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
            _collect_source(output, sources, seen_sources)
            yield {"tool": s["name"], "input": args}  # input enriches the live trace
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": s["id"],
                    "content": _tool_content(output),
                }
            )

    yield {"delta": "(stopped: too many reasoning steps)"}
    yield {"steps": steps, "sources": sources, "done": True}
