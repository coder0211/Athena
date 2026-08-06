// Panel resize: lets the right-hand slide-over sheets (.source-sheet — used by
// both the document source panel and the code panel) be dragged wider/narrower by
// a grip on their left edge. The chosen width is shared across both panels and
// persisted, so it survives navigation and reloads. Double-click the grip resets.
const KEY = "athena_panel_w";
const MIN = 320; // never let the sheet get uselessly narrow
const maxW = () => Math.max(MIN, Math.round(window.innerWidth * 0.95));

let cur = null; // current width in px, or null to fall back to the CSS default

function stored() {
  const v = parseInt(localStorage.getItem(KEY) || "", 10);
  return Number.isFinite(v) ? v : null;
}

function apply(px) {
  cur = Math.min(maxW(), Math.max(MIN, Math.round(px)));
  document.documentElement.style.setProperty("--panel-w", cur + "px");
}

function reset() {
  cur = null;
  document.documentElement.style.removeProperty("--panel-w");
  localStorage.removeItem(KEY);
}

function addGrip(sheet) {
  if (sheet.querySelector(".source-resizer")) return;
  const grip = document.createElement("div");
  grip.className = "source-resizer";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.title = "Drag to resize · double-click to reset";
  sheet.appendChild(grip);

  let startX = 0;
  let startW = 0;
  const onMove = (e) => apply(startW + (startX - e.clientX)); // drag left → wider
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.body.classList.remove("resizing-panel");
    if (cur != null) localStorage.setItem(KEY, String(cur));
  };
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = sheet.getBoundingClientRect().width;
    document.body.classList.add("resizing-panel");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
  grip.addEventListener("dblclick", reset);
}

export function initPanelResize() {
  const saved = stored();
  if (saved != null) apply(saved);
  document.querySelectorAll(".source-sheet").forEach(addGrip);
  // Re-clamp on viewport shrink so a wide saved width can't overflow the screen.
  window.addEventListener("resize", () => {
    if (cur != null) apply(cur);
  });
}
