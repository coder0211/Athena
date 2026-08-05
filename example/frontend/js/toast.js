// Small transient toast for action feedback (copied, downloaded, …) and a
// screen-reader-only live region for status announcements.
import { $ } from "./dom.js";

let toastTimer = null;

export function showToast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  // restart the enter animation even if a toast is already showing
  t.classList.remove("show");
  void t.offsetWidth;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => (t.hidden = true), 200);
  }, 1800);
}

// Announce a status to assistive tech without any visible UI change.
export function announce(msg) {
  const s = $("sr-status");
  if (s) s.textContent = msg;
}
