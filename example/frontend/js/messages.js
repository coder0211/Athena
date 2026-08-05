// Rendering of the message stream: user/assistant bubbles, the answer footer
// (tools used + copy/regenerate), the typing indicator, and the empty/welcome
// state with its starter suggestions.
import {
  $,
  el,
  escapeHtml,
  scrollDown,
  ICON_COPY,
  ICON_CHECK,
  ICON_REGEN,
  ICON_EDIT,
  ICON_EXTERNAL,
  ICON_FOLLOWUP,
} from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";
import { formatAnswer } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import { enhanceCodeBlocks } from "./codeblocks.js";
import { enhanceCodeRefs } from "./codeviewer.js";
import { staticTrace } from "./trace.js";
import { openSource } from "./sourceviewer.js";
import { copyText } from "./clipboard.js";
import { showToast } from "./toast.js";
import { send, regenerate, editResend } from "./composer.js";

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
  // Built-in types (business/technical) have rich, localized welcome copy;
  // a custom type uses its own label + generated greeting/suggestions, falling
  // back to the business copy so the screen is never empty.
  const builtin = s.copy[S.mode];
  const persona = (S.PERSONAS || []).find((p) => p.id === S.mode);
  const title = builtin?.title || persona?.label || s.copy.business.title;
  const desc = builtin?.desc || persona?.greeting || persona?.description || s.copy.business.desc;
  const suggestions =
    builtin?.suggestions ||
    (persona?.suggestions?.length ? persona.suggestions : s.copy.business.suggestions);
  e.querySelector("h2").textContent = title;
  e.querySelector("p").textContent = desc;
  e.querySelector(".chat-empty-tip").innerHTML = s.tip;
  const box = $("suggestions");
  box.innerHTML = "";
  suggestions.forEach((q) => {
    const chip = el("button", "suggestion", escapeHtml(q));
    chip.type = "button";
    chip.onclick = () => send(q);
    box.append(chip);
  });
  // Starters built from the actually-indexed repos, so the first run is relevant
  // to this codebase rather than the generic ticket examples.
  (S.REPOS || []).slice(0, 4).forEach((repo) => {
    const name = shortRepoName(repo);
    const q = s.repoStarter.replace("{repo}", name);
    const chip = el("button", "suggestion suggestion-repo", "📦 " + escapeHtml(q));
    chip.type = "button";
    chip.onclick = () => send(q);
    box.append(chip);
  });
}

// A short, human repo name from an indexed repo id (often a full git URL).
function shortRepoName(repo) {
  return String(repo)
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(Boolean)
    .pop();
}

// --- message bubbles ---
export function addUser(text, scope) {
  const row = el("div", "chat-msg user");
  const bubble = el("div", "bubble");
  const docs = (scope && scope.docs) || [];
  const folders = (scope && scope.folders) || [];
  const tools = (scope && scope.tools) || [];
  if (
    scope &&
    (scope.repos.length || scope.symbols.length || docs.length || folders.length || tools.length)
  ) {
    const tags = el("div", "msg-scope");
    scope.repos.forEach((r) => tags.append(el("span", "mtag", "/" + r)));
    scope.symbols.forEach((s) => tags.append(el("span", "mtag", "#" + s.name)));
    folders.forEach((f) => tags.append(el("span", "mtag doc", "📁 " + f.label)));
    docs.forEach((d) => tags.append(el("span", "mtag doc", "📄 " + d.name)));
    tools.forEach((t) => tags.append(el("span", "mtag tool", "@" + t.label)));
    bubble.append(tags);
  }
  const textEl = el("div", "msg-text", escapeHtml(text));
  bubble.append(textEl);
  // Edit affordance — pruned to the latest user turn (see pruneEdit), since only
  // that turn can be re-asked without desyncing the stored history.
  const edit = el("button", "msg-edit", ICON_EDIT);
  edit.type = "button";
  edit.title = t().editLabel;
  edit.setAttribute("aria-label", t().editLabel);
  edit.onclick = () => startUserEdit(textEl);
  row.append(edit, bubble);
  $("messages").append(row);
  pruneEdit();
  scrollDown();
}

export function addAssistant(text, steps, isError, sources) {
  const row = el("div", "chat-msg assistant");
  if (!isError) {
    const tr = staticTrace(steps); // collapsed "Looked at N steps" from stored steps
    if (tr) row.append(tr);
  }
  const bubble = el("div", "bubble" + (isError ? " error" : ""), formatAnswer(text));
  row.append(bubble);
  if (!isError) {
    enhanceCodeBlocks(bubble);
    enhanceCodeRefs(bubble); // make cited symbols open the code panel
    renderMermaid(bubble);
    row.append(buildFooter(text, steps, sources)); // restores clickable citations on reload
    row.append(refineRow());
  } else if (S.lastRequest) {
    row.append(retryFooter()); // let the user re-run the failed question
  }
  $("messages").append(row);
  scrollDown();
  if (!isError) {
    pruneRegen(); // show regenerate only on this (now latest) answer
    pruneRefine();
  }
}

