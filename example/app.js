// Athena example UI — talks to the /api/* endpoints on the same origin.
const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : null,
    });
    if (!r.ok) throw new Error(r.statusText);
    return r.json();
  },
  async put(path, body) {
    const r = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(r.statusText);
    return r.json();
  },
};
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

// --- tabs ---
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $(t.dataset.tab).classList.add("active");
  }),
);

// --- status ---
async function refreshStatus() {
  try {
    const s = await api.get("/api/status");
    const bar = $("status-bar");
    if (s.built) {
      const g = s.graph;
      bar.innerHTML = `✅ Graph: <b>${g.nodes.toLocaleString()}</b> nodes · <b>${g.edges.toLocaleString()}</b> edges · <b>${Object.keys(g.by_repo || {}).length}</b> repos`;
      renderStats(g, s.built_at);
    } else {
      bar.textContent = "⚠️ Graph not built yet — add repos, then Fetch & Build.";
    }
  } catch (e) {
    $("status-bar").textContent = "API unreachable: " + e.message;
  }
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
    const t = el("div", "metric");
    t.append(el("div", "n", fmtNum(n)), el("div", "l", l));
    metrics.append(t);
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

// --- repositories ---
// Searchable branch combobox: an input with a filtered, theme-matched dropdown.
// Handles 200+ branches gracefully (type to filter) and keeps an arbitrary value.
function makeBranchCombo(current = "main") {
  const wrap = el("div", "combo");
  const input = el("input", "repo-branch combo-input");
  input.value = current;
  input.placeholder = "branch";
  input.autocomplete = "off";
  input.spellcheck = false;
  const list = el("div", "combo-list");
  list.hidden = true;
  wrap.append(input, list);

  let all = current ? [current] : [];

  function render() {
    const f = input.value.trim().toLowerCase();
    const items = all.filter((b) => b.toLowerCase().includes(f)).slice(0, 300);
    list.innerHTML = "";
    if (!items.length) {
      list.hidden = true;
      return;
    }
    items.forEach((b) => {
      const opt = el("div", "combo-opt", escapeHtml(b));
      opt.title = b;
      if (b === input.value) opt.classList.add("sel");
      opt.onmousedown = (e) => {
        e.preventDefault(); // fire before input blur
        input.value = b;
        list.hidden = true;
      };
      list.append(opt);
    });
    list.hidden = false;
  }

  input.addEventListener("focus", render);
  input.addEventListener("input", render);
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") list.hidden = true;
  });

  return {
    wrap,
    input,
    setLoading(on) {
      input.disabled = on;
      wrap.classList.toggle("loading", on);
    },
    setBranches(branches) {
      all = branches.length ? branches : input.value ? [input.value] : [];
      if (document.activeElement === input) render();
    },
  };
}

async function loadBranches(url, combo) {
  url = url.trim();
  if (!url) return;
  combo.setLoading(true);
  try {
    const { branches } = await api.get("/api/branches?url=" + encodeURIComponent(url));
    combo.setBranches(branches);
    combo.input.title = `${branches.length} branches — type to filter`;
  } catch (e) {
    combo.input.title = "Could not load branches: " + e.message;
  } finally {
    combo.setLoading(false);
  }
}

function repoRow(url = "", branch = "main") {
  const row = el("div", "repo-row");
  const u = el("input", "repo-url");
  u.value = url;
  u.placeholder = "git@… or https://….git";

  const combo = makeBranchCombo(branch);
  const refresh = el("button", "icon-btn", "↻");
  refresh.type = "button";
  refresh.title = "Load branches from the repo";
  const load = () => loadBranches(u.value, combo);
  refresh.onclick = load;
  u.addEventListener("change", load); // fires on blur / Enter after editing the URL

  const del = el("button", "icon-btn", "✕");
  del.type = "button";
  del.title = "Remove";
  del.onclick = () => row.remove();

  row.append(u, combo.wrap, refresh, del);
  if (url) load(); // auto-load branches when the URL is already known
  return row;
}
async function loadRepos() {
  const rows = $("repo-rows");
  rows.innerHTML = "";
  const s = await api.get("/api/sources");
  (s.repositories.length ? s.repositories : [{ url: "", branch: "main" }]).forEach((r) =>
    rows.append(repoRow(r.url, r.branch)),
  );
}
$("add-repo").onclick = () => $("repo-rows").append(repoRow());
$("save-repos").onclick = async () => {
  const repositories = [...$("repo-rows").children]
    .map((tr) => ({
      url: tr.querySelector(".repo-url").value.trim(),
      branch: (tr.querySelector(".repo-branch").value || "main").trim() || "main",
    }))
    .filter((r) => r.url);
  const msg = $("repos-msg");
  try {
    const r = await api.put("/api/sources", { repositories });
    msg.textContent = `Saved ${r.count} repos`;
    msg.className = "msg ok";
    refreshStatus();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "msg err";
  }
};

