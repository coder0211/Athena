// Source repositories tab: rows of (git URL + searchable branch combo), with
// load-branches, add, remove, and save.
import { $, el, escapeHtml } from "./dom.js";
import { api } from "./api.js";
import { refreshStatus } from "./stats.js";

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

export async function loadRepos() {
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
