// Workspace tab: an interactive node canvas. Each repository or document is a
// draggable node; drag from a node's handle onto another to create a typed
// relation; click a node or link to edit its details. Positions + relations
// persist to workspace.yaml.
import { $, el, escapeHtml } from "./dom.js";
import { api } from "./api.js";
import { setDirty } from "./dirty.js";

let WS = {
  repos: {}, docs: {}, relations: [],
  relation_types: [], repo_roles: [], repos_available: [], docs_available: [],
};
let nodes = new Map(); // id -> {id, kind, key, name, x, y, meta}
let edges = []; // {source, target, type, description}
let selected = null; // {kind:"node", id} | {kind:"edge", index}
let dirty = false;

const NODE_W = 176; // used for auto-layout spacing (real size measured live)
const BASE_W = 2400, BASE_H = 1500; // canvas content size (node coordinate space)
let zoom = 1;
const ZOOM_MIN = 0.4, ZOOM_MAX = 1.8;
const ICON = {
  repo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
};

const normId = (ref) => (ref && ref.includes(":") ? ref : `repo:${ref}`);
const num = (v) => (typeof v === "number" ? v : null);
const sel = (id) => `[data-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`;

// --- model ---------------------------------------------------------------
function buildModel() {
  nodes = new Map();
  for (const [name, m] of Object.entries(WS.repos || {})) {
    nodes.set(`repo:${name}`, {
      id: `repo:${name}`, kind: "repo", key: name, name,
      x: num(m.x), y: num(m.y),
      meta: { description: m.description || "", role: m.role || "", tags: m.tags || [] },
    });
  }
  for (const [id, m] of Object.entries(WS.docs || {})) {
    nodes.set(id, {
      id, kind: "doc", key: id.replace(/^doc:/, ""), name: m.name || id,
      x: num(m.x), y: num(m.y),
      meta: { description: m.description || "", tags: m.tags || [], file_type: m.file_type || "" },
    });
  }
  // Empty canvas: seed with the known repositories so it isn't blank.
  if (!nodes.size) {
    (WS.repos_available || []).forEach((n) =>
      nodes.set(`repo:${n}`, {
        id: `repo:${n}`, kind: "repo", key: n, name: n,
        x: null, y: null, meta: { description: "", role: "", tags: [] },
      }),
    );
  }
  edges = (WS.relations || [])
    .map((r) => ({
      source: normId(r.source), target: normId(r.target),
      type: r.type || "related_to", description: r.description || "",
    }))
    .filter((e) => nodes.has(e.source) && nodes.has(e.target));
  autoLayout(false);
}

function wrapWidth() {
  return $("ws-canvas-wrap")?.clientWidth || 900;
}

// Simple grid — used to seed unplaced nodes (e.g. one just added). No-op while
// the panel is hidden (unmeasurable). `all=true` re-grids everything.
function autoLayout(all) {
  const w = wrapWidth();
  if (w <= 1) return;
  const list = [...nodes.values()];
  const targets = all ? list : list.filter((n) => n.x == null || n.y == null);
  if (!targets.length) return;
  const cols = Math.max(1, Math.floor((w - 60) / (NODE_W + 40)));
  targets.forEach((n, i) => {
    n.x = 30 + (i % cols) * (NODE_W + 40);
    n.y = 30 + Math.floor(i / cols) * 140;
  });
}

