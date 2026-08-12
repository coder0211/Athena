// Workflows tab: chain saved agents on a drag-and-drop canvas. Each node is an
// agent; drag from a node's handle onto another to draw an arrow (source runs
// first, its answer feeds the target). A list of saved workflows sits on top;
// opening one loads it into the canvas builder. Reuses the Workspace canvas
// visuals (the .ws-* classes) so nodes/edges/zoom look and behave the same.
import { $, el, escapeHtml, askConfirm } from "./dom.js";
import { api } from "./api.js";
import { setDirty } from "./dirty.js";

let AGENTS = []; // all saved agents (add-menu + node labels)
let WORKFLOWS = []; // saved workflows (the list)
let cur = null; // {id, label, description} being edited, or null in list view
let nodes = new Map(); // agentId -> {id, agent, x, y}
let edges = []; // {source, target}
let selected = null; // {kind:"node", id} | {kind:"edge", index}
let dirty = false;

const BASE_W = 2000, BASE_H = 1200; // canvas coordinate space
let zoom = 1;
const ZOOM_MIN = 0.4, ZOOM_MAX = 1.8;
// A plain line "person" mark — an agent is a persona, not a robot.
const AGENT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>';

const agentById = (id) => AGENTS.find((a) => a.id === id);
const sel = (id) => `[data-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`;

// --- list view ------------------------------------------------------------
function stepCount(w) {
  return (w.nodes || []).length;
}

function workflowCard(w) {
  const card = el("div", "agent-card");
  const n = stepCount(w);
  const badges = `<span class="agent-badge subtle">${n} agent${n === 1 ? "" : "s"}</span>`;
  card.innerHTML =
    `<div class="agent-card-main">` +
    `<div class="agent-card-head"><span class="agent-name"></span></div>` +
    (w.description ? `<div class="agent-desc"></div>` : "") +
    `<div class="agent-badges">${badges}</div>` +
    `</div>` +
    `<div class="agent-card-acts">` +
    `<button class="btn small" data-act="open" type="button">Open</button>` +
    `<button class="btn small danger" data-act="del" type="button">Delete</button>` +
    `</div>`;
  card.querySelector(".agent-name").textContent = w.label;
  if (w.description) card.querySelector(".agent-desc").textContent = w.description;
  card.querySelector('[data-act="open"]').onclick = () => openBuilder(w);
  card.querySelector('[data-act="del"]').onclick = () => removeWorkflow(w);
  return card;
}

function renderList() {
  const list = $("wf-list");
  list.innerHTML = "";
  $("wf-count").textContent = WORKFLOWS.length ? `${WORKFLOWS.length} workflow(s)` : "";
  if (!WORKFLOWS.length) {
    list.innerHTML =
      `<p class="hint">No workflows yet — click <b>+ New workflow</b>, then drag agents onto ` +
      `the canvas and connect them into a pipeline.</p>`;
    return;
  }
  WORKFLOWS.forEach((w) => list.append(workflowCard(w)));
}

// Toggle between the list and the canvas builder.
function showList(on) {
  $("wf-list").hidden = !on;
  document.querySelector("#workflows .ws-section-title").hidden = !on;
  $("wf-builder").hidden = on;
}

// --- model ----------------------------------------------------------------
function buildModel(w) {
  nodes = new Map();
  edges = [];
  let cascade = 60;
  (w?.nodes || []).forEach((nd) => {
    if (!agentById(nd.agent)) return; // skip nodes whose agent was deleted
    nodes.set(nd.agent, {
      id: nd.agent,
      agent: nd.agent,
      x: typeof nd.x === "number" ? nd.x : (cascade += 40),
      y: typeof nd.y === "number" ? nd.y : (cascade += 20),
    });
  });
  (w?.edges || []).forEach((e) => {
    if (nodes.has(e.source) && nodes.has(e.target) && e.source !== e.target) {
      edges.push({ source: e.source, target: e.target });
    }
  });
}

// Topological step numbers (1-based) for the order badge, so the pipeline reads
// left-to-right regardless of node placement. Cycles fall back to insertion order.
function stepOrder() {
  const ids = [...nodes.keys()];
  const indeg = Object.fromEntries(ids.map((i) => [i, 0]));
  const succ = Object.fromEntries(ids.map((i) => [i, []]));
  edges.forEach((e) => {
    if (indeg[e.target] != null && succ[e.source]) {
      indeg[e.target]++;
      succ[e.source].push(e.target);
    }
  });
  const ready = ids.filter((i) => indeg[i] === 0);
  const order = [];
  while (ready.length) {
    const c = ready.shift();
    order.push(c);
    succ[c].forEach((n) => {
      if (--indeg[n] === 0) ready.push(n);
    });
  }
  ids.forEach((i) => order.includes(i) || order.push(i));
  const map = {};
  order.forEach((id, i) => (map[id] = i + 1));
  return map;
}

