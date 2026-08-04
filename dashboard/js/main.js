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
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $(t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "mcp") refreshMcpServers(); // discover servers lazily
  }),
);

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
