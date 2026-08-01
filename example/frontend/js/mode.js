// Business ⇄ Technical mode: reflects the mode on <body> so CSS can theme the
// composer + bubbles, and locks it once a conversation has started (each answer
// was produced in one mode). Also owns the header conversation title.
import { $ } from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";

export function applyModeTheme() {
  document.body.dataset.mode = S.mode;
}

// Switch mode + reflect it on the toggle buttons (used when opening a saved chat).
export function setMode(m) {
  S.mode = m;
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  applyModeTheme();
}

export function lockMode() {
  if (S.modeLocked) return;
  S.modeLocked = true;
  const tog = $("mode-toggle");
  tog.classList.add("locked");
  tog.title = t().modeLocked;
  document.querySelectorAll(".mode-btn").forEach((b) => (b.disabled = true));
}

export function unlockMode() {
  S.modeLocked = false;
  const tog = $("mode-toggle");
  tog.classList.remove("locked");
  tog.title = "";
  document.querySelectorAll(".mode-btn").forEach((b) => (b.disabled = false));
}

// Header shows which conversation is open (updates on open / new / first turn).
export function setHeaderTitle(text) {
  $("header-title").textContent = text || t().newChat;
}
