"""Workflows — wire saved agents into a directed graph and run them in order.

Where an *agent* answers one question on its own, a *workflow* chains several
agents: each node is an agent, each edge is an execution dependency (source runs
before target, and the source's answer is fed to the target as context). Running
a workflow walks the graph in topological order and streams every step's answer,
so the reader sees each specialist's contribution in turn.

    workflow = nodes: [{agent, x, y}]          # which agents, and where on canvas
             + edges: [{source, target}]       # who feeds whom (agent ids)

Stored in workflows.yaml (beside agents.yaml), overridable via ATHENA_WORKFLOWS.
The library starts empty; users build workflows from the dashboard canvas. The
run loop reuses ask.answer_stream() per node — nothing new talks to the LLM.
"""

from __future__ import annotations

import re
import time
from typing import cast

import yaml

import config
from query import agents as agents_module
from query import ask as ask_module

# --- schema ---------------------------------------------------------------
_STR_FIELDS = ("id", "label", "description")


def _slug(text: str) -> str:
    """Kebab-case id from a label. 'Audit then Fix' -> 'audit-then-fix'."""
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return s[:48]


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _clean(entry: dict) -> dict:
    """Keep only known workflow fields, coercing the nested nodes/edges blocks into
    a stable shape. A node references a saved agent by id and carries its canvas
    position; an edge references two agent ids (source runs before target)."""
    out: dict = {}
    for k in _STR_FIELDS:
        if entry.get(k) is not None:
            out[k] = str(entry[k]).strip()

    nodes: list[dict] = []
    seen: set[str] = set()
    for n in entry.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        aid = str(n.get("agent") or "").strip()
        if not aid or aid in seen:
            continue  # de-dup: one node per agent keeps ids == agent ids
        seen.add(aid)
        nodes.append({"agent": aid, "x": _num(n.get("x")), "y": _num(n.get("y"))})
    out["nodes"] = nodes

    node_ids = {n["agent"] for n in nodes}
    edges: list[dict] = []
    edge_seen: set = set()
    for e in entry.get("edges") or []:
        if not isinstance(e, dict):
            continue
        s = str(e.get("source") or "").strip()
        t = str(e.get("target") or "").strip()
        # Drop edges that dangle, self-loop, or duplicate — the run needs a clean DAG.
        if s not in node_ids or t not in node_ids or s == t or (s, t) in edge_seen:
            continue
        edge_seen.add((s, t))
        edges.append({"source": s, "target": t})
    out["edges"] = edges
    return out


# --- store (workflows.yaml) ----------------------------------------------

def _load_store() -> list[dict]:
    path = config.workflows_path()
    if not path.exists():
        return []
    try:
        data = yaml.safe_load(path.read_text()) or {}
    except Exception:
        return []
    return data.get("workflows", []) or []


def _save_store(workflows: list[dict]) -> None:
    config.ensure_config_dir()
    config.workflows_path().write_text(
        yaml.safe_dump({"workflows": workflows}, sort_keys=False, allow_unicode=True)
    )


# --- read API -------------------------------------------------------------

def list_workflows() -> list[dict]:
    """Every stored workflow, normalised (id/label/description/nodes/edges).
    Order preserved from the file (creation order)."""
    out: list[dict] = []
    seen: set[str] = set()
    for entry in _load_store():
        clean = _clean(entry)
        wid = _slug(clean.get("id") or clean.get("label", ""))
        if not wid or wid in seen:
            continue
        seen.add(wid)
        clean["id"] = wid
        out.append(clean)
    return out


def get(workflow_id: str | None) -> dict | None:
    if not workflow_id:
        return None
    for w in list_workflows():
        if w["id"] == workflow_id:
            return w
    return None


def exists(workflow_id: str) -> bool:
    return get(workflow_id) is not None


# --- write API ------------------------------------------------------------

def upsert(entry: dict) -> dict:
    """Create or update a workflow. Requires a label and at least one node."""
    clean = _clean(entry)
    label = clean.get("label", "")
    if not label:
        raise ValueError("A workflow needs a label.")
    wid = _slug(clean.get("id") or label)
    if not wid:
        raise ValueError("A workflow needs a name with at least one letter or digit.")
    if not clean["nodes"]:
        raise ValueError("A workflow needs at least one agent.")
    clean["id"] = wid
    clean.setdefault("created_at", int(time.time()))

    store = [e for e in _load_store() if _slug(e.get("id") or e.get("label", "")) != wid]
    store.append(clean)
    _save_store(store)
    saved = get(wid)
    if saved is None:  # unreachable — we just wrote it; keeps the return type honest
        raise ValueError("Failed to persist the workflow.")
    return saved


def delete(workflow_id: str) -> None:
    store = _load_store()
    kept = [e for e in store if _slug(e.get("id") or e.get("label", "")) != workflow_id]
    if len(kept) == len(store):
        raise KeyError(workflow_id)
    _save_store(kept)