// Graph-aware "Tidy up": a force-directed layout (Fruchterman–Reingold) so linked
// nodes cluster together and unrelated ones spread apart. Unconnected nodes are
// parked in a tidy grid beneath the cluster rather than drifting off.
function tidyLayout() {
  const w = wrapWidth();
  if (w <= 1) return;
  const list = [...nodes.values()];
  if (!list.length) return;

  const idx = new Map(list.map((n, i) => [n.id, i]));
  const deg = list.map(() => 0);
  const links = [];
  for (const e of edges) {
    const a = idx.get(e.source), b = idx.get(e.target);
    if (a == null || b == null || a === b) continue;
    links.push([a, b]);
    deg[a]++; deg[b]++;
  }
  const connected = list.map((_, i) => i).filter((i) => deg[i] > 0);
  const isolated = list.map((_, i) => i).filter((i) => deg[i] === 0);

  if (connected.length) {
    const k = 235; // ideal edge length (nodes are ~176 wide)
    const pos = {};
    // Deterministic seed: a ring, so Tidy gives a clean canonical layout.
    const R = Math.max(140, (k * connected.length) / (2 * Math.PI));
    connected.forEach((i, j) => {
      const a = (2 * Math.PI * j) / connected.length;
      pos[i] = { x: Math.cos(a) * R, y: Math.sin(a) * R };
    });
    let temp = k * 1.8;
    for (let it = 0; it < 320; it++) {
      const disp = {};
      connected.forEach((i) => (disp[i] = { x: 0, y: 0 }));
      // Repulsion between every pair.
      for (let a = 0; a < connected.length; a++) {
        for (let b = a + 1; b < connected.length; b++) {
          const i = connected[a], j = connected[b];
          let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
          const d = Math.hypot(dx, dy) || 0.01;
          const f = (k * k) / d / d;
          disp[i].x += dx * f; disp[i].y += dy * f;
          disp[j].x -= dx * f; disp[j].y -= dy * f;
        }
      }
      // Attraction along each link.
      for (const [i, j] of links) {
        let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = d / k;
        disp[i].x -= dx * f; disp[i].y -= dy * f;
        disp[j].x += dx * f; disp[j].y += dy * f;
      }
      // Apply, capped by the cooling temperature.
      connected.forEach((i) => {
        const dd = Math.hypot(disp[i].x, disp[i].y) || 0.01;
        const lim = Math.min(dd, temp);
        pos[i].x += (disp[i].x / dd) * lim;
        pos[i].y += (disp[i].y / dd) * lim;
      });
      temp = Math.max(k * 0.04, temp * 0.965);
    }
    // Overlap removal: separate any node boxes that still collide, so the result
    // is always readable regardless of how the forces settled.
    const OW = NODE_W + 34, OH = 96;
    for (let pass = 0; pass < 80; pass++) {
      let moved = false;
      for (let a = 0; a < connected.length; a++) {
        for (let b = a + 1; b < connected.length; b++) {
          const i = connected[a], j = connected[b];
          const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
          const ox = OW - Math.abs(dx), oy = OH - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            moved = true;
            if (ox <= oy) {
              const p = (ox / 2 + 1) * (dx < 0 ? -1 : 1);
              pos[i].x -= p; pos[j].x += p;
            } else {
              const p = (oy / 2 + 1) * (dy < 0 ? -1 : 1);
              pos[i].y -= p; pos[j].y += p;
            }
          }
        }
      }
      if (!moved) break;
    }
    // Shift the cluster into the visible top-left with padding.
    const xs = connected.map((i) => pos[i].x), ys = connected.map((i) => pos[i].y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    connected.forEach((i) => {
      list[i].x = Math.round(pos[i].x - minX + 50);
      list[i].y = Math.round(pos[i].y - minY + 50);
    });
  }

  // Isolated nodes → neat grid below the connected cluster.
  if (isolated.length) {
    const baseY = connected.length
      ? Math.max(...connected.map((i) => list[i].y)) + 150
      : 40;
    const cols = Math.max(1, Math.floor((w - 60) / (NODE_W + 40)));
    isolated.forEach((i, j) => {
      list[i].x = 40 + (j % cols) * (NODE_W + 40);
      list[i].y = baseY + Math.floor(j / cols) * 130;
    });
  }
}

// --- rendering -----------------------------------------------------------
function render() {
  renderNodes();
  renderEdges();
  renderPanel();
  updateEmptyHint();
}

function positionNode(elm, n) {
  elm.style.left = `${n.x ?? 0}px`;
  elm.style.top = `${n.y ?? 0}px`;
}