// --- render ---------------------------------------------------------------
function scopeLine(a) {
  const r = (a.scope?.repos || []).length;
  const parts = [a.persona || "business", r ? `${r} repo${r === 1 ? "" : "s"}` : "all repos"];
  return parts.join(" · ");
}

function nodeEl(n, order) {
  const a = agentById(n.agent) || { label: n.agent, persona: "", scope: {} };
  const d = el("div", "ws-node ws-node-repo wf-node");
  if (selected?.kind === "node" && selected.id === n.id) d.classList.add("selected");
  d.dataset.id = n.id;
  d.style.left = `${n.x}px`;
  d.style.top = `${n.y}px`;
  d.innerHTML =
    `<div class="ws-node-head"><span class="wf-node-order">${order[n.id] || ""}</span>` +
    `<span class="ws-node-ico">${AGENT_ICON}</span>` +
    `<span class="ws-node-name" title="${escapeHtml(a.label)}">${escapeHtml(a.label)}</span></div>` +
    `<div class="ws-node-desc">${escapeHtml(scopeLine(a))}</div>` +
    `<span class="ws-node-handle" title="Drag onto another agent to connect"></span>`;
  wireNode(d, n);
  return d;
}

function renderNodes() {
  const host = $("wf-nodes");
  host.querySelectorAll(".ws-node").forEach((n) => n.remove());
  const order = stepOrder();
  for (const n of nodes.values()) host.append(nodeEl(n, order));
}

function center(id) {
  const elm = $("wf-nodes").querySelector(sel(id));
  if (!elm) return null;
  return {
    x: elm.offsetLeft + elm.offsetWidth / 2,
    y: elm.offsetTop + elm.offsetHeight / 2,
    hw: elm.offsetWidth / 2,
    hh: elm.offsetHeight / 2,
  };
}

// Rounded elbow connector between two node boxes (copied from the Workspace).
function edgePath(a, b) {
  const R = 18;
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sgn = Math.sign(dx) || 1;
    const p1 = { x: a.x + sgn * a.hw, y: a.y };
    const p2 = { x: b.x - sgn * b.hw, y: b.y };
    const mx = (p1.x + p2.x) / 2;
    const r = Math.min(R, Math.abs(p2.y - p1.y) / 2, Math.abs(mx - p1.x), Math.abs(p2.x - mx));
    if (r < 1) return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
    const dY = Math.sign(p2.y - p1.y) || 1;
    return (
      `M ${p1.x} ${p1.y} L ${mx - sgn * r} ${p1.y} ` +
      `Q ${mx} ${p1.y} ${mx} ${p1.y + dY * r} L ${mx} ${p2.y - dY * r} ` +
      `Q ${mx} ${p2.y} ${mx + sgn * r} ${p2.y} L ${p2.x} ${p2.y}`
    );
  }
  const sgn = Math.sign(dy) || 1;
  const p1 = { x: a.x, y: a.y + sgn * a.hh };
  const p2 = { x: b.x, y: b.y - sgn * b.hh };
  const my = (p1.y + p2.y) / 2;
  const r = Math.min(R, Math.abs(p2.x - p1.x) / 2, Math.abs(my - p1.y), Math.abs(p2.y - my));
  if (r < 1) return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
  const dX = Math.sign(p2.x - p1.x) || 1;
  return (
    `M ${p1.x} ${p1.y} L ${p1.x} ${my - sgn * r} ` +
    `Q ${p1.x} ${my} ${p1.x + dX * r} ${my} L ${p2.x - dX * r} ${my} ` +
    `Q ${p2.x} ${my} ${p2.x} ${my + sgn * r} L ${p2.x} ${p2.y}`
  );
}

