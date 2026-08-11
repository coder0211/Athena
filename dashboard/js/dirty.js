// Shared unsaved-changes tracker. Each editor (repos, mcp, workspace) reports
// its dirty state by key; while any key is dirty, a beforeunload guard warns the
// user before a reload/close would discard their edits. Panels are in-page tabs
// (the DOM persists across tab switches), so the only real loss is unload.
const dirtySet = new Set();

export function setDirty(key, on = true) {
  const was = dirtySet.size;
  if (on) dirtySet.add(key);
  else dirtySet.delete(key);
  // Toggle a "unsaved" dot on any Save control opted-in via data-dirty-for.
  document
    .querySelectorAll(`[data-dirty-for="${key}"]`)
    .forEach((el) => el.classList.toggle("is-dirty", on));
  return was !== dirtySet.size;
}

export function isDirty(key) {
  return key ? dirtySet.has(key) : dirtySet.size > 0;
}

window.addEventListener("beforeunload", (e) => {
  if (!dirtySet.size) return;
  e.preventDefault();
  e.returnValue = ""; // required for the native "leave site?" prompt in Chrome
});