function nodeEl(n) {
  const d = el("div", `ws-node ws-node-${n.kind}`);
  if (selected?.kind === "node" && selected.id === n.id) d.classList.add("selected");
  d.dataset.id = n.id;
  positionNode(d, n);
  const sub =
    n.kind === "repo"
      ? n.meta.role
        ? `<span class="ws-node-role">${escapeHtml(n.meta.role)}</span>`
        : ""
      : `<span class="ws-node-role">${escapeHtml((n.meta.file_type || "doc").toUpperCase())}</span>`;
  d.innerHTML =
    `<div class="ws-node-head"><span class="ws-node-ico">${ICON[n.kind]}</span>` +
    `<span class="ws-node-name" title="${escapeHtml(n.name)}">${escapeHtml(n.name)}</span>${sub}</div>` +
    (n.meta.description ? `<div class="ws-node-desc">${escapeHtml(n.meta.description)}</div>` : "") +
    `<span class="ws-node-handle" title="Drag onto another node to connect"></span>`;
  wireNode(d, n);
  return d;
}

function renderNodes() {
  const host = $("ws-nodes");
  host.querySelectorAll(".ws-node, .ws-edge-label").forEach((n) => n.remove());
  for (const n of nodes.values()) host.append(nodeEl(n));
  renderEdgeLabels();
}

function center(id) {
  const elm = $("ws-nodes").querySelector(sel(id));
  if (!elm) return null;
  return {
    x: elm.offsetLeft + elm.offsetWidth / 2,
    y: elm.offsetTop + elm.offsetHeight / 2,
    hw: elm.offsetWidth / 2,
    hh: elm.offsetHeight / 2,
  };
}

// A rounded 3-segment (elbow) connector between two node boxes. Exits one side
// of the source, routes through a midpoint, and enters the opposite side of the
// target — HVH when they're mostly side-by-side, VHV when stacked. Returns an
// SVG path `d`.
function edgePath(a, b) {
  const R = 18; // corner radius
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
  const svg = $("ws-edges");
  svg.setAttribute("width", BASE_W);
  svg.setAttribute("height", BASE_H);
  svg.innerHTML =
    `<defs><marker id="ws-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" ` +
    `markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker></defs>`;
  edges.forEach((e, i) => {
    const a = center(e.source), b = center(e.target);
    if (!a || !b) return;
    const d = edgePath(a, b);
    const isSel = selected?.kind === "edge" && selected.index === i;
    const g = svgEl("g", { class: `ws-edge${isSel ? " selected" : ""}`, "data-edge": i });
    // fill="none" as an attribute (not just CSS) so a path never fills black.
    g.append(svgEl("path", { d, fill: "none", class: "ws-edge-hit" }));
    g.append(svgEl("path", { d, fill: "none", class: "ws-edge-line", "marker-end": "url(#ws-arrow)" }));
    g.addEventListener("mousedown", (ev) => ev.stopPropagation());
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      selectEdge(i);
    });
    svg.append(g);
  });
  if (temp) {
    svg.append(svgEl("line", {
      x1: temp.x1, y1: temp.y1, x2: temp.x2, y2: temp.y2, class: "ws-edge-temp",
    }));
  }
}

// Edge type labels live as HTML overlays (easier to style / click than SVG text).
function renderEdgeLabels() {
  const host = $("ws-nodes");
  host.querySelectorAll(".ws-edge-label").forEach((n) => n.remove());
  edges.forEach((e, i) => {
    const a = center(e.source), b = center(e.target);
    if (!a || !b) return;
    const lbl = el("div", "ws-edge-label", escapeHtml(e.type));
    if (selected?.kind === "edge" && selected.index === i) lbl.classList.add("selected");
    lbl.style.left = `${(a.x + b.x) / 2}px`;
    lbl.style.top = `${(a.y + b.y) / 2}px`;
    lbl.onclick = (ev) => {
      ev.stopPropagation();
      selectEdge(i);
    };
    host.append(lbl);
  });
}

function updateEmptyHint() {
  const hint = $("ws-empty-hint");
  if (!nodes.size) {
    hint.hidden = false;
    hint.textContent = "No nodes yet — use “+ Add node” to place a repository or document.";
  } else {
    hint.hidden = true;
  }
}