const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function renderEdges(temp) {
  const svg = $("wf-edges");
  svg.setAttribute("width", BASE_W);
  svg.setAttribute("height", BASE_H);
  svg.innerHTML =
    `<defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" ` +
    `markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker></defs>`;
  edges.forEach((e, i) => {
    const a = center(e.source), b = center(e.target);
    if (!a || !b) return;
    const d = edgePath(a, b);
    const isSel = selected?.kind === "edge" && selected.index === i;
    const g = svgEl("g", { class: `ws-edge${isSel ? " selected" : ""}`, "data-edge": i });
    g.append(svgEl("path", { d, fill: "none", class: "ws-edge-hit" }));
    g.append(svgEl("path", { d, fill: "none", class: "ws-edge-line", "marker-end": "url(#wf-arrow)" }));
    g.addEventListener("mousedown", (ev) => ev.stopPropagation());
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      selectEdge(i);
    });
    svg.append(g);
  });
  if (temp) {
    svg.append(svgEl("line", { x1: temp.x1, y1: temp.y1, x2: temp.x2, y2: temp.y2, class: "ws-edge-temp" }));
  }
}

function updateEmptyHint() {
  const hint = $("wf-empty-hint");
  hint.hidden = !!nodes.size;
  if (!nodes.size) hint.textContent = "No agents yet — use “+ Add agent” to place one.";
}

function render() {
  renderNodes();
  renderEdges();
  renderPanel();
  updateEmptyHint();
}

// --- drag (move) + link (connect) ----------------------------------------
function wireNode(d, n) {
  d.querySelector(".ws-node-handle").addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startLink(n);
  });
  d.addEventListener("mousedown", (e) => {
    if (e.target.closest(".ws-node-handle")) return;
    e.preventDefault();
    startMove(n, d, e);
  });
}

