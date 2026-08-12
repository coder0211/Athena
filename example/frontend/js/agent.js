// Agent picker (chat header): selects a saved *agent* — a persona + knowledge
// scope + toolset + model bundle authored in the dashboard. Read-only here
// (creating/editing agents lives in the dashboard); selecting one applies the
// whole setup to the conversation's answers. Mirrors the persona picker's
// dropdown and — like the mode picker — locks once a conversation has turns,
// since an agent frames the whole conversation. "No agent" hands the answer
// type back to the plain persona picker.
import { $, el, escapeHtml } from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";
import { apiGet } from "./api.js";
import { applyModeTheme } from "./mode.js";
import { renderEmpty } from "./messages.js";

const agentById = (id) => (S.AGENTS || []).find((a) => a.id === id);
const currentAgent = () => agentById(S.agent);

// --- header button (shows the active agent, or "No agent") ----------------
export function refreshAgentButton() {
  const picker = $("agent-picker");
  if (!picker) return;
  const a = currentAgent();
  $("agent-picker-label").textContent = a ? a.label : t().agent.none;
  picker.classList.toggle("has-agent", !!a);
  const btn = $("agent-picker-btn");
  if (btn) btn.title = S.agentLocked ? t().agent.locked : t().agent.pickerTitle;
}

// Select an agent (or "" for none) + reflect it everywhere. The agent carries
// the voice, so selecting one sets the effective voice (S.mode) used by the
// welcome copy / starters / refine buttons; "no agent" falls back to `fallback`.
export function setAgent(id, fallback = "business") {
  S.agent = id || "";
  const a = currentAgent();
  S.mode = a ? a.persona || "business" : fallback;
  applyModeTheme();
  refreshAgentButton();
  renderMenuActive();
}

export function lockAgent() {
  S.agentLocked = true;
  $("agent-picker")?.classList.add("locked");
  $("agent-picker-btn")?.setAttribute("disabled", "");
  refreshAgentButton();
}

export function unlockAgent() {
  S.agentLocked = false;
  $("agent-picker")?.classList.remove("locked");
  $("agent-picker-btn")?.removeAttribute("disabled");
  refreshAgentButton();
}

// --- load the saved agents ------------------------------------------------
export async function loadAgents() {
  try {
    const data = await apiGet("/api/agents");
    S.AGENTS = (data && data.agents) || [];
  } catch {
    S.AGENTS = [];
  }
  // A since-deleted selection falls back to "no agent" so the picker stays valid.
  if (S.agent && !currentAgent()) {
    S.agent = "";
    localStorage.removeItem("athena_agent");
  }
  renderAgentMenu();
  setAgent(S.agent); // apply persisted selection (also governs the mode picker)
}

// --- dropdown menu --------------------------------------------------------
function renderMenuActive() {
  document
    .querySelectorAll("#agent-menu .agent-menu-item")
    .forEach((row) => row.classList.toggle("active", (row.dataset.id || "") === (S.agent || "")));
}

function scopeLine(a) {
  const r = (a.scope?.repos || []).length;
  const parts = [r ? `${r} repo${r === 1 ? "" : "s"}` : t().agent.allRepos];
  const m = (a.tools?.mcp_servers || []).length;
  if (m) parts.push(`${m} MCP`);
  if (a.model) parts.push(a.model);
  return parts.join(" · ");
}

function menuRow(id, label, desc) {
  const row = el("div", "agent-menu-item");
  row.dataset.id = id;
  row.setAttribute("role", "option");
  row.innerHTML =
    `<span class="agent-menu-text">` +
    `<span class="agent-menu-label">${escapeHtml(label)}</span>` +
    (desc ? `<span class="agent-menu-desc">${escapeHtml(desc)}</span>` : "") +
    `</span>`;
  row.onclick = () => pickAgent(id);
  return row;
}

export function renderAgentMenu() {
  const menu = $("agent-menu");
  if (!menu) return;
  const s = t().agent;
  menu.innerHTML = "";
  menu.append(menuRow("", s.none, s.noneDesc)); // the "no agent" default
  (S.AGENTS || []).forEach((a) => menu.append(menuRow(a.id, a.label, a.description || scopeLine(a))));
  if (!S.AGENTS.length) {
    const hint = el("div", "agent-menu-empty", escapeHtml(s.empty));
    menu.append(hint);
  }
  renderMenuActive();
}

function pickAgent(id) {
  closeMenu();
  if (S.agentLocked || (id || "") === (S.agent || "")) return;
  setAgent(id);
  if (S.agent) localStorage.setItem("athena_agent", S.agent);
  else localStorage.removeItem("athena_agent");
  renderEmpty(); // refresh the welcome copy for the new frame
}

// --- menu open/close ------------------------------------------------------
function openMenu() {
  if (S.agentLocked) return;
  renderAgentMenu(); // pick up agents added in the dashboard since last open
  $("agent-menu").hidden = false;
  $("agent-picker-btn").setAttribute("aria-expanded", "true");
  setTimeout(() => document.addEventListener("click", onDocClick), 0);
}
function closeMenu() {
  const menu = $("agent-menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $("agent-picker-btn").setAttribute("aria-expanded", "false");
  document.removeEventListener("click", onDocClick);
}
function onDocClick(e) {
  if (!e.target.closest("#agent-picker")) closeMenu();
}

export function initAgentPicker() {
  const btn = $("agent-picker-btn");
  if (!btn) return;
  btn.onclick = (e) => {
    e.stopPropagation();
    $("agent-menu").hidden ? openMenu() : closeMenu();
  };
}