// --- jobs ---
async function pollJob(jobId, kind) {
  const box = $("job-status");
  const card = el("div", "job");
  box.prepend(card);
  const tick = async () => {
    const j = await api.get("/api/jobs/" + jobId);
    const spin = j.status === "running" ? '<span class="spinner"></span>' : "";
    const secs = (j.finished || Date.now() / 1000) - j.started || 0;
    const dur = secs < 60 ? `${secs.toFixed(0)}s` : `${(secs / 60).toFixed(1)}m`;
    card.innerHTML =
      `<div class="job-line">${spin}<b>${kind}</b>` +
      `<span class="badge ${j.status}">${j.status}</span>` +
      `<span class="job-time">${dur}</span></div>` +
      (j.error ? `<div class="msg err">${escapeHtml(j.error)}</div>` : "");
    if (j.status === "running") setTimeout(tick, 1000);
    else refreshStatus();
  };
  tick();
}
$("run-fetch").onclick = async () => {
  const { job_id } = await api.post("/api/fetch");
  pollJob(job_id, "Fetch");
};
$("run-build").onclick = async () => {
  const { job_id } = await api.post("/api/build");
  pollJob(job_id, "Build");
};

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// --- workspace (repo descriptions + inter-repo relations) ---
let WS = { repos: {}, relations: [], relation_types: [], repo_roles: [], repos_available: [] };
const options = (values, selected) => values.map((v) => new Option(v || "—", v, v === selected, v === selected));

function wsRepoCard(name, meta) {
  const card = el("div", "ws-card");
  card.dataset.name = name;
  const head = el("div", "ws-card-head");
  head.append(el("span", "ws-name", escapeHtml(name)));
  const role = el("select", "ws-role");
  options(["", ...WS.repo_roles], meta.role || "").forEach((o) => role.append(o));
  head.append(role);
  const desc = el("textarea", "ws-desc");
  desc.rows = 2;
  desc.placeholder = "What is this repo? (e.g. mobile app for flight booking)";
  desc.value = meta.description || "";
  const tags = el("input", "ws-tags");
  tags.placeholder = "tags, comma, separated";
  tags.value = (meta.tags || []).join(", ");
  card.append(head, desc, tags);
  return card;
}

function wsRelationRow(rel = {}) {
  const row = el("div", "ws-rel");
  const src = el("select", "ws-rel-src");
  options(WS.repos_available, rel.source).forEach((o) => src.append(o));
  const type = el("select", "ws-rel-type");
  options(WS.relation_types, rel.type).forEach((o) => type.append(o));
  const tgt = el("select", "ws-rel-tgt");
  options(WS.repos_available, rel.target).forEach((o) => tgt.append(o));
  const desc = el("input", "ws-rel-desc");
  desc.placeholder = "description (optional)";
  desc.value = rel.description || "";
  const del = el("button", "icon-btn", "✕");
  del.type = "button";
  del.title = "Remove";
  del.onclick = () => {
    row.remove();
    wsRelEmptyState();
  };
  row.append(src, type, tgt, desc, del);
  return row;
}

function wsRelEmptyState() {
  const box = $("ws-relations");
  const has = [...box.children].some((c) => c.classList.contains("ws-rel"));
  let empty = box.querySelector(".ws-empty");
  if (!has && !empty) {
    box.append(el("div", "ws-empty", "No relations yet — click “+ Add”."));
  } else if (has && empty) {
    empty.remove();
  }
}

async function loadWorkspace() {
  const msg = $("ws-msg");
  try {
    WS = await api.get("/api/workspace");
    const repos = $("ws-repos");
    repos.innerHTML = "";
    const names = [...new Set([...(WS.repos_available || []), ...Object.keys(WS.repos || {})])].sort();
    names.forEach((n) => repos.append(wsRepoCard(n, (WS.repos || {})[n] || {})));
    const rels = $("ws-relations");
    rels.innerHTML = "";
    (WS.relations || []).forEach((r) => rels.append(wsRelationRow(r)));
    wsRelEmptyState();
  } catch (e) {
    msg.textContent = "Load failed: " + e.message;
    msg.className = "msg err";
  }
}

$("ws-add-rel").onclick = () => {
  $("ws-relations").append(wsRelationRow());
  wsRelEmptyState();
};
$("ws-save").onclick = async () => {
  const repos = {};
  [...$("ws-repos").children].forEach((card) => {
    repos[card.dataset.name] = {
      description: card.querySelector(".ws-desc").value.trim(),
      role: card.querySelector(".ws-role").value || null,
      tags: card
        .querySelector(".ws-tags")
        .value.split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };
  });
  const relations = [...$("ws-relations").querySelectorAll(".ws-rel")]
    .map((row) => ({
      source: row.querySelector(".ws-rel-src").value,
      type: row.querySelector(".ws-rel-type").value,
      target: row.querySelector(".ws-rel-tgt").value,
      description: row.querySelector(".ws-rel-desc").value.trim(),
    }))
    .filter((r) => r.source && r.target);
  const msg = $("ws-msg");
  try {
    const r = await api.put("/api/workspace", { repos, relations });
    msg.textContent = `Saved ${r.repos} repos, ${r.relations} relations`;
    msg.className = "msg ok";
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "msg err";
  }
};

// --- init ---
refreshStatus();
loadRepos();
loadWorkspace();