function startMove(n, d, e0) {
  const startX = e0.clientX, startY = e0.clientY;
  const origX = n.x, origY = n.y;
  let moved = false;
  const onMove = (e) => {
    const dx = (e.clientX - startX) / zoom, dy = (e.clientY - startY) / zoom;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    n.x = Math.max(0, origX + dx);
    n.y = Math.max(0, origY + dy);
    d.style.left = `${n.x}px`;
    d.style.top = `${n.y}px`;
    renderEdges();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (moved) markDirty();
    else selectNode(n.id);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startLink(n) {
  const content = $("wf-content");
  const from = center(n.id);
  const onMove = (e) => {
    const r = content.getBoundingClientRect();
    renderEdges({ x1: from.x, y1: from.y, x2: (e.clientX - r.left) / zoom, y2: (e.clientY - r.top) / zoom });
  };
  const onUp = (e) => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    const tid = document.elementFromPoint(e.clientX, e.clientY)?.closest(".ws-node")?.dataset.id;
    renderEdges();
    if (tid && tid !== n.id) connect(n.id, tid);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function connect(source, target) {
  const dup = edges.findIndex((e) => e.source === source && e.target === target);
  if (dup >= 0) return selectEdge(dup);
  // Prevent a direct 2-cycle (A→B plus B→A); order needs a DAG.
  if (edges.some((e) => e.source === target && e.target === source)) return;
  edges.push({ source, target });
  markDirty();
  selectEdge(edges.length - 1);
}

// --- selection + side panel ----------------------------------------------
function selectNode(id) {
  selected = { kind: "node", id };
  render();
}
function selectEdge(index) {
  selected = { kind: "edge", index };
  render();
}
function deselect() {
  selected = null;
  render();
}

function renderPanel() {
  const panel = $("wf-panel");
  if (!selected) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  if (selected.kind === "node") return renderNodePanel(panel);
  return renderEdgePanel(panel);
}

function renderNodePanel(panel) {
  const n = nodes.get(selected.id);
  if (!n) return deselect();
  const a = agentById(n.agent) || { label: n.agent, persona: "", description: "", scope: {}, tools: {} };
  const mcp = (a.tools?.mcp_servers || []).length;
  panel.innerHTML =
    `<div class="ws-panel-head"><span class="ws-node-ico">${AGENT_ICON}</span>` +
    `<b title="${escapeHtml(a.label)}">${escapeHtml(a.label)}</b>` +
    `<button class="icon-btn ws-panel-close" title="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>` +
    `<div class="ws-panel-kind">Agent</div>` +
    (a.description ? `<p class="wf-panel-desc">${escapeHtml(a.description)}</p>` : "") +
    `<div class="ws-field"><span>Voice</span><div class="wf-panel-val">${escapeHtml(a.persona || "business")}</div></div>` +
    `<div class="ws-field"><span>Scope</span><div class="wf-panel-val">${escapeHtml(scopeLine(a))}${mcp ? ` · ${mcp} MCP` : ""}</div></div>` +
    `<div class="ws-panel-actions"><button class="btn small danger" id="wf-node-remove">Remove from canvas</button></div>`;
  panel.querySelector(".ws-panel-close").onclick = deselect;
  panel.querySelector("#wf-node-remove").onclick = () => removeNode(n.id);
}

function renderEdgePanel(panel) {
  const e = edges[selected.index];
  if (!e) return deselect();
  const a = agentById(e.source), b = agentById(e.target);
  panel.innerHTML =
    `<div class="ws-panel-head"><b>Step</b>` +
    `<button class="icon-btn ws-panel-close" title="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>` +
    `<div class="ws-panel-kind">${escapeHtml(a?.label || e.source)} → ${escapeHtml(b?.label || e.target)}</div>` +
    `<p class="wf-panel-desc">“${escapeHtml(a?.label || e.source)}” runs first; its answer is fed to ` +
    `“${escapeHtml(b?.label || e.target)}” as context.</p>` +
    `<div class="ws-panel-actions"><button class="btn small danger" id="wf-edge-del">Delete connection</button></div>`;
  panel.querySelector(".ws-panel-close").onclick = deselect;
  panel.querySelector("#wf-edge-del").onclick = () => {
    edges.splice(selected.index, 1);
    selected = null;
    markDirty();
    render();
  };
}

function removeNode(id) {
  nodes.delete(id);
  edges = edges.filter((e) => e.source !== id && e.target !== id);
  selected = null;
  markDirty();
  render();
  renderAddMenu();
}

// --- add-agent menu ------------------------------------------------------
function renderAddMenu() {
  const menu = $("wf-add-menu");
  const items = AGENTS.filter((a) => !nodes.has(a.id));
  if (!AGENTS.length) {
    menu.innerHTML = `<div class="ws-add-empty">No agents yet — create some in the Agents tab.</div>`;
    return;
  }
  if (!items.length) {
    menu.innerHTML = `<div class="ws-add-empty">Every agent is on the canvas.</div>`;
    return;
  }
  menu.innerHTML = "";
  items.forEach((a) => {
    const row = el("button", "ws-add-item",
      `<span class="ws-node-ico">${AGENT_ICON}</span><span>${escapeHtml(a.label)}</span>`);
    row.type = "button";
    row.onclick = () => {
      addNode(a);
      menu.hidden = true;
    };
    menu.append(row);
  });
}

function addNode(a) {
  const canvas = $("wf-canvas");
  // Lay new nodes out on a left-to-right grid (a pipeline reads that way), so
  // they never stack — the user then drags to fine-tune and connects them.
  const i = nodes.size;
  const originX = (canvas.scrollLeft || 0) / zoom + 40;
  const originY = (canvas.scrollTop || 0) / zoom + 40;
  const x = originX + (i % 4) * 240;
  const y = originY + Math.floor(i / 4) * 150;
  nodes.set(a.id, { id: a.id, agent: a.id, x, y });
  markDirty();
  render();
  renderAddMenu();
  selectNode(a.id);
}

// --- open / close / save --------------------------------------------------
function openBuilder(w) {
  cur = w ? { id: w.id, label: w.label, description: w.description || "" } : { id: "", label: "", description: "" };
  $("wf-label").value = cur.label;
  $("wf-desc").value = cur.description;
  $("wf-delete").hidden = !w;
  selected = null;
  buildModel(w);
  showList(false);
  render();
  renderAddMenu();
  setMsg("");
  dirty = false;
  setDirty("workflows", false);
  applyZoom(1);
}

function closeBuilder() {
  cur = null;
  showList(true);
  setDirty("workflows", false);
}

function setMsg(text, kind) {
  const m = $("wf-msg");
  m.textContent = text || "";
  m.className = "msg" + (kind ? " " + kind : "");
}

function markDirty() {
  dirty = true;
  setDirty("workflows", true);
  setMsg("Unsaved changes");
}

async function save() {
  const label = $("wf-label").value.trim();
  if (!label) {
    setMsg("A workflow needs a name.", "err");
    $("wf-label").focus();
    return;
  }
  if (!nodes.size) {
    setMsg("Add at least one agent to the canvas.", "err");
    return;
  }
  const payload = {
    id: cur?.id || "",
    label,
    description: $("wf-desc").value.trim(),
    nodes: [...nodes.values()].map((n) => ({ agent: n.agent, x: Math.round(n.x), y: Math.round(n.y) })),
    edges: edges.map((e) => ({ source: e.source, target: e.target })),
  };
  try {
    const saved = await api.post("/api/workflows", payload);
    cur = { id: saved.id, label: saved.label, description: saved.description || "" };
    $("wf-delete").hidden = false;
    dirty = false;
    setDirty("workflows", false);
    setMsg("Saved", "ok");
    await refreshWorkflows();
  } catch (e) {
    setMsg(e.message || "Could not save.", "err");
  }
}

async function removeWorkflow(w) {
  const ok = await askConfirm({
    title: "Delete workflow",
    message: `Delete the workflow “${w.label}”? The agents it chains are untouched.`,
    ok: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del("/api/workflows/" + encodeURIComponent(w.id));
    await refreshWorkflows();
  } catch (e) {
    const note = el("p", "msg err", escapeHtml(e.message || "Could not delete."));
    $("wf-list").prepend(note);
  }
}

// --- load -----------------------------------------------------------------
async function refreshWorkflows() {
  const data = await api.get("/api/workflows");
  WORKFLOWS = data.workflows || [];
  renderList();
}

export async function loadWorkflows() {
  try {
    const [ag, wf] = await Promise.all([api.get("/api/agents"), api.get("/api/workflows")]);
    AGENTS = ag.agents || [];
    WORKFLOWS = wf.workflows || [];
  } catch (e) {
    $("wf-list").innerHTML = `<p class="msg err">${escapeHtml(e.message)}</p>`;
    return;
  }
  // Coming back to the tab returns to the list (an open builder would be stale).
  if (cur) closeBuilder();
  showList(true);
  renderList();
}

// --- zoom + fullscreen ----------------------------------------------------
function applyZoom(z, anchor) {
  const canvas = $("wf-canvas");
  const prev = zoom;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  $("wf-sizer").style.width = `${BASE_W * zoom}px`;
  $("wf-sizer").style.height = `${BASE_H * zoom}px`;
  $("wf-content").style.transform = `scale(${zoom})`;
  $("wf-zoom-reset").textContent = `${Math.round(zoom * 100)}%`;
  if (anchor && prev !== zoom) {
    const ratio = zoom / prev;
    canvas.scrollLeft = (canvas.scrollLeft + anchor.x) * ratio - anchor.x;
    canvas.scrollTop = (canvas.scrollTop + anchor.y) * ratio - anchor.y;
  }
}
const vpCenter = () => {
  const c = $("wf-canvas");
  return { x: c.clientWidth / 2, y: c.clientHeight / 2 };
};

function setFullscreen(on) {
  $("wf-stage").classList.toggle("fullscreen", on);
  document.body.classList.toggle("ws-fs-lock", on);
  $("wf-full").textContent = on ? "Exit full screen" : "Full screen";
}

// --- wiring ---------------------------------------------------------------
$("wf-new").onclick = () => openBuilder(null);
$("wf-save").onclick = save;
$("wf-close").onclick = closeBuilder;
$("wf-delete").onclick = () => cur?.id && removeWorkflow(cur);
$("wf-label").addEventListener("input", markDirty);
$("wf-desc").addEventListener("input", markDirty);
$("wf-add-btn").onclick = (e) => {
  e.stopPropagation();
  const menu = $("wf-add-menu");
  menu.hidden = !menu.hidden;
  if (!menu.hidden) renderAddMenu();
};
$("wf-full").onclick = () => setFullscreen(!$("wf-stage").classList.contains("fullscreen"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("wf-stage")?.classList.contains("fullscreen")) setFullscreen(false);
});
document.addEventListener("click", (e) => {
  const menu = $("wf-add-menu");
  if (menu && !menu.hidden && !e.target.closest(".ws-add")) menu.hidden = true;
});
$("wf-canvas").addEventListener("mousedown", (e) => {
  if (e.target.closest(".ws-node") || e.target.closest(".ws-edge")) return;
  if (selected) deselect();
});
$("wf-zoom-in").onclick = () => applyZoom(zoom * 1.2, vpCenter());
$("wf-zoom-out").onclick = () => applyZoom(zoom / 1.2, vpCenter());
$("wf-zoom-reset").onclick = () => applyZoom(1, vpCenter());
$("wf-canvas").addEventListener("wheel", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const r = $("wf-canvas").getBoundingClientRect();
  applyZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9), { x: e.clientX - r.left, y: e.clientY - r.top });
}, { passive: false });

$("wf-content").style.width = `${BASE_W}px`;
$("wf-content").style.height = `${BASE_H}px`;
applyZoom(1);
