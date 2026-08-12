// Selection picker (chat header): choose what runs the answer — nothing ("No
// agent"), a single saved *agent* (persona + scope + toolset), or a *workflow*
// that chains several agents. All are authored in the dashboard; the chat only
// selects. The choice is mutually exclusive and, once a conversation has turns,
// locks for the rest of it (an agent/workflow frames the whole conversation).
import { $, el, escapeHtml } from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";
import { apiGet } from "./api.js";
import { applyModeTheme } from "./mode.js";
import { renderEmpty } from "./messages.js";

const agentById = (id) => (S.AGENTS || []).find((a) => a.id === id);
const workflowById = (id) => (S.WORKFLOWS || []).find((w) => w.id === id);
const currentAgent = () => agentById(S.agent);
const currentWorkflow = () => workflowById(S.workflow);

// --- header button (shows the active selection, or "No agent") ------------
export function refreshAgentButton() {
  const picker = $("agent-picker");
  if (!picker) return;
  const w = currentWorkflow();
  const a = currentAgent();
  $("agent-picker-label").textContent = w ? w.label : a ? a.label : t().agent.none;
  picker.classList.toggle("has-agent", !!(w || a));
  const btn = $("agent-picker-btn");
  if (btn) btn.title = S.agentLocked ? t().agent.locked : t().agent.pickerTitle;
}

// Apply the current selection everywhere: the effective voice (S.mode) drives
// the welcome copy / starters / refine buttons. An agent carries its own voice;
// a workflow spans several, so it falls back to the default; nothing → `fallback`.
function applySelection(fallback = "business") {
  const a = currentAgent();
  S.mode = S.workflow ? "business" : a ? a.persona || "business" : fallback;
  applyModeTheme();
  refreshAgentButton();
  renderMenuActive();
}

export function setAgent(id) {
  S.agent = id || "";
  S.workflow = "";
  applySelection();
}

export function setWorkflow(id) {
  S.workflow = id || "";
  S.agent = "";
  applySelection();
}

// Restore a saved conversation's selection (workflow wins over agent, as in run).
export function restoreSelection(agentId, workflowId, mode = "business") {
  S.workflow = workflowId || "";
  S.agent = workflowId ? "" : agentId || "";
  applySelection(mode);
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

// --- load the saved agents + workflows ------------------------------------
export async function loadAgents() {
  try {
    const [ag, wf] = await Promise.all([apiGet("/api/agents"), apiGet("/api/workflows")]);
    S.AGENTS = (ag && ag.agents) || [];
    S.WORKFLOWS = (wf && wf.workflows) || [];
  } catch {
    S.AGENTS = S.AGENTS || [];
    S.WORKFLOWS = S.WORKFLOWS || [];
  }
  // Drop a since-deleted selection so the picker stays valid.
  if (S.agent && !currentAgent()) {
    S.agent = "";
    localStorage.removeItem("athena_agent");
  }
  if (S.workflow && !currentWorkflow()) {
    S.workflow = "";
    localStorage.removeItem("athena_workflow");
  }
  renderAgentMenu();
  applySelection();
}

// --- dropdown menu --------------------------------------------------------
function renderMenuActive() {
  const cur = S.workflow ? `wf:${S.workflow}` : S.agent ? `ag:${S.agent}` : "";
  document
    .querySelectorAll("#agent-menu .agent-menu-item")
    .forEach((row) => row.classList.toggle("active", (row.dataset.key || "") === cur));
}

function scopeLine(a) {
  const r = (a.scope?.repos || []).length;
  const parts = [r ? `${r} repo${r === 1 ? "" : "s"}` : t().agent.allRepos];
  const m = (a.tools?.mcp_servers || []).length;
  if (m) parts.push(`${m} MCP`);
  if (a.model) parts.push(a.model);
  return parts.join(" · ");
}

function menuRow(key, label, desc, onClick) {
  const row = el("div", "agent-menu-item");
  row.dataset.key = key;
  row.setAttribute("role", "option");
  row.innerHTML =
    `<span class="agent-menu-text">` +
    `<span class="agent-menu-label">${escapeHtml(label)}</span>` +
    (desc ? `<span class="agent-menu-desc">${escapeHtml(desc)}</span>` : "") +
    `</span>`;
  row.onclick = onClick;
  return row;
}

export function renderAgentMenu() {
  const menu = $("agent-menu");
  if (!menu) return;
  const s = t().agent;
  menu.innerHTML = "";
  menu.append(menuRow("", s.none, s.noneDesc, () => pick("", ""))); // the default

  if ((S.AGENTS || []).length) {
    menu.append(el("div", "agent-menu-head", escapeHtml(s.agentsHead)));
    S.AGENTS.forEach((a) =>
      menu.append(menuRow(`ag:${a.id}`, a.label, a.description || scopeLine(a), () => pick(a.id, ""))),
    );
  }
  if ((S.WORKFLOWS || []).length) {
    menu.append(el("div", "agent-menu-head", escapeHtml(s.workflowsHead)));
    S.WORKFLOWS.forEach((w) => {
      const n = (w.nodes || []).length;
      const desc = w.description || `${n} ${n === 1 ? s.agentOne : s.agentMany}`;
      menu.append(menuRow(`wf:${w.id}`, w.label, desc, () => pick("", w.id)));
    });
  }
  if (!(S.AGENTS || []).length && !(S.WORKFLOWS || []).length) {
    menu.append(el("div", "agent-menu-empty", escapeHtml(s.empty)));
  }
  renderMenuActive();
}

function pick(agentId, workflowId) {
  closeMenu();
  if (S.agentLocked) return;
  if ((agentId || "") === (S.agent || "") && (workflowId || "") === (S.workflow || "")) return;
  if (workflowId) setWorkflow(workflowId);
  else setAgent(agentId);
  // Persist the (single) selection.
  if (S.agent) localStorage.setItem("athena_agent", S.agent);
  else localStorage.removeItem("athena_agent");
  if (S.workflow) localStorage.setItem("athena_workflow", S.workflow);
  else localStorage.removeItem("athena_workflow");
  renderEmpty(); // refresh the welcome copy for the new frame
}

// --- menu open/close ------------------------------------------------------
function openMenu() {
  if (S.agentLocked) return;
  renderAgentMenu(); // pick up agents/workflows added in the dashboard since last open
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
