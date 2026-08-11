// Entry point: tabs, the Open Chat link, and initial data load. Feature modules
// (repos, jobs, workspace) wire their own buttons on import.
import { $ } from "./dom.js";
import { refreshStatus } from "./stats.js";
import { loadRepos } from "./repos.js";
import { loadWorkspace } from "./workspace.js";
import { loadDocs } from "./docs.js";
import { loadMcp, refreshMcpServers } from "./mcp.js";
import "./jobs.js"; // imported for its button wiring (Fetch / Build)

// --- tabs ---
// The active tab lives in the URL hash (e.g. #documents) so a reload keeps your
// place and tabs are deep-linkable/bookmarkable. Falls back to Repositories.
const TABS = [...document.querySelectorAll(".tab")].map((t) => t.dataset.tab);

function activateTab(name, { push = true } = {}) {
  if (!TABS.includes(name)) name = TABS[0];
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((x) => x.classList.toggle("active", x.id === name));
  if (push && location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
  if (name === "mcp") refreshMcpServers(); // discover servers lazily
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => activateTab(t.dataset.tab)),
);
// Support back/forward and manual hash edits.
window.addEventListener("hashchange", () => activateTab(location.hash.slice(1), { push: false }));
activateTab(location.hash.slice(1), { push: false });

// The chat UI runs as a separate service (persisted history). Point "Open Chat"
// at it on the same host, port 8100 (override with ?chatPort=NNNN if you remap it).
const chatPort = new URLSearchParams(location.search).get("chatPort") || "8100";
const openChat = document.querySelector(".open-chat");
if (openChat) openChat.href = `${location.protocol}//${location.hostname}:${chatPort}/chat`;

// --- init ---
refreshStatus();
loadRepos();
loadWorkspace();
loadDocs();
loadMcp();
