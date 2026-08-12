// Entry point: tabs, the Open Chat link, and initial data load. Feature modules
// (repos, jobs, workspace) wire their own buttons on import.
import { $ } from "./dom.js";
import { refreshStatus } from "./stats.js";
import { loadRepos } from "./repos.js";
import { loadWorkspace } from "./workspace.js";
import { loadDocs } from "./docs.js";
import { loadVoices } from "./voices.js";
import { loadAgents } from "./agents.js";
import { loadWorkflows } from "./workflows.js";
import { loadMcp, refreshMcpServers } from "./mcp.js";
import "./jobs.js"; // imported for its button wiring (Fetch / Build)

// --- tabs ---
// The active tab lives in the URL hash (e.g. #documents) so a reload keeps your
// place and tabs are deep-linkable/bookmarkable. Falls back to Repositories.
const TABS = [...document.querySelectorAll(".tab")].map((t) => t.dataset.tab);

function activateTab(name, { push = true } = {}) {
  if (!TABS.includes(name)) name = TABS[0];
  document.querySelectorAll(".tab").forEach((x) => {
    const on = x.dataset.tab === name;
    x.classList.toggle("active", on);
    x.setAttribute("aria-selected", on ? "true" : "false");
    x.tabIndex = on ? 0 : -1; // roving tabindex: only the active tab is tab-reachable
  });
  document.querySelectorAll(".panel").forEach((x) => x.classList.toggle("active", x.id === name));
  if (push && location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
  if (name === "mcp") refreshMcpServers(); // discover servers lazily
  if (name === "voices") loadVoices(); // refresh the voice library lazily
  if (name === "agents") loadAgents(); // refresh agents + their building blocks lazily
  if (name === "workflows") loadWorkflows(); // refresh workflows + available agents lazily
}

const tabEls = [...document.querySelectorAll(".tab")];
tabEls.forEach((t) => t.addEventListener("click", () => activateTab(t.dataset.tab)));

// WAI-ARIA tablist keyboard support: arrows/Home/End move between tabs and
// activate them, keeping DOM focus on the newly selected tab.
document.querySelector(".tabs")?.addEventListener("keydown", (e) => {
  const i = tabEls.indexOf(document.activeElement);
  if (i < 0) return;
  let next = null;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % tabEls.length;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + tabEls.length) % tabEls.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = tabEls.length - 1;
  if (next === null) return;
  e.preventDefault();
  const el = tabEls[next];
  activateTab(el.dataset.tab);
  el.focus();
});

// Support back/forward and manual hash edits.
window.addEventListener("hashchange", () => activateTab(location.hash.slice(1), { push: false }));
activateTab(location.hash.slice(1), { push: false });

// Cmd/Ctrl+S saves the active tab's form (Repos / MCP / Workspace), instead of
// the browser's "save page" dialog. Documents has no Save (it auto-indexes).
const SAVE_BTN = { repos: "save-repos", mcp: "mcp-save", workspace: "ws-save" };
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
  const active = document.querySelector(".tab.active")?.dataset.tab;
  const btn = SAVE_BTN[active] && $(SAVE_BTN[active]);
  if (!btn) return;
  e.preventDefault();
  if (!btn.disabled) btn.click();
});

// The chat UI runs as a separate service (persisted history). Point "Open Chat"
// at it on the same host, port 8100 (override with ?chatPort=NNNN if you remap it).
const chatPort = new URLSearchParams(location.search).get("chatPort") || "8100";
const openChat = document.querySelector(".open-chat");
if (openChat) {
  openChat.href = `${location.protocol}//${location.hostname}:${chatPort}/chat`;
  // Disabled state is set by stats.js once the graph status is known.
  openChat.addEventListener("click", (e) => {
    if (openChat.classList.contains("is-disabled")) e.preventDefault();
  });
}

// --- init ---
refreshStatus();
loadRepos();
loadWorkspace();
loadDocs();
loadMcp();

// Keep the graph status fresh when a build runs elsewhere (another browser tab
// or the CLI): poll every 20s while this tab is visible, and refresh instantly
// when it regains focus. Skipped while hidden to avoid needless background load.
setInterval(() => {
  if (document.visibilityState === "visible") refreshStatus();
}, 20000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshStatus();
});
