// Conversation history sidebar: list, open, delete, rename, and New chat.
// Talks to the backend's /api/conversations* endpoints.
import { $, el, escapeHtml } from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";
import { apiGet } from "./api.js";
import { addUser, addAssistant, clearMessages, hideEmpty, showEmpty } from "./messages.js";
import { setMode, lockMode, unlockMode, setHeaderTitle } from "./mode.js";
import { renderScope } from "./scope.js";

export async function loadConversations() {
  let list;
  try {
    list = await apiGet("/api/conversations");
  } catch {
    return; // sidebar is best-effort; a failure shouldn't break the chat
  }
  renderConvList(list);
}

function renderConvList(list) {
  const box = $("conv-list");
  box.innerHTML = "";
  if (!list.length) {
    box.append(el("div", "conv-empty", escapeHtml(t().noConversations)));
    return;
  }
  list.forEach((c) => box.append(convItem(c)));
}

function convItem(c) {
  const item = el("div", "conv-item" + (c.id === S.conversationId ? " active" : ""));
  item.dataset.id = c.id;
  const main = el("div", "conv-main");
  const title = el("div", "conv-title", escapeHtml(c.title));
  title.ondblclick = (e) => {
    e.stopPropagation();
    renameConversation(c.id, c.title);
  };
  main.append(title);
  if (c.preview) main.append(el("div", "conv-preview", escapeHtml(c.preview)));
  item.append(main);
  const del = el("button", "conv-del", "×");
  del.type = "button";
  del.title = t().deleteLabel;
  del.onclick = (e) => {
    e.stopPropagation();
    deleteConversation(c.id);
  };
  item.append(del);
  item.onclick = () => openConversation(c.id);
  return item;
}

async function openConversation(id) {
  if (S.busy || id === S.conversationId) return;
  let conv;
  try {
    conv = await apiGet("/api/conversations/" + id);
  } catch {
    return;
  }
  S.conversationId = id;
  S.history = [];
  S.scopeRepos = [];
  S.scopeSymbols = [];
  renderScope();
  setHeaderTitle(conv.title);
  if (conv.mode) setMode(conv.mode);
  clearMessages();
  hideEmpty();
  conv.messages.forEach((m) => {
    if (m.role === "user") {
      addUser(m.content, m.scope);
      S.history.push({ role: "user", content: m.content });
    } else {
      addAssistant(m.content, m.steps || null);
      S.history.push({ role: "assistant", content: m.content });
    }
  });
  if (conv.messages.length) lockMode(); // a saved conversation was produced in one mode
  // Let Regenerate work on a re-opened conversation (re-run its last question).
  const lastUser = [...conv.messages].reverse().find((m) => m.role === "user");
  S.lastRequest = lastUser
    ? { question: lastUser.content, scope: lastUser.scope || { repos: [], symbols: [] } }
    : null;
  markActiveConv();
  if (window.innerWidth <= 720) $("sidebar").classList.add("collapsed");
  $("input").focus();
}

async function deleteConversation(id) {
  try {
    await fetch("/api/conversations/" + id, { method: "DELETE" });
  } catch {
    return;
  }
  if (id === S.conversationId) newChat();
  loadConversations();
}

async function renameConversation(id, current) {
  const title = prompt(t().renamePrompt, current);
  if (title == null || !title.trim()) return;
  try {
    await fetch("/api/conversations/" + id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim() }),
    });
  } catch {
    return;
  }
  if (id === S.conversationId) setHeaderTitle(title.trim());
  loadConversations();
}

function markActiveConv() {
  document
    .querySelectorAll(".conv-item")
    .forEach((it) => it.classList.toggle("active", it.dataset.id === S.conversationId));
}

// Start a fresh conversation without a full page reload.
export function newChat() {
  if (S.busy) return;
  S.conversationId = null;
  S.history = [];
  S.scopeRepos = [];
  S.scopeSymbols = [];
  S.lastRequest = null;
  renderScope();
  clearMessages();
  unlockMode();
  showEmpty();
  setHeaderTitle(null);
  loadConversations();
  $("input").focus();
}
