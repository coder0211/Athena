// Rendering of the message stream: user/assistant bubbles, the answer footer
// (tools used + copy/regenerate), the typing indicator, and the empty/welcome
// state with its starter suggestions.
import { $, el, escapeHtml, scrollDown, ICON_COPY, ICON_CHECK, ICON_TOOL, ICON_REGEN } from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";
import { formatAnswer } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import { copyText } from "./clipboard.js";
import { send, regenerate } from "./composer.js";

// --- empty / welcome state ---
export function hideEmpty() {
  const e = $("empty");
  if (e) e.hidden = true; // hide (not remove) so New chat can bring it back
}
export function showEmpty() {
  const e = $("empty");
  if (e) {
    e.hidden = false;
    renderEmpty();
  }
}
export function clearMessages() {
  // Remove only the message rows, keeping the (hidden) welcome block intact.
  $("messages")
    .querySelectorAll(".chat-msg")
    .forEach((r) => r.remove());
}
export function renderEmpty() {
  const e = $("empty");
  if (!e) return; // gone once the conversation starts
  const s = t();
  const c = s.copy[S.mode] || s.copy.business;
  e.querySelector("h2").textContent = c.title;
  e.querySelector("p").textContent = c.desc;
  e.querySelector(".chat-empty-tip").innerHTML = s.tip;
  const box = $("suggestions");
  box.innerHTML = "";
  c.suggestions.forEach((q) => {
    const chip = el("button", "suggestion", escapeHtml(q));
    chip.type = "button";
    chip.onclick = () => send(q);
    box.append(chip);
  });
}

// --- message bubbles ---
export function addUser(text, scope) {
  const row = el("div", "chat-msg user");
  const bubble = el("div", "bubble");
  const docs = (scope && scope.docs) || [];
  const folders = (scope && scope.folders) || [];
  if (scope && (scope.repos.length || scope.symbols.length || docs.length || folders.length)) {
    const tags = el("div", "msg-scope");
    scope.repos.forEach((r) => tags.append(el("span", "mtag", "@" + r)));
    scope.symbols.forEach((s) => tags.append(el("span", "mtag", "#" + s.name)));
    folders.forEach((f) => tags.append(el("span", "mtag doc", "📁 " + f.label)));
    docs.forEach((d) => tags.append(el("span", "mtag doc", "📄 " + d.name)));
    bubble.append(tags);
  }
  bubble.append(el("div", "msg-text", escapeHtml(text)));
  row.append(bubble);
  $("messages").append(row);
  scrollDown();
}

export function addAssistant(text, steps, isError) {
  const row = el("div", "chat-msg assistant");
  const bubble = el("div", "bubble" + (isError ? " error" : ""), formatAnswer(text));
  row.append(bubble);
  if (!isError) {
    renderMermaid(bubble);
    row.append(buildFooter(text, steps));
  }
  $("messages").append(row);
  scrollDown();
  if (!isError) pruneRegen(); // show regenerate only on this (now latest) answer
}

// Footer under an answer: document sources (top), then tools used (left) +
// actions regenerate/copy (right).
export function buildFooter(text, steps, sources) {
  const foot = el("div", "msg-foot");
  const srcRow = buildSources(sources);
  if (srcRow) foot.append(srcRow);
  if (steps?.length) {
    const tools = [...new Set(steps.map((s) => s.tool))];
    const box = el("div", "tools");
    box.append(el("span", "tools-ic", ICON_TOOL));
    tools.forEach((name) => box.append(el("span", "tool-chip", escapeHtml(name))));
    foot.append(box);
  }
  const actions = el("div", "msg-actions");
  actions.append(regenButton());
  actions.append(copyButton(text)); // copy the raw answer, not the rendered HTML
  foot.append(actions);
  return foot;
}

// The "📄 Nguồn:" row — one chip per document passage the answer was drawn from,
// labelled "Document › Section". Tooltip shows the file path.
function buildSources(sources) {
  if (!sources?.length) return null;
  const row = el("div", "sources");
  row.append(el("span", "sources-label", "📄 " + t().sourcesLabel));
  sources.forEach((s) => {
    const doc = s.document || s.path || "document";
    const sec = s.title || s.locator;
    const chip = el("span", "source-chip", escapeHtml(doc) + (sec ? ` › ${escapeHtml(sec)}` : ""));
    chip.title = [s.path, s.locator].filter(Boolean).join(" — ") || doc;
    row.append(chip);
  });
  return row;
}

function copyButton(text) {
  const btn = el("button", "act-btn copy-btn");
  btn.type = "button";
  const setState = (copied) => {
    btn.innerHTML = (copied ? ICON_CHECK : ICON_COPY) + `<span>${copied ? t().copiedLabel : t().copyLabel}</span>`;
    btn.title = copied ? t().copiedLabel : t().copyLabel;
    btn.classList.toggle("done", copied);
  };
  setState(false);
  btn.onclick = async () => {
    const ok = await copyText(text);
    if (!ok) return;
    setState(true);
    setTimeout(() => setState(false), 1500);
  };
  return btn;
}

function regenButton() {
  const btn = el("button", "act-btn regen-btn", ICON_REGEN + `<span>${t().regenLabel}</span>`);
  btn.type = "button";
  btn.title = t().regenLabel;
  btn.onclick = () => regenerate();
  return btn;
}

// Keep the regenerate button only on the most recent answer.
export function pruneRegen() {
  const rows = [...$("messages").querySelectorAll(".chat-msg.assistant:not(.typing)")];
  rows.forEach((row, i) => {
    const btn = row.querySelector(".regen-btn");
    if (btn) btn.style.display = i === rows.length - 1 ? "" : "none";
  });
}

// --- typing indicator ---
export function addTyping() {
  const row = el("div", "chat-msg assistant typing");
  const bubble = el("div", "bubble typing-bubble");
  bubble.append(el("span", "typing-status", t().status.thinking));
  bubble.append(
    el("span", "typing-dots", '<span class="dot"></span><span class="dot"></span><span class="dot"></span>'),
  );
  row.append(bubble);
  $("messages").append(row);
  scrollDown();
  return row;
}
export function setTypingStatus(row, text) {
  const s = row?.querySelector(".typing-status");
  if (s) s.textContent = text;
}