// Inline-edit a user turn: swap the text for a textarea; Save re-asks with the
// edited question (see editResend). Only wired on the latest user turn.
function startUserEdit(textEl) {
  if (S.busy || textEl.parentElement.querySelector(".edit-box")) return;
  const box = el("div", "edit-box");
  const ta = el("textarea", "edit-ta");
  ta.value = textEl.textContent;
  const acts = el("div", "edit-acts");
  const cancel = el("button", "btn small", escapeHtml(t().cancelLabel));
  cancel.type = "button";
  const save = el("button", "btn small primary", escapeHtml(t().saveLabel));
  save.type = "button";
  acts.append(cancel, save);
  box.append(ta, acts);
  textEl.style.display = "none";
  textEl.after(box);
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };
  grow();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const done = () => {
    box.remove();
    textEl.style.display = "";
  };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return done();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save.click();
    }
  });
  cancel.onclick = done;
  save.onclick = () => {
    const v = ta.value.trim();
    if (!v) return;
    done();
    editResend(v);
  };
}

// Keep the edit button only on the most recent user turn.
export function pruneEdit() {
  const rows = [...$("messages").querySelectorAll(".chat-msg.user")];
  rows.forEach((row, i) => {
    const btn = row.querySelector(".msg-edit");
    if (btn) btn.style.display = i === rows.length - 1 ? "" : "none";
  });
}

// Footer under an answer: document sources (top) + actions regenerate/copy
// (right). The tools Athena used are shown in the collapsible trace above the
// answer, so they're no longer duplicated here.
export function buildFooter(text, steps, sources) {
  const foot = el("div", "msg-foot");
  const srcRow = buildSources(sources);
  if (srcRow) foot.append(srcRow);
  const actions = el("div", "msg-actions");
  actions.append(regenButton());
  actions.append(copyButton(text)); // copy the raw answer, not the rendered HTML
  foot.append(actions);
  return foot;
}

// Suggested follow-up questions under an answer — one-tap chips that ask the
// question straight away. Rendered only on the latest answer (see pruneFollowups).
export function renderFollowups(questions) {
  if (!questions?.length) return null;
  const box = el("div", "followups");
  const head = el("div", "followups-head", ICON_FOLLOWUP);
  head.append(el("span", "followups-label", escapeHtml(t().followupsLabel)));
  box.append(head);
  const chips = el("div", "followup-chips");
  questions.forEach((q) => {
    const chip = el("button", "followup-chip", escapeHtml(q));
    chip.type = "button";
    chip.onclick = () => {
      box.remove(); // the suggestions are consumed — hide them the moment one is picked
      send(q);
    };
    chips.append(chip);
  });
  box.append(chips);
  return box;
}

// One-tap refinements under an answer: re-ask with a modifier (shorter / simpler
// / more technical / example) as a normal follow-up turn, using conversation
// context. Shown only on the latest answer (see pruneRefine).
export function refineRow() {
  const s = t().refine;
  const row = el("div", "refine-row");
  row.append(el("span", "refine-label", escapeHtml(s.label)));
  [
    ["shorter", s.shorter],
    ["simpler", s.simpler],
    ["deeper", s.deeper],
    ["example", s.example],
  ].forEach(([key, label]) => {
    const chip = el("button", "refine-chip", escapeHtml(label));
    chip.type = "button";
    chip.onclick = () => send(t().refinePrompt[key]);
    row.append(chip);
  });
  return row;
}

// Keep the refine row only on the most recent answer.
export function pruneRefine() {
  const rows = [...$("messages").querySelectorAll(".chat-msg.assistant:not(.typing)")];
  rows.forEach((row, i) => {
    const r = row.querySelector(".refine-row");
    if (r) r.style.display = i === rows.length - 1 ? "" : "none";
  });
}

// Keep follow-up chips only on the most recent answer — older ones are stale
// once the conversation has moved on.
export function pruneFollowups() {
  const boxes = [...$("messages").querySelectorAll(".followups")];
  boxes.slice(0, -1).forEach((b) => b.remove());
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
    // Clickable → opens the full passage in the source viewer. Without a section
    // id there's nothing to open, so it stays a plain (non-interactive) chip.
    const chip = el(
      s.id ? "button" : "span",
      "source-chip" + (s.id ? " linked" : ""),
      escapeHtml(doc) + (sec ? ` › ${escapeHtml(sec)}` : "") + (s.id ? ICON_EXTERNAL : ""),
    );
    chip.title = [s.path, s.locator].filter(Boolean).join(" — ") || doc;
    if (s.id) {
      chip.type = "button";
      chip.onclick = () => openSource(s);
    }
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
    showToast(t().copiedToast);
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

// Footer shown under an error bubble: a single Retry action that re-runs the
// last question (regenerate() drops the error bubble and re-asks).
function retryFooter() {
  const foot = el("div", "msg-foot");
  const actions = el("div", "msg-actions");
  const btn = el("button", "act-btn regen-btn", ICON_REGEN + `<span>${t().retryLabel}</span>`);
  btn.type = "button";
  btn.title = t().retryLabel;
  btn.onclick = () => regenerate();
  actions.append(btn);
  foot.append(actions);
  return foot;
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
