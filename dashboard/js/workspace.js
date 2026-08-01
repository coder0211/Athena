// Workspace tab: per-repo descriptions/roles/tags + typed inter-repo relations.
import { $, el, escapeHtml } from "./dom.js";
import { api } from "./api.js";

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

export async function loadWorkspace() {
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
