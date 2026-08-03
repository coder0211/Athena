// Graph status bar + overview: KPI tiles and single-hue bar charts.
import { $, el, escapeHtml } from "./dom.js";
import { api } from "./api.js";

export async function refreshStatus() {
  const wrap = $("graph-stats");
  // Shimmer on the first load, while /api/status is in flight.
  if (wrap && !wrap.children.length) renderStatsSkeleton();
  try {
    const s = await api.get("/api/status");
    const bar = $("status-bar");
    if (s.built) {
      const g = s.graph;
      const docs = g.node_types?.Document || 0;
      bar.innerHTML =
        `✅ Graph: <b>${g.nodes.toLocaleString()}</b> nodes · ` +
        `<b>${g.edges.toLocaleString()}</b> edges · ` +
        `<b>${Object.keys(g.by_repo || {}).length}</b> repos · ` +
        `<b>${docs.toLocaleString()}</b> docs`;
      renderStats(g, s.built_at);
    } else {
      bar.textContent = "⚠️ Graph not built yet — add repos, then run the Pipeline.";
      if (wrap) wrap.innerHTML = ""; // clear the shimmer
    }
  } catch (e) {
    $("status-bar").textContent = "API unreachable: " + e.message;
    if (wrap) wrap.innerHTML = "";
  }
}

// Shimmer placeholder mirroring the overview (head + KPI tiles + two bar charts).
function renderStatsSkeleton() {
  const skel = (w, h, extra = "") =>
    `<span class="skel-bar" style="display:block;width:${w};height:${h};${extra}"></span>`;
  const tile = () =>
    `<div class="metric">${skel("55%", "24px")}${skel("40%", "11px", "margin-top:9px")}</div>`;
  const barRow = () =>
    `<div class="bar-row">${skel("80%", "12px")}${skel("100%", "8px")}${skel("34px", "12px")}</div>`;
  const viz = (rows) =>
    `<div class="viz">${skel("130px", "11px", "margin-bottom:14px")}` +
    Array.from({ length: rows }, barRow).join("") +
    `</div>`;
  $("graph-stats").innerHTML =
    `<div class="overview-head">${skel("150px", "16px")}</div>` +
    `<div class="metrics">${tile()}${tile()}${tile()}${tile()}</div>` +
    viz(5) +
    viz(4);
}

const fmtNum = (n) => Number(n).toLocaleString();

function relTime(sec) {
  if (!sec) return "";
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 60) return `${Math.round(d)}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

// Single-hue horizontal bars for magnitude comparison (one series → no legend).
function barList(items) {
  const wrap = el("div", "bars");
  const max = Math.max(1, ...items.map((i) => i.value));
  items.forEach((i) => {
    const row = el("div", "bar-row");
    const bl = el("div", "bl", escapeHtml(i.label));
    bl.title = i.label;
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = `${Math.max(2, (100 * i.value) / max).toFixed(1)}%`;
    track.append(fill);
    row.append(bl, track, el("div", "bv", fmtNum(i.value)));
    wrap.append(row);
  });
  return wrap;
}

function vizCard(title, node) {
  const c = el("div", "viz");
  c.append(el("h3", null, title), node);
  return c;
}

function renderStats(g, builtAt) {
  const wrap = $("graph-stats");
  wrap.innerHTML = "";

  const head = el("div", "overview-head");
  head.innerHTML =
    `<h3>Graph overview</h3>` + (builtAt ? `<span class="built-at">built ${relTime(builtAt)}</span>` : "");
  wrap.append(head);

  const communities = (g.node_types && g.node_types.Community) || 0;
  const kpis = [
    ["Nodes", g.nodes],
    ["Edges", g.edges],
    ["Communities", communities],
    ["Repositories", Object.keys(g.by_repo || {}).length],
  ];
  const metrics = el("div", "metrics");
  kpis.forEach(([l, n]) => {
    const tile = el("div", "metric");
    tile.append(el("div", "n", fmtNum(n)), el("div", "l", l));
    metrics.append(tile);
  });
  wrap.append(metrics);

  const repoItems = Object.entries(g.by_repo || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: k, value: v }));
  if (repoItems.length) wrap.append(vizCard("Nodes per repository", barList(repoItems)));

  if (g.top_communities?.length) {
    const items = g.top_communities.slice(0, 10).map((c) => ({ label: c.name, value: c.members }));
    wrap.append(vizCard("Largest concept communities", barList(items)));
  }
}