// --- drag (move) + link (connect) ----------------------------------------
function wireNode(d, n) {
  const handle = d.querySelector(".ws-node-handle");
  // Connect: drag from the handle onto another node.
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startLink(n);
  });
  // Move: drag the body. A near-zero move is treated as a click (select).
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
    positionNode(d, n);
    renderEdges();
    renderEdgeLabels();
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
  const content = $("ws-content");
  const from = center(n.id);
  const onMove = (e) => {
    const r = content.getBoundingClientRect();
    const x = (e.clientX - r.left) / zoom;
    const y = (e.clientY - r.top) / zoom;
    renderEdges({ x1: from.x, y1: from.y, x2: x, y2: y });
  };
  const onUp = (e) => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest(".ws-node");
    const tid = targetEl?.dataset.id;
    renderEdges();
    if (tid && tid !== n.id) connect(n.id, tid);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function connect(source, target) {
  if (edges.some((e) => e.source === source && e.target === target)) {
    selectEdge(edges.findIndex((e) => e.source === source && e.target === target));
    return;
  }
  edges.push({ source, target, type: WS.relation_types[0] || "related_to", description: "" });
  markDirty();
  selectEdge(edges.length - 1);
}

// --- selection + edit panel ----------------------------------------------
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

function options(values, cur) {
  return values
    .map((v) => `<option value="${escapeHtml(v)}"${v === cur ? " selected" : ""}>${escapeHtml(v || "—")}</option>`)
    .join("");
}

function renderPanel() {
  const panel = $("ws-panel");
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
  const roleField =
    n.kind === "repo"
      ? `<label class="ws-field"><span>Role</span><select id="ws-f-role"><option value="">—</option>${options(WS.repo_roles, n.meta.role)}</select></label>`
      : `<label class="ws-field"><span>Type</span><input value="${escapeHtml((n.meta.file_type || "").toUpperCase())}" disabled /></label>`;
  panel.innerHTML =
    `<div class="ws-panel-head"><span class="ws-node-ico">${ICON[n.kind]}</span>` +
    `<b title="${escapeHtml(n.name)}">${escapeHtml(n.name)}</b>` +
    `<button class="icon-btn ws-panel-close" title="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>` +
    `<div class="ws-panel-kind">${n.kind === "repo" ? "Repository" : "Document"}</div>` +
    `<label class="ws-field"><span>Description</span><textarea id="ws-f-desc" rows="3" placeholder="What is this?">${escapeHtml(n.meta.description)}</textarea></label>` +
    roleField +
    `<label class="ws-field"><span>Tags</span><input id="ws-f-tags" placeholder="comma, separated" value="${escapeHtml((n.meta.tags || []).join(", "))}" /></label>` +
    `<div class="ws-panel-actions"><button class="btn small danger" id="ws-f-remove">Remove from canvas</button></div>`;
  panel.querySelector(".ws-panel-close").onclick = deselect;
  panel.querySelector("#ws-f-desc").oninput = (e) => {
    n.meta.description = e.target.value;
    updateNodeCard(n);
    markDirty();
  };
  const role = panel.querySelector("#ws-f-role");
  if (role)
    role.onchange = (e) => {
      n.meta.role = e.target.value;
      updateNodeCard(n);
      markDirty();
    };
  panel.querySelector("#ws-f-tags").oninput = (e) => {
    n.meta.tags = e.target.value.split(",").map((t) => t.trim()).filter(Boolean);
    markDirty();
  };
  panel.querySelector("#ws-f-remove").onclick = () => removeNode(n.id);
}

function renderEdgePanel(panel) {
  const e = edges[selected.index];
  if (!e) return deselect();
  const a = nodes.get(e.source), b = nodes.get(e.target);
  panel.innerHTML =
    `<div class="ws-panel-head"><b>Connection</b>` +
    `<button class="icon-btn ws-panel-close" title="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>` +
    `<div class="ws-panel-kind">${escapeHtml(a?.name || e.source)} → ${escapeHtml(b?.name || e.target)}</div>` +
    `<label class="ws-field"><span>Relationship</span><select id="ws-f-type">${options(WS.relation_types, e.type)}</select></label>` +
    `<label class="ws-field"><span>Notes</span><textarea id="ws-f-edesc" rows="3" placeholder="Optional description">${escapeHtml(e.description)}</textarea></label>` +
    `<div class="ws-panel-actions"><button class="btn small danger" id="ws-f-edel">Delete connection</button></div>`;
  panel.querySelector(".ws-panel-close").onclick = deselect;
  panel.querySelector("#ws-f-type").onchange = (ev) => {
    e.type = ev.target.value;
    renderEdgeLabels();
    markDirty();
  };
  panel.querySelector("#ws-f-edesc").oninput = (ev) => {
    e.description = ev.target.value;
    markDirty();
  };
  panel.querySelector("#ws-f-edel").onclick = () => {
    edges.splice(selected.index, 1);
    selected = null;
    markDirty();
    render();
  };
}