# --- run ------------------------------------------------------------------

def _order(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Topological order of agent ids (Kahn's algorithm). Nodes with no
    dependency come first; ties keep the stored order so the layout is
    predictable. A cycle (shouldn't happen — the editor prevents it) degrades
    gracefully: whatever couldn't be ordered is appended in stored order."""
    ids = [n["agent"] for n in nodes]
    indeg = {i: 0 for i in ids}
    succ: dict[str, list[str]] = {i: [] for i in ids}
    for e in edges:
        if e["source"] in indeg and e["target"] in indeg:
            indeg[e["target"]] += 1
            succ[e["source"]].append(e["target"])
    ready = [i for i in ids if indeg[i] == 0]
    out: list[str] = []
    while ready:
        cur = ready.pop(0)
        out.append(cur)
        for nxt in succ[cur]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                ready.append(nxt)
    for i in ids:  # append any leftover (cycle) so nothing is silently dropped
        if i not in out:
            out.append(i)
    return out


def _preds(agent_id: str, edges: list[dict]) -> list[str]:
    return [e["source"] for e in edges if e["target"] == agent_id]


def _compose(question: str, context: list[tuple[str, str]]) -> str:
    """Fold predecessors' answers into the next step's question as context."""
    if not context:
        return question
    blocks = "\n\n".join(f"### From: {label}\n{text}".strip() for label, text in context)
    return (
        "You are one step in a workflow and receive the previous step(s)' output "
        "as context. Build on it — don't merely repeat it.\n\n"
        f"{blocks}\n\n---\n\nThe user's original request: {question}"
    )


def run_stream(
    workflow: dict,
    question: str,
    engine,
    history: list | None = None,
    scope: dict | None = None,
    lang: str = "auto",
):
    """Run a workflow as a pipeline and stream a *single* final answer. Every node
    runs in dependency order and its answer feeds its successors as context, but
    only the terminal node(s) — the sinks, with no outgoing edge — stream their
    text to the reader; the intermediate steps stay behind the scenes. Emits the
    same event shape as ask.answer_stream() (a `{'step': {...}}` progress frame per
    agent, tool-trace events from every step, and the final `{steps, sources,
    done}`), so the SSE endpoint relays it unchanged. Steps/sources from all nodes
    are merged into the final frame; only the sinks' text becomes the answer."""
    nodes = workflow.get("nodes") or []
    edges = workflow.get("edges") or []
    if not nodes:
        yield {"delta": "This workflow has no agents yet."}
        yield {"steps": [], "sources": [], "done": True}
        return

    order = _order(nodes, edges)
    total = len(order)
    # Sinks (no outgoing edge) produce the pipeline's final output; everything
    # upstream is an intermediate step whose answer only feeds downstream. With no
    # edges at all, every node is a sink and answers independently.
    with_succ = {e["source"] for e in edges}
    sinks = {aid for aid in order if aid not in with_succ}

    results: dict[str, str] = {}          # agent id -> its answer text
    labels: dict[str, str] = {}           # agent id -> display label
    all_steps: list[dict] = []
    all_sources: list[dict] = []
    seen_src: set = set()

    for idx, aid in enumerate(order):
        agent = agents_module.get(aid)
        label = (agent or {}).get("label") or aid
        labels[aid] = label
        is_final = aid in sinks
        # A progress frame so a client can show "step 2/3 · Fix writer" while the
        # intermediate agents (which produce no visible text) are working.
        yield {"step": {"agent": aid, "label": label, "index": idx, "total": total, "final": is_final}}

        if agent is None:  # a node whose agent was deleted — skip, keep the chain going
            results[aid] = ""
            continue

        ctx = [(labels[p], results.get(p, "")) for p in _preds(aid, edges) if results.get(p)]
        step_q = _compose(question, ctx)

        buf: list[str] = []
        for raw in ask_module.answer_stream(step_q, engine, history, scope, lang=lang, agent=agent):
            ev = cast(dict, raw)  # events are heterogeneous dicts; read them loosely
            if "unavailable" in ev:
                yield ev
                return
            if "delta" in ev:
                buf.append(ev["delta"])
                if is_final:
                    yield ev  # only the terminal step's text reaches the reader
            elif "tool" in ev:
                yield ev  # trace forwarded for every step, so progress still shows
            elif "followups" in ev:
                pass  # intermediate follow-ups dropped; only the final answer matters
            elif ev.get("done"):
                for s in ev.get("steps", []) or []:
                    all_steps.append(s)
                for src in ev.get("sources", []) or []:
                    key = src.get("id") or src.get("name") or str(src)
                    if key not in seen_src:
                        seen_src.add(key)
                        all_sources.append(src)
        results[aid] = "".join(buf)

    yield {"steps": all_steps, "sources": all_sources, "done": True}
