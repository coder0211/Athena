// Conversation history sidebar: list, open, delete, rename, and New chat.
// Talks to the backend's /api/conversations* endpoints.
import { $, el, escapeHtml, ICON_EDIT, askConfirm } from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";
import { apiGet } from "./api.js";
import { fold } from "./mentions.js";
import { addUser, addAssistant, clearMessages, hideEmpty, showEmpty } from "./messages.js";
import { setHeaderTitle } from "./mode.js";
import { restoreSelection, lockAgent, unlockAgent } from "./agent.js";
import { renderScope } from "./scope.js";

let convCache = []; // last-loaded list, so search/group re-render without refetching
let convQuery = ""; // current sidebar search text

// Flatten a markdown snippet to plain text for the sidebar preview — raw "##",
// "**", list markers etc. shouldn't leak into the one-line summary.
function stripMd(s) {
  return (s || "")
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s*>\s?/gm, "") // blockquotes
    .replace(/^\s*[-*+]\s+/gm, "") // bullet lists
    .replace(/^\s*\d+\.\s+/gm, "") // numbered lists
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1") // bold/italic
    .replace(/[*_#>`~]/g, "") // stray marks
    .replace(/\s+/g, " ") // collapse whitespace
    .trim();
}

export async function loadConversations() {
  let list;
  try {
    list = await apiGet("/api/conversations");
  } catch {
    return; // sidebar is best-effort; a failure shouldn't break the chat
  }
  convCache = list;
  renderConvList();
}

// Filter the sidebar as the user types in the search box (diacritic-insensitive).
export function filterConversations(q) {
  convQuery = q || "";
  renderConvList();
}

// The last-loaded conversation list (used by the command palette).
export function getConvCache() {
  return convCache;
}

// Which date header a conversation falls under, from its updated_at (epoch secs).
function dateBucket(ts) {
  const g = t().group;
  const midnight = new Date().setHours(0, 0, 0, 0) / 1000;
  if (ts >= midnight) return g.today;
  if (ts >= midnight - 86400) return g.yesterday;
  if (ts >= midnight - 7 * 86400) return g.week;
  return g.older;
}

function renderConvList() {
  const box = $("conv-list");
  // Don't blow away an in-progress inline rename (a background refresh — e.g. from
  // opening the conversation — must not wipe the input the user is typing in).
  if (box.querySelector(".conv-rename")) return;
  box.innerHTML = "";
  if (!convCache.length) {
    box.append(el("div", "conv-empty", escapeHtml(t().noConversations)));
    return;
  }
  const q = fold(convQuery.trim());
  const list = q
    ? convCache.filter((c) => fold(c.title).includes(q) || fold(c.preview || "").includes(q))
    : convCache;
  if (!list.length) {
    box.append(el("div", "conv-empty", escapeHtml(t().noResults)));
    return;
  }
  // Group by date (skipped while searching — matches span dates). The list is
  // already newest-first from the API, so a bucket only ever opens once.
  let lastGroup = null;
  list.forEach((c) => {
    if (!q) {
      const g = dateBucket(c.updated_at || 0);
      if (g !== lastGroup) {
        box.append(el("div", "conv-group", escapeHtml(g)));
        lastGroup = g;
      }
    }
    box.append(convItem(c));
  });
}

function convItem(c) {
  const item = el("div", "conv-item" + (c.id === S.conversationId ? " active" : ""));
  item.dataset.id = c.id;
  const main = el("div", "conv-main");
  const title = el("div", "conv-title", escapeHtml(c.title));
  title.ondblclick = (e) => {
    e.stopPropagation();
    startRename(item, title, c);
  };
  main.append(title);
  const preview = stripMd(c.preview);
  // Skip a preview that merely repeats the title (single-turn chats, where the
  // last message ≈ the first user turn the title was derived from) — the item
  // collapses to a clean single line instead of showing the same text twice.
  const norm = (s) => (s || "").toLowerCase().replace(/[…\s]+/g, " ").trim();
  const tclean = norm(c.title).replace(/…$/, "");
  const dup =
    norm(preview) === norm(c.title) ||
    (tclean.length >= 8 && norm(preview).startsWith(tclean));
  if (preview && !dup) main.append(el("div", "conv-preview", escapeHtml(preview)));
  item.append(main);
  const actions = el("div", "conv-actions");
  const ren = el("button", "conv-ren", ICON_EDIT);
  ren.type = "button";
  ren.title = t().editLabel;
  ren.onclick = (e) => {
    e.stopPropagation(); // rename in place, don't open the conversation
    startRename(item, title, c);
  };
  const del = el(
    "button",
    "conv-del",
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  );
  del.type = "button";
  del.title = t().deleteLabel;
  del.onclick = (e) => {
    e.stopPropagation();
    deleteConversation(c.id);
  };
  actions.append(ren, del);
  item.append(actions);
  item.onclick = () => openConversation(c.id);
  return item;
}

// Inline rename: swap the title for an input (double-click), save on Enter/blur,
// cancel on Escape — replaces the old blocking prompt().
function startRename(item, titleEl, c) {
  if (item.querySelector(".conv-rename")) return;
  const input = el("input", "conv-rename");
  input.value = c.title;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    input.replaceWith(titleEl); // drop the input first, or the re-render guard blocks the refresh
    if (save && val && val !== c.title) {
      try {
        await fetch("/api/conversations/" + c.id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: val }),
        });
      } catch {
        /* best-effort */
      }
      if (c.id === S.conversationId) setHeaderTitle(val);
    }
    loadConversations();
  };
  input.onclick = (e) => e.stopPropagation(); // don't open the conversation while editing
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };
  input.onblur = () => finish(true);
}

export async function openConversation(id) {
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
  // Restore the agent/workflow this conversation was produced with; its voice (or
  // the saved mode, when there was neither) drives the effective voice.
  restoreSelection(conv.agent || "", conv.workflow || "", conv.mode || "business");
  clearMessages();
  hideEmpty();
  conv.messages.forEach((m) => {
    if (m.role === "user") {
      addUser(m.content, m.scope);
      S.history.push({ role: "user", content: m.content });
    } else {
      addAssistant(m.content, m.steps || null, false, m.sources || null);
      S.history.push({ role: "assistant", content: m.content });
    }
  });
  if (conv.messages.length) lockAgent(); // a saved conversation is fixed to its agent frame
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
  // Deleting drops the whole thread + history — confirm first (no undo).
  const ok = await askConfirm({
    title: t().deleteConvTitle,
    message: t().deleteConvMsg,
    ok: t().deleteLabel,
    cancel: t().cancelLabel,
    danger: true,
  });
  if (!ok) return;
  try {
    await fetch("/api/conversations/" + id, { method: "DELETE" });
  } catch {
    return;
  }
  if (id === S.conversationId) newChat();
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
  unlockAgent(); // a fresh chat can pick a different agent (keeps the current choice)
  showEmpty();
  setHeaderTitle(null);
  loadConversations();
  $("input").focus();
}
