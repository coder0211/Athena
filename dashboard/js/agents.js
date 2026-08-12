// Agents tab: create/edit/delete agents. An agent bundles a base persona
// (voice/shape), a knowledge scope (repos/documents), an allowed toolset
// (built-in graph tools + MCP servers), and model settings into one saved
// configuration that chat can select. Reads its building blocks from
// /api/agents/tools (personas, tools, repos, docs, MCP servers).
import { $, el, escapeHtml, askConfirm } from "./dom.js";
import { api } from "./api.js";
import { setDirty } from "./dirty.js";

// Building blocks for the editor, loaded once with the agent list.
let META = { personas: [], builtin_tools: [], mcp_servers: [], repos: [], docs: [] };
let AGENTS = [];

function setMsg(node, text, kind) {
  node.textContent = text || "";
  node.className = "msg" + (kind ? " " + kind : "");
}

// --- list -----------------------------------------------------------------
function scopeSummary(a) {
  const r = (a.scope?.repos || []).length;
  const d = (a.scope?.docs || []).length;
  const parts = [];
  parts.push(r ? `${r} repo${r === 1 ? "" : "s"}` : "all repos");
  if (d) parts.push(`${d} doc${d === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function toolsSummary(a) {
  const b = (a.tools?.builtin || []).length;
  const m = (a.tools?.mcp_servers || []).length;
  const parts = [];
  parts.push(b ? `${b} tool${b === 1 ? "" : "s"}` : "all graph tools");
  if (m) parts.push(`${m} MCP`);
  return parts.join(" · ");
}

function personaLabel(id) {
  return META.personas.find((p) => p.id === id)?.label || id || "business";
}

function agentCard(a) {
  const card = el("div", "agent-card");
  const badges =
    `<span class="agent-badge">${escapeHtml(personaLabel(a.persona))}</span>` +
    `<span class="agent-badge subtle">${escapeHtml(scopeSummary(a))}</span>` +
    `<span class="agent-badge subtle">${escapeHtml(toolsSummary(a))}</span>` +
    (a.model ? `<span class="agent-badge subtle">${escapeHtml(a.model)}</span>` : "");
  card.innerHTML =
    `<div class="agent-card-main">` +
    `<div class="agent-card-head"><span class="agent-name"></span></div>` +
    (a.description ? `<div class="agent-desc"></div>` : "") +
    `<div class="agent-badges">${badges}</div>` +
    `</div>` +
    `<div class="agent-card-acts">` +
    `<button class="btn small" data-act="edit" type="button">Edit</button>` +
    `<button class="btn small danger" data-act="del" type="button">Delete</button>` +
    `</div>`;
  card.querySelector(".agent-name").textContent = a.label;
  if (a.description) card.querySelector(".agent-desc").textContent = a.description;
  card.querySelector('[data-act="edit"]').onclick = () => openEditor(a);
  card.querySelector('[data-act="del"]').onclick = () => removeAgent(a);
  return card;
}

function renderList() {
  const list = $("agent-list");
  list.innerHTML = "";
  $("agent-count").textContent = AGENTS.length ? `${AGENTS.length} agent(s)` : "";
  if (!AGENTS.length) {
    list.innerHTML =
      `<p class="hint">No agents yet — click <b>+ New agent</b> to create one ` +
      `(e.g. a “Security auditor” scoped to your backend repos, or an “Onboarding buddy” ` +
      `in the Business persona).</p>`;
    return;
  }
  AGENTS.forEach((a) => list.append(agentCard(a)));
}

// --- editor (2-step wizard) -----------------------------------------------
// A scope/tools control with an explicit two-way toggle, so what an *empty*
// selection means is stated rather than inferred. The left radio ("off") is the
// default and resolves to [] — which the backend reads as "all repos / all
// tools" (or, for MCP, "none"); the right radio ("on") reveals the checkboxes
// and resolves to just the ticked values. Returns { node, read() -> [values] }.
function toggleGroup(items, selected, valueOf, labelOf, { offLabel, onLabel, emptyHint }) {
  const sel = new Set(selected || []);
  const wrap = el("div", "agent-toggle");
  const name = "agtog-" + Math.random().toString(36).slice(2, 9);

  const mkRadio = (value, text) => {
    const lab = el("label", "agent-radio");
    const r = el("input");
    r.type = "radio";
    r.name = name;
    r.value = value;
    lab.append(r, el("span", null, escapeHtml(text)));
    return { lab, r };
  };
  const off = mkRadio("off", offLabel);
  const on = mkRadio("on", onLabel);
  const radios = el("div", "agent-toggle-radios");
  radios.append(off.lab, on.lab);

  const box = el("div", "agent-checks");
  const boxes = [];
  if (!items.length) {
    box.innerHTML = `<span class="hint">${escapeHtml(emptyHint)}</span>`;
    on.r.disabled = true; // nothing to choose from → "on" is meaningless
  } else {
    items.forEach((it) => {
      const value = valueOf(it);
      const id = "agchk-" + Math.random().toString(36).slice(2, 9);
      const label = el("label", "agent-check");
      label.htmlFor = id;
      const cb = el("input");
      cb.type = "checkbox";
      cb.id = id;
      cb.value = value;
      cb.checked = sel.has(value);
      cb.addEventListener("change", () => setDirty("agents", true));
      const span = el("span", null, escapeHtml(labelOf(it)));
      if (typeof it === "object" && it.description) label.title = it.description;
      label.append(cb, span);
      box.append(label);
      boxes.push(cb);
    });
  }

  const startOn = sel.size > 0 && items.length > 0; // "on" only if there's a saved pick
  on.r.checked = startOn;
  off.r.checked = !startOn;
  box.hidden = !startOn;

  const sync = () => {
    box.hidden = !on.r.checked;
    setDirty("agents", true);
  };
  off.r.addEventListener("change", sync);
  on.r.addEventListener("change", sync);

  wrap.append(radios, box);
  return {
    node: wrap,
    read: () => (on.r.checked ? boxes.filter((b) => b.checked).map((b) => b.value) : []),
  };
}

function field(labelText, control, hint) {
  const f = el("div", "agent-field");
  f.append(el("label", "agent-field-label", escapeHtml(labelText)));
  f.append(control);
  if (hint) f.append(el("div", "agent-field-hint", escapeHtml(hint)));
  return f;
}

// The editor is a 2-step wizard. Every control is built once up front; the two
// steps merely show/hide groups of them, so values survive Back/Next and are
// read together on save. Step 1 = who the agent is + how it answers; step 2 =
// what it may see and use, with model knobs tucked under "Advanced".
function openEditor(agent) {
  const box = $("agent-editor");
  box.hidden = false;
  box.innerHTML = "";
  const editing = !!agent;
  const a = agent || {};

  // --- controls -----------------------------------------------------------
  const label = el("input", "agent-input");
  label.value = a.label || "";
  label.placeholder = "e.g. Security auditor";
  const desc = el("input", "agent-input");
  desc.value = a.description || "";
  desc.placeholder = "One line — who this agent is for";

  const persona = el("select", "agent-input");
  META.personas.forEach((p) => {
    const opt = el("option", null, escapeHtml(p.label));
    opt.value = p.id;
    if (p.id === (a.persona || "business")) opt.selected = true;
    persona.append(opt);
  });

  const instruction = el("textarea", "agent-input agent-textarea");
  instruction.value = a.instruction || "";
  instruction.placeholder = "Optional — extra guidance added on top of the voice.";
  instruction.rows = 3;

  const repos = toggleGroup(META.repos, a.scope?.repos, (x) => x, (x) => x, {
    offLabel: "All repositories",
    onLabel: "Only chosen",
    emptyHint: "No repositories indexed yet — build the graph first.",
  });
  const docs = toggleGroup(META.docs, a.scope?.docs, (x) => x, (x) => x, {
    offLabel: "All documents",
    onLabel: "Only chosen",
    emptyHint: "No documents indexed.",
  });
  const tools = toggleGroup(META.builtin_tools, a.tools?.builtin, (t) => t.name, (t) => t.name, {
    offLabel: "All graph tools",
    onLabel: "Only chosen",
    emptyHint: "No tools available.",
  });
  const mcp = toggleGroup(META.mcp_servers, a.tools?.mcp_servers, (x) => x, (x) => x, {
    offLabel: "None",
    onLabel: "Choose servers",
    emptyHint: "No reachable MCP servers. Add one in the MCP tab to grant its tools.",
  });

  const model = el("input", "agent-input");
  model.value = a.model || "";
  model.placeholder = "default (ATHENA_ASK_MODEL)";
  const temp = el("input", "agent-input agent-num");
  temp.type = "number";
  temp.step = "0.1";
  temp.min = "0";
  temp.max = "2";
  temp.value = a.temperature ?? "";
  temp.placeholder = "default";
  const steps = el("input", "agent-input agent-num");
  steps.type = "number";
  steps.min = "1";
  steps.value = a.max_steps ?? "";
  steps.placeholder = "default";

  [label, desc, instruction, model].forEach((n) =>
    n.addEventListener("input", () => setDirty("agents", true)),
  );
  [persona, temp, steps].forEach((n) =>
    n.addEventListener("change", () => setDirty("agents", true)),
  );

  // --- step 1: basics -----------------------------------------------------
  const step1 = el("div", "agent-step");
  step1.append(el("div", "agent-step-head", "Step 1 of 2 · Basics"));
  const idRow = el("div", "agent-row");
  idRow.append(field("Name", label), field("Voice", persona, "How answers read."));
  step1.append(idRow);
  step1.append(field("What it's for", desc));
  step1.append(field("Extra instruction", instruction));

  // --- step 2: scope & tools ---------------------------------------------
  const step2 = el("div", "agent-step");
  step2.hidden = true;
  step2.append(el("div", "agent-step-head", "Step 2 of 2 · Scope & tools"));
  step2.append(field("Repositories it can read", repos.node));
  step2.append(field("Documents it can read", docs.node));
  step2.append(field("Graph tools it can use", tools.node));
  step2.append(field("MCP servers it can use", mcp.node));

  const adv = el("details", "agent-advanced");
  adv.append(el("summary", "agent-advanced-summary", "Advanced — model settings"));
  const modelRow = el("div", "agent-row");
  modelRow.append(
    field("Model", model, "Override the answer model."),
    field("Temperature", temp, "0 = focused, higher = varied."),
    field("Max steps", steps, "Tool-use budget per answer."),
  );
  adv.append(modelRow);
  step2.append(adv);

  // --- footer: step-aware navigation --------------------------------------
  const msg = el("span", "msg");
  const cancel = el("button", "btn small", "Cancel");
  cancel.type = "button";
  cancel.onclick = closeEditor;
  const back = el("button", "btn small", "← Back");
  back.type = "button";
  back.hidden = true;
  const next = el("button", "btn small primary", "Next →");
  next.type = "button";
  const save = el("button", "btn small primary", editing ? "Save changes" : "Create agent");
  save.type = "button";
  save.hidden = true;
  const actions = el("div", "agent-editor-actions");
  actions.append(cancel, back, next, save, msg);

  const title = el("h3", "agent-editor-title", editing ? "Edit agent" : "New agent");
  box.append(title, step1, step2, actions);

  const showStep = (n) => {
    step1.hidden = n !== 1;
    step2.hidden = n !== 2;
    back.hidden = n === 1;
    next.hidden = n !== 1;
    save.hidden = n === 1;
    setMsg(msg, "");
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (n === 1) label.focus();
  };

  next.onclick = () => {
    if (!label.value.trim()) {
      setMsg(msg, "A name is required.", "err");
      label.focus();
      return;
    }
    showStep(2);
  };
  back.onclick = () => showStep(1);

  save.onclick = async () => {
    const payload = {
      id: editing ? a.id : "",
      label: label.value.trim(),
      description: desc.value.trim(),
      persona: persona.value,
      instruction: instruction.value.trim(),
      scope: { repos: repos.read(), docs: docs.read() },
      tools: { builtin: tools.read(), mcp_servers: mcp.read() },
      model: model.value.trim(),
      temperature: temp.value === "" ? null : Number(temp.value),
      max_steps: steps.value === "" ? null : Number(steps.value),
    };
    if (!payload.label) {
      showStep(1);
      setMsg(msg, "A name is required.", "err");
      label.focus();
      return;
    }
    save.disabled = true;
    try {
      await api.post("/api/agents", payload);
      setDirty("agents", false);
      await loadAgents();
      closeEditor();
    } catch (e) {
      setMsg(msg, e.message || "Could not save the agent.", "err");
    } finally {
      save.disabled = false;
    }
  };

  showStep(1);
}

function closeEditor() {
  const box = $("agent-editor");
  box.hidden = true;
  box.innerHTML = "";
  setDirty("agents", false);
}

async function removeAgent(a) {
  const ok = await askConfirm({
    title: "Delete agent",
    message: `Delete the agent “${a.label}”? This removes the saved configuration; ` +
      `repos, documents, and personas are untouched.`,
    ok: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del("/api/agents/" + encodeURIComponent(a.id));
    await loadAgents();
  } catch (e) {
    const list = $("agent-list");
    const note = el("p", "msg err", escapeHtml(e.message || "Could not delete."));
    list.prepend(note);
  }
}

// --- load -----------------------------------------------------------------
export async function loadAgents() {
  try {
    const [agentsResp, tools] = await Promise.all([
      api.get("/api/agents"),
      api.get("/api/agents/tools"),
    ]);
    AGENTS = agentsResp.agents || [];
    META = { ...META, ...tools };
    if (!META.personas.length) META.personas = [{ id: "business", label: "Business" }];
  } catch (e) {
    $("agent-list").innerHTML = `<p class="msg err">${escapeHtml(e.message)}</p>`;
    return;
  }
  renderList();
}

$("agent-new").onclick = () => openEditor(null);
