// Code viewer: a slide-over that shows a cited symbol's real source code (via
// /api/source) plus its callers/callees as chips you can click to hop around the
// graph — turning a technical answer into a browsable code explorer. Reuses the
// document source-panel styling (.source-sheet/.source-body).
import { $, el, escapeHtml } from "./dom.js";
import { t } from "./i18n.js";
import { apiGet } from "./api.js";
import { highlightCode } from "./markdown.js";

let wired = false;
let lastFocus = null; // element focused before the panel opened, restored on close

function wire() {
  if (wired) return;
  wired = true;
  $("code-close").onclick = close;
  $("code-backdrop").onclick = close;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("code-panel").hidden) close();
  });
}

export function close() {
  $("code-panel").hidden = true;
  document.body.classList.remove("panel-open");
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

function show(headingHtml, bodyHtml) {
  const panel = $("code-panel");
  if (panel.hidden) lastFocus = document.activeElement; // remember only on first open
  $("code-heading").innerHTML = headingHtml;
  $("code-body").innerHTML = bodyHtml;
  panel.hidden = false;
  document.body.classList.add("panel-open");
  $("code-close").focus();
}

// Open a symbol by graph node id (used by caller/callee chips inside the panel).
export async function openCode(nodeId) {
  wire();
  show(
    `<div class="source-doc">${escapeHtml(t().sourceLoading)}</div>`,
    `<div class="source-loading">${escapeHtml(t().sourceLoading)}</div>`,
  );
  try {
    const d = await apiGet("/api/source/" + encodeURIComponent(nodeId));
    if (!d || d.error || !d.code) return fail();
    renderCode(d);
  } catch {
    fail();
  }
}

// Resolve a symbol name/identifier via search, then open the top hit. Used when a
// code reference in an answer is clicked (we only have the name, not the id).
export async function openCodeByName(name) {
  wire();
  show(
    `<div class="source-doc">${escapeHtml(name)}</div>`,
    `<div class="source-loading">${escapeHtml(t().sourceLoading)}</div>`,
  );
  const tries = [name];
  if (name.includes(".")) tries.push(name.split(".").pop()); // PaymentService.charge → charge
  for (const q of tries) {
    try {
      const rows = await apiGet("/api/search?compact=1&limit=1&q=" + encodeURIComponent(q));
      if (rows && rows.length && rows[0].id) return openCode(rows[0].id);
    } catch {
      /* try next */
    }
  }
  fail(name);
}

function fail(name) {
  $("code-heading").innerHTML = `<div class="source-doc">${escapeHtml(name || "")}</div>`;
  $("code-body").innerHTML = `<div class="source-error">${escapeHtml(t().codeNotFound)}</div>`;
}

function renderCode(d) {
  const node = d.node || {};
  const sub = [node.type, d.file, d.lines && `(${d.lines})`].filter(Boolean).join(" · ");
  $("code-heading").innerHTML =
    `<div class="source-doc">${escapeHtml(node.name || "symbol")}</div>` +
    (sub ? `<div class="source-sec">${escapeHtml(sub)}</div>` : "");
  const body = $("code-body");
  body.innerHTML = "";
  const pre = el("pre", "source-code");
  pre.innerHTML = `<code>${highlightCode(d.code || "")}</code>`; // code already carries line numbers
  body.append(pre);
  body.append(relSection(t().callersLabel, d.callers));
  body.append(relSection(t().calleesLabel, d.callees));
  body.scrollTop = 0;
}

// Make inline `code` spans that look like real symbols clickable → open the code
// panel. Runs on a finished answer (not while streaming, which re-renders). Biased
// toward code identifiers (has an uppercase letter or a _ . $) so prose in
// backticks isn't turned into a sea of links.
const looksLikeSymbol = (s) => /^[A-Za-z_$][\w.$]{2,}$/.test(s) && (/[A-Z]/.test(s) || /[_$.]/.test(s));

export function enhanceCodeRefs(scope) {
  scope.querySelectorAll("code:not([data-ref])").forEach((code) => {
    code.setAttribute("data-ref", "1");
    if (code.closest("pre")) return; // only inline code, not fenced blocks
    const txt = code.textContent.trim();
    if (!looksLikeSymbol(txt)) return;
    code.classList.add("code-ref");
    code.setAttribute("role", "button");
    code.tabIndex = 0;
    code.title = t().viewCodeLabel;
    code.addEventListener("click", () => openCodeByName(txt));
    code.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openCodeByName(txt);
      }
    });
  });
}

function relSection(label, list) {
  const items = (list || []).filter((x) => x && x.id && !x.error);
  const sec = el("div", "code-rel");
  if (!items.length) return sec;
  sec.append(el("div", "code-rel-label", escapeHtml(label)));
  const box = el("div", "code-rel-chips");
  items.forEach((x) => {
    const chip = el("button", "code-rel-chip", escapeHtml(x.name || x.id));
    chip.type = "button";
    chip.title = [x.relation, x.path].filter(Boolean).join(" · ");
    chip.onclick = () => openCode(x.id);
    box.append(chip);
  });
  sec.append(box);
  return sec;
}
