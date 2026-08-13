// Tiny DOM helpers + inline SVG icons shared across the chat modules.
export const $ = (id) => document.getElementById(id);

export const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

export const escapeHtml = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// Themed confirmation dialog → Promise<boolean>. `danger` makes the confirm
// button a prominent solid red (destructive actions). Backdrop click / Esc / the
// dialog's cancel event all resolve false, so it's never a dead end.
export function askConfirm({ title, message = "", ok = "OK", cancel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const dlg = el("dialog", "modal");
    dlg.innerHTML =
      `<div class="modal-card">` +
      `<h3 class="modal-title"></h3>` +
      (message ? `<p class="modal-msg"></p>` : "") +
      `<div class="modal-actions">` +
      `<button type="button" class="btn small" data-act="cancel"></button>` +
      `<button type="button" class="btn small ${danger ? "danger" : "primary"}" data-act="ok"></button>` +
      `</div></div>`;
    dlg.querySelector(".modal-title").textContent = title;
    if (message) dlg.querySelector(".modal-msg").textContent = message;
    dlg.querySelector('[data-act="ok"]').textContent = ok;
    dlg.querySelector('[data-act="cancel"]').textContent = cancel;

    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
      dlg.close();
      dlg.remove();
    };
    dlg.querySelector('[data-act="ok"]').onclick = () => finish(true);
    dlg.querySelector('[data-act="cancel"]').onclick = () => finish(false);
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) finish(false);
    });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('[data-act="cancel"]').focus(); // default to the safe action
  });
}

export function scrollDown() {
  const m = $("messages");
  if (m) m.scrollTop = m.scrollHeight;
}

// True when the message list is scrolled at (or near) the bottom. Used to keep
// streaming "sticky" without yanking the user down while they read older text.
export function nearBottom(threshold = 90) {
  const m = $("messages");
  return !m || m.scrollHeight - m.scrollTop - m.clientHeight < threshold;
}

export const ICON_COPY =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
export const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
export const ICON_REGEN =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
export const ICON_STOP =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
export const ICON_FOLLOWUP =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
export const ICON_CHEVRON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
export const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
export const ICON_EDIT =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
export const ICON_ZOOM =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
export const ICON_EXTERNAL =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
