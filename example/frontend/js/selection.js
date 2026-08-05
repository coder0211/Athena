// "Ask about this": when the user selects text inside an answer, a small floating
// button appears; clicking it asks a follow-up scoped to that passage.
import { el, escapeHtml } from "./dom.js";
import { t } from "./i18n.js";
import { send } from "./composer.js";

let btn = null;

function ensureBtn() {
  if (btn) return btn;
  btn = el("button", "sel-ask");
  btn.type = "button";
  btn.hidden = true;
  // Keep the text selection alive when pressing the button.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  document.body.append(btn);
  return btn;
}

function selectionInAnswer() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  if (text.length < 3) return null;
  const node = sel.anchorNode;
  const startEl = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!startEl || !startEl.closest(".chat-msg.assistant .bubble")) return null;
  return { text, rect: sel.getRangeAt(0).getBoundingClientRect() };
}

function place(rect) {
  const b = ensureBtn();
  b.textContent = t().askAboutThis;
  b.hidden = false;
  const bw = b.offsetWidth || 130;
  const x = Math.max(8, Math.min(rect.left + rect.width / 2 - bw / 2, window.innerWidth - bw - 8));
  const y = rect.top - 40 < 8 ? rect.bottom + 8 : rect.top - 40;
  b.style.left = `${x}px`;
  b.style.top = `${y}px`;
}

function hide() {
  if (btn) btn.hidden = true;
}

function refresh() {
  const s = selectionInAnswer();
  if (!s) return hide();
  place(s.rect);
  btn.onclick = () => {
    const passage = s.text.length > 300 ? s.text.slice(0, 300) + "…" : s.text;
    hide();
    window.getSelection()?.removeAllRanges();
    send(`${t().askAboutThis}: "${passage}"`);
  };
}

export function initSelectionAsk() {
  ensureBtn();
  // Re-evaluate after the gesture that ends a drag-select (mouse or touch),
  // deferred so the selection is finalized; hide on scroll or an empty selection.
  document.addEventListener("mouseup", () => setTimeout(refresh, 0));
  document.addEventListener("touchend", () => setTimeout(refresh, 0));
  document.addEventListener("selectionchange", () => {
    if (window.getSelection()?.isCollapsed) hide();
  });
  document.addEventListener("scroll", hide, true);
}
