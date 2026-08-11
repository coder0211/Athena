// Source repositories tab: rows of (git URL + searchable branch combo), with
// load-branches, add, remove, and save.
import { $, el, escapeHtml, askConfirm } from "./dom.js";
import { api } from "./api.js";
import { refreshStatus } from "./stats.js";
import { setDirty } from "./dirty.js";

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
        // 'change' (not 'input') so the combo's own render doesn't reopen the
        // list; a delegated listener on #repo-rows marks the list dirty.
        input.dispatchEvent(new Event("change", { bubbles: true }));
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

// Loose Git-URL check for inline feedback (not a hard gate — Save still works).
// Accepts scp-style (git@host:owner/repo), and http(s)/git/ssh URLs. Empty is
// treated as neutral (a blank starter row shouldn't look like an error).
function isValidRepoUrl(v) {
  v = (v || "").trim();
  if (!v) return true;
  if (/^[\w.-]+@[\w.-]+:.+/.test(v)) return true; // git@github.com:owner/repo.git
  if (/^(https?|git|ssh):\/\/\S+$/.test(v)) return true; // https:// git:// ssh://
  return false;
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

// `saved` marks a row that already exists on the server (loaded from sources.yaml
// or persisted by a save) — its ✕ does a real DELETE (drops the clone + workspace
// links), vs. an unsaved row which is just discarded from the DOM.
function repoRow(url = "", branch = "main", saved = false) {
  const row = el("div", "repo-row");
  if (saved && url) row.dataset.savedUrl = url;
  const idx = el("span", "repo-index"); // 1-based position, filled by renumber()
  const u = el("input", "repo-url");
  u.value = url;
  u.placeholder = "git@… or https://….git";
  // Inline URL validity feedback (red border + tooltip) as the user types/blurs.
  const validate = () => {
    const bad = !isValidRepoUrl(u.value);
    u.classList.toggle("invalid", bad);
    u.title = bad ? "Doesn't look like a Git URL — try https://…, git@host:owner/repo, or ssh://…" : "";
  };
  u.addEventListener("input", validate);
  u.addEventListener("blur", validate);

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
  del.onclick = () => removeRow(row);

  row.append(idx, u, combo.wrap, refresh, del);
  if (url) {
    validate();
    load(); // auto-load branches when the URL is already known
  }
  return row;
}

// Remove a repo row. Unsaved rows just drop from the DOM; a saved repo is deleted
// on the server (sources.yaml + its .sources/ clone + workspace links) after a
// confirm — the graph keeps its symbols until the next rebuild.
async function removeRow(row) {
  const savedUrl = row.dataset.savedUrl;
  if (!savedUrl) {
    row.remove();
    renumber();
    return;
  }
  const ok = await askConfirm({
    title: "Remove repository",
    message: `Delete ${savedUrl}? This removes its clone and workspace links. Rebuild the graph afterwards to purge its symbols.`,
    ok: "Remove",
    danger: true,
  });
  if (!ok) return;
  const msg = $("repos-msg");
  try {
    await api.del("/api/repos?url=" + encodeURIComponent(savedUrl));
    row.remove();
    total = Math.max(0, total - 1);
    serverLoaded = Math.max(0, serverLoaded - 1);
    renumber();
    renderMore();
    refreshStatus();
    msg.textContent = "Removed — rebuild the graph to purge its symbols.";
    msg.className = "msg ok";
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "msg err";
  }
}

// --- numbering + server-side pagination ----------------------------------
const PAGE = 10;
let total = 0; // total repositories on the server
let serverLoaded = 0; // how many server repos have been fetched into the list

function renumber() {
  [...$("repo-rows").children].forEach((row, i) => {
    const idx = row.querySelector(".repo-index");
    if (idx) idx.textContent = i + 1;
  });
}

function renderMore() {
  const more = $("repo-more");
  more.innerHTML = "";
  const remaining = total - serverLoaded;
  if (remaining > 0) {
    const btn = el("button", "btn small", `Show more (${remaining} more)`);
    btn.type = "button";
    btn.onclick = loadMore;
    more.append(btn);
  }
}

// Fetch the next page from the server and append it.
async function loadMore() {
  const more = $("repo-more");
  more.innerHTML = `<span class="msg">Loading…</span>`;
  try {
    const resp = await api.get(`/api/sources?offset=${serverLoaded}&limit=${PAGE}`);
    (resp.repositories || []).forEach((r) => $("repo-rows").append(repoRow(r.url, r.branch, true)));
    serverLoaded += (resp.repositories || []).length;
    total = resp.total ?? total;
    renumber();
    renderMore();
  } catch (e) {
    more.innerHTML = `<span class="msg err">${escapeHtml(e.message)}</span>`;
  }
}

// Any edit to the repo list (typing a URL/branch, picking a branch, add or remove
// a row) makes the list dirty until Save persists it. A delegated listener catches
// typing ('input') and committed edits / branch picks ('change').
$("repo-rows").addEventListener("input", () => setDirty("repos", true));
$("repo-rows").addEventListener("change", () => setDirty("repos", true));

export async function loadRepos() {
  const rows = $("repo-rows");
  rows.innerHTML = "";
  const resp = await api.get(`/api/sources?offset=0&limit=${PAGE}`);
  total = resp.total || 0;
  const list = resp.repositories || [];
  if (!total) {
    rows.append(repoRow()); // empty starter row
    serverLoaded = 0;
  } else {
    list.forEach((r) => rows.append(repoRow(r.url, r.branch, true)));
    serverLoaded = list.length;
  }
  renumber();
  renderMore();
  setDirty("repos", false); // freshly loaded from the server
}

$("add-repo").onclick = () => {
  const row = repoRow();
  $("repo-rows").append(row);
  renumber();
  setDirty("repos", true);
  row.querySelector(".repo-url")?.focus();
  row.scrollIntoView({ block: "nearest" });
};

$("save-repos").onclick = async () => {
  const msg = $("repos-msg");
  const btn = $("save-repos");
  btn.disabled = true; // guard against a double-submit while the PUT is in flight
  try {
    // Save replaces the whole file, so pull in any not-yet-loaded pages first —
    // otherwise repos the user never scrolled to would be dropped.
    if (serverLoaded < total) {
      msg.textContent = "Loading remaining repos before save…";
      msg.className = "msg";
      try {
        const resp = await api.get(`/api/sources?offset=${serverLoaded}`);
        (resp.repositories || []).forEach((r) => $("repo-rows").append(repoRow(r.url, r.branch, true)));
        serverLoaded += (resp.repositories || []).length;
        total = resp.total ?? total;
        renumber();
        renderMore();
      } catch (e) {
        msg.textContent = "Couldn't load all repos before saving: " + e.message;
        msg.className = "msg err";
        return;
      }
    }
    const repositories = [...$("repo-rows").children]
      .map((tr) => ({
        url: tr.querySelector(".repo-url").value.trim(),
        branch: (tr.querySelector(".repo-branch").value || "main").trim() || "main",
      }))
      .filter((r) => r.url);
    try {
      const r = await api.put("/api/sources", { repositories });
      msg.textContent = `Saved ${r.count} repos`;
      msg.className = "msg ok";
      total = repositories.length;
      serverLoaded = repositories.length;
      setDirty("repos", false);
      // Now persisted — mark every row saved so its ✕ does a real server-side delete.
      [...$("repo-rows").children].forEach((tr) => {
        const u = tr.querySelector(".repo-url").value.trim();
        if (u) tr.dataset.savedUrl = u;
        else delete tr.dataset.savedUrl;
      });
      renderMore();
      refreshStatus();
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "msg err";
    }
  } finally {
    btn.disabled = false;
  }
};
