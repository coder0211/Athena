// Entry point: wires DOM events and boots the chat. Loaded as an ES module
// (<script type="module">), so it runs after the document is parsed.
import { $ } from "./dom.js";
import { S } from "./state.js";
import { apiGet } from "./api.js";
import { t } from "./i18n.js";
import { renderEmpty } from "./messages.js";
import { applyModeTheme, setHeaderTitle } from "./mode.js";
import { renderScope } from "./scope.js";
import { loadConversations, newChat } from "./conversations.js";
import { send, autoGrow } from "./composer.js";
import { detectMention, updateMentions, closeMentions, pickMention } from "./mentions.js";

// --- composer: auto-grow textarea, mentions, Enter to send ---
let mentionTimer = null;
$("input").addEventListener("input", () => {
  autoGrow();
  detectMention();
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(updateMentions, S.mention && S.mention.type === "#" ? 180 : 0);
});
$("input").addEventListener("blur", () => setTimeout(closeMentions, 150));
$("input").addEventListener("keydown", (e) => {
  const open = !$("mention-list").hidden && S.mentionItems.length;
  if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    S.mentionActive = (S.mentionActive + (e.key === "ArrowDown" ? 1 : -1) + S.mentionItems.length) % S.mentionItems.length;
    [...$("mention-list").querySelectorAll(".mention-item")].forEach((c, i) =>
      c.classList.toggle("active", i === S.mentionActive),
    );
    return;
  }
  if (open && (e.key === "Enter" || e.key === "Tab")) {
    e.preventDefault();
    pickMention(S.mentionItems[S.mentionActive]);
    return;
  }
  if (e.key === "Escape") return closeMentions();
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send($("input").value);
  }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("input").value);
});
$("sb-new").onclick = newChat;
$("sb-toggle").onclick = () => $("sidebar").classList.toggle("collapsed");

// --- Business ⇄ Technical mode toggle ---
applyModeTheme();
document.querySelectorAll(".mode-btn").forEach((b) => {
  b.classList.toggle("active", b.dataset.mode === S.mode);
  b.onclick = () => {
    if (S.modeLocked) return;
    S.mode = b.dataset.mode;
    localStorage.setItem("athena_mode", S.mode);
    document.querySelectorAll(".mode-btn").forEach((x) => x.classList.toggle("active", x === b));
    applyModeTheme();
    renderEmpty(); // refresh the welcome copy + suggestions for the new mode
  };
});

// --- response language: whole UI follows the choice ---
$("lang-select").value = S.lang;
$("lang-select").onchange = () => {
  S.lang = $("lang-select").value;
  localStorage.setItem("athena_lang", S.lang);
  applyLang();
};

// Re-skin all static chrome for the current language.
function applyLang() {
  document.documentElement.lang = S.lang;
  const s = t();
  document.querySelectorAll(".mode-btn").forEach((b) => (b.textContent = s[b.dataset.mode]));
  $("sb-new").textContent = "+ " + s.newChat;
  if (!S.conversationId) setHeaderTitle(null); // keep the default label localized
  $("send").textContent = s.send;
  $("input").placeholder = s.placeholder;
  if (S.modeLocked) $("mode-toggle").title = s.modeLocked;
  renderEmpty();
  loadConversations(); // re-skin the empty-state / labels in the sidebar
}

function showBanner(msg) {
  const b = $("banner");
  b.textContent = msg;
  b.hidden = false;
}

async function init() {
  try {
    const s = await apiGet("/api/status");
    S.REPOS = Object.keys((s.graph && s.graph.by_repo) || {}).sort();
    if (!s.built) {
      showBanner(t().bannerNotBuilt);
    } else if (!s.ask_available) {
      showBanner(t().bannerAskOff);
    }
  } catch {
    showBanner(t().bannerUnreachable);
  }
  try {
    const ws = await apiGet("/api/workspace"); // repo descriptions for @ hints
    if (ws.repos_available?.length) S.REPOS = ws.repos_available;
    S.REPO_META = ws.repos || {};
  } catch {
    /* workspace optional */
  }
  renderScope();
  applyLang();
  loadConversations(); // populate the history sidebar
  $("input").focus();
}

init();
