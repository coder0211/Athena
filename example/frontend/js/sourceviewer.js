// Source viewer: a slide-over sheet that opens a cited document passage in full.
// Fetches /api/docs/section?id=<section_id> (proxied to the graph API's
// read_passage) and renders its text, so a source chip becomes a real link into
// the document the answer was drawn from.
import { $, el, escapeHtml } from "./dom.js";
import { t } from "./i18n.js";
import { apiGet } from "./api.js";

let wired = false;
let lastFocus = null; // element focused before the panel opened, to restore on close

function wire() {
  if (wired) return;
  wired = true;
  $("source-close").onclick = close;
  $("source-backdrop").onclick = close;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("source-panel").hidden) close();
  });
}

export function close() {
  $("source-panel").hidden = true;
  document.body.classList.remove("panel-open");
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

// Open the passage for a source ({id, document, path, title, locator}).
export async function openSource(src) {
  wire();
  const panel = $("source-panel");
  const heading = $("source-heading");
  const body = $("source-body");
  const doc = src.document || src.path || "Document";
  const sec = src.title || src.locator || "";
  heading.innerHTML =
    `<div class="source-doc">${escapeHtml(doc)}</div>` +
    (sec ? `<div class="source-sec">${escapeHtml(sec)}</div>` : "");
  body.innerHTML = `<div class="source-loading">${escapeHtml(t().sourceLoading)}</div>`;
  lastFocus = document.activeElement; // remember where focus was, to restore on close
  panel.hidden = false;
  document.body.classList.add("panel-open");
  $("source-close").focus();

  if (!src.id) {
    body.innerHTML = `<div class="source-error">${escapeHtml(t().sourceError)}</div>`;
    return;
  }
  try {
    const passage = await apiGet("/api/docs/section?id=" + encodeURIComponent(src.id));
    const text = (passage && passage.text) || "";
    if (!text.trim()) {
      body.innerHTML = `<div class="source-error">${escapeHtml(t().sourceError)}</div>`;
      return;
    }
    body.innerHTML = "";
    if (passage.path) {
      const meta = el("div", "source-path", escapeHtml(passage.path));
      body.append(meta);
    }
    body.append(el("pre", "source-text", escapeHtml(text)));
    body.scrollTop = 0;
  } catch {
    body.innerHTML = `<div class="source-error">${escapeHtml(t().sourceError)}</div>`;
  }
}
