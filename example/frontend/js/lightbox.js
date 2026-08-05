// Fullscreen viewer for rendered diagrams: shows the SVG at full size in a
// scrollable overlay (so a large flowchart/sequence diagram is no longer clipped
// by the bubble), with a download-as-SVG action. Closes on Esc or backdrop click.
import { $ } from "./dom.js";

let wired = false;
let currentSvg = "";

function wire() {
  if (wired) return;
  wired = true;
  $("lightbox-close").onclick = close;
  $("lightbox-backdrop").onclick = close;
  $("lightbox-download").onclick = downloadSvg;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("lightbox").hidden) close();
  });
}

export function openLightbox(svg) {
  wire();
  currentSvg = svg;
  $("lightbox-body").innerHTML = svg;
  $("lightbox").hidden = false;
  document.body.classList.add("panel-open");
  $("lightbox-close").focus();
}

export function close() {
  $("lightbox").hidden = true;
  $("lightbox-body").innerHTML = "";
  document.body.classList.remove("panel-open");
}

function downloadSvg() {
  if (!currentSvg) return;
  const blob = new Blob([currentSvg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "diagram.svg";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
