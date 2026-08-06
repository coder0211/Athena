// Tiny DOM helpers shared across the dashboard modules.
export const $ = (id) => document.getElementById(id);

export const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

export function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// Themed confirmation dialog — returns Promise<boolean>. `danger` reddens the
// confirm button for destructive actions (delete).
export function askConfirm({ title, message = "", ok = "OK", danger = false }) {
  return new Promise((resolve) => {
    const dlg = el("dialog", "modal");
    dlg.innerHTML =
      `<div class="modal-card">` +
      `<h3 class="modal-title"></h3>` +
      (message ? `<p class="modal-msg"></p>` : "") +
      `<div class="modal-actions">` +
      `<button type="button" class="btn small" data-act="cancel">Cancel</button>` +
      `<button type="button" class="btn small ${danger ? "danger" : "primary"}" data-act="ok"></button>` +
      `</div></div>`;
    dlg.querySelector(".modal-title").textContent = title;
    if (message) dlg.querySelector(".modal-msg").textContent = message;
    dlg.querySelector('[data-act="ok"]').textContent = ok;

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
    dlg.querySelector('[data-act="ok"]').focus();
  });
}