// Update a node's card in place (description/role) without a full re-render.
function updateNodeCard(n) {
  const elm = $("ws-nodes").querySelector(sel(n.id));
  if (!elm) return;
  const fresh = nodeEl(n);
  elm.replaceWith(fresh);
  renderEdges();
  renderEdgeLabels();
}

function removeNode(id) {
  nodes.delete(id);
  edges = edges.filter((e) => e.source !== id && e.target !== id);
  selected = null;
  markDirty();
  render();
  renderAddMenu();
}

// --- add-node menu -------------------------------------------------------
function availableToAdd() {
  const out = [];
  for (const name of WS.repos_available || [])
    if (!nodes.has(`repo:${name}`)) out.push({ id: `repo:${name}`, kind: "repo", name });
  for (const d of WS.docs_available || [])
    if (!nodes.has(d.id)) out.push({ id: d.id, kind: "doc", name: d.name, file_type: d.file_type });
  return out;
}

function renderAddMenu() {
  const menu = $("ws-add-menu");
  const items = availableToAdd();
  if (!items.length) {
    menu.innerHTML = `<div class="ws-add-empty">Everything is on the canvas.</div>`;
    return;
  }
  menu.innerHTML = "";
  items.forEach((it) => {
    const row = el(
      "button",
      `ws-add-item ws-add-${it.kind}`,
      `<span class="ws-node-ico">${ICON[it.kind]}</span><span>${escapeHtml(it.name)}</span>`,
    );
    row.type = "button";
    row.onclick = () => {
      addNode(it);
      menu.hidden = true;
    };
    menu.append(row);
  });
}

function addNode(it) {
  const canvas = $("ws-canvas");
  const cx = ((canvas.scrollLeft || 0) + 60) / zoom;
  const cy = ((canvas.scrollTop || 0) + 60) / zoom;
  const n =
    it.kind === "repo"
      ? { id: it.id, kind: "repo", key: it.name, name: it.name, x: cx, y: cy, meta: { description: "", role: "", tags: [] } }
      : { id: it.id, kind: "doc", key: it.id.replace(/^doc:/, ""), name: it.name, x: cx, y: cy, meta: { description: "", tags: [], file_type: it.file_type || "" } };
  nodes.set(n.id, n);
  markDirty();
  render();
  renderAddMenu();
  selectNode(n.id);
}

// --- save ----------------------------------------------------------------
function markDirty() {
  dirty = true;
  setDirty("workspace", true);
  const msg = $("ws-msg");
  msg.textContent = "Unsaved changes";
  msg.className = "msg";
}

async function save() {
  const repos = {};
  const docs = {};
  for (const n of nodes.values()) {
    if (n.kind === "repo") {
      repos[n.key] = {
        description: n.meta.description || "",
        role: n.meta.role || null,
        tags: n.meta.tags || [],
        x: Math.round(n.x),
        y: Math.round(n.y),
      };
    } else {
      docs[n.id] = {
        name: n.name,
        description: n.meta.description || "",
        tags: n.meta.tags || [],
        file_type: n.meta.file_type || "",
        x: Math.round(n.x),
        y: Math.round(n.y),
      };
    }
  }
  const relations = edges.map((e) => ({
    source: e.source, target: e.target, type: e.type, description: e.description || "",
  }));
  const msg = $("ws-msg");
  try {
    const r = await api.put("/api/workspace", { repos, docs, relations });
    dirty = false;
    setDirty("workspace", false);
    msg.textContent = `Saved ${r.repos} repos, ${r.docs} docs, ${r.relations} links`;
    msg.className = "msg ok";
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "msg err";
  }
}

// --- wiring --------------------------------------------------------------
export async function loadWorkspace() {
  try {
    WS = await api.get("/api/workspace");
  } catch (e) {
    $("ws-msg").textContent = "Load failed: " + e.message;
    $("ws-msg").className = "msg err";
    return;
  }
  buildModel();
  render();
  renderAddMenu();
  dirty = false;
  setDirty("workspace", false); // a fresh load starts clean
}

$("ws-save").onclick = save;
$("ws-fit").onclick = () => {
  tidyLayout();
  markDirty();
  render();
  // Scroll back to the arranged cluster.
  const wrap = $("ws-canvas-wrap");
  if (wrap) wrap.scrollTo({ left: 0, top: 0, behavior: "smooth" });
};
$("ws-add-btn").onclick = (e) => {
  e.stopPropagation();
  const menu = $("ws-add-menu");
  menu.hidden = !menu.hidden;
  if (!menu.hidden) renderAddMenu();
};

// Full-screen: expand the stage to fill the window. A ResizeObserver already
// redraws edges when the canvas changes size, so no manual re-render needed.
function setFullscreen(on) {
  const stage = $("ws-stage");
  stage.classList.toggle("fullscreen", on);
  document.body.classList.toggle("ws-fs-lock", on);
  $("ws-full").textContent = on ? "Exit full screen" : "Full screen";
}
$("ws-full").onclick = () => setFullscreen(!$("ws-stage").classList.contains("fullscreen"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("ws-stage")?.classList.contains("fullscreen")) setFullscreen(false);
});
document.addEventListener("click", (e) => {
  const menu = $("ws-add-menu");
  if (menu && !menu.hidden && !e.target.closest(".ws-add")) menu.hidden = true;
});
// Click empty canvas (not a node/edge) → deselect, which hides the side panel.
$("ws-canvas").addEventListener("mousedown", (e) => {
  if (e.target.closest(".ws-node") || e.target.closest(".ws-edge") || e.target.closest(".ws-edge-label")) return;
  if (selected) deselect();
});

// --- zoom ----------------------------------------------------------------
// The content sits at a fixed base size; a scaled sizer wraps it so scrollbars
// track the zoomed extent, and a transform scales the content. `anchor` is a
// point within the canvas viewport to keep stationary while zooming.
function applyZoom(z, anchor) {
  const canvas = $("ws-canvas");
  const prev = zoom;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  $("ws-sizer").style.width = `${BASE_W * zoom}px`;
  $("ws-sizer").style.height = `${BASE_H * zoom}px`;
  $("ws-content").style.transform = `scale(${zoom})`;
  $("ws-zoom-reset").textContent = `${Math.round(zoom * 100)}%`;
  if (anchor && prev !== zoom) {
    const ratio = zoom / prev;
    canvas.scrollLeft = (canvas.scrollLeft + anchor.x) * ratio - anchor.x;
    canvas.scrollTop = (canvas.scrollTop + anchor.y) * ratio - anchor.y;
  }
}
const vpCenter = () => {
  const c = $("ws-canvas");
  return { x: c.clientWidth / 2, y: c.clientHeight / 2 };
};
$("ws-zoom-in").onclick = () => applyZoom(zoom * 1.2, vpCenter());
$("ws-zoom-out").onclick = () => applyZoom(zoom / 1.2, vpCenter());
$("ws-zoom-reset").onclick = () => applyZoom(1, vpCenter());
$("ws-canvas").addEventListener(
  "wheel",
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return; // plain scroll stays scroll
    e.preventDefault();
    const r = $("ws-canvas").getBoundingClientRect();
    applyZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9), { x: e.clientX - r.left, y: e.clientY - r.top });
  },
  { passive: false },
);

// Fix the content coordinate space and initialise zoom.
$("ws-content").style.width = `${BASE_W}px`;
$("ws-content").style.height = `${BASE_H}px`;
applyZoom(1);

// The canvas is built while its tab is hidden (zero size), so node measurements
// and layout are only valid once it's shown. A ResizeObserver lays out unplaced
// nodes and redraws edges the moment the panel gains real dimensions.
let laidOut = false;
if (window.ResizeObserver) {
  const wrap = $("ws-canvas-wrap");
  new ResizeObserver(() => {
    if (wrapWidth() <= 1 || !nodes.size) return;
    if (!laidOut) {
      autoLayout(false);
      laidOut = true;
    }
    render();
  }).observe(wrap);
}
