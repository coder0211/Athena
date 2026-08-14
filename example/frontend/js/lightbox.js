// Fullscreen viewer for rendered diagrams and answer images: shows an SVG diagram
// or an <img> (e.g. a QuickChart chart) at full size in a scrollable overlay (so
// content larger than the bubble is no longer clipped), with a download action.
// Closes on Esc or backdrop click.
import { $, escapeHtml } from "./dom.js";

let wired = false;
let currentSvg = ""; // set for SVG diagrams; "" when showing a raster image
let currentImg = ""; // set to the image URL when showing an <img>

function wire() {
  if (wired) return;
  wired = true;
  $("lightbox-close").onclick = close;
  $("lightbox-backdrop").onclick = close;
  $("lightbox-download").onclick = download;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("lightbox").hidden) close();
  });
}

export function openLightbox(svg) {
  wire();
  currentSvg = svg;
  currentImg = "";
  $("lightbox-body").innerHTML = svg;
  show();
}

// Open a raster image (chart) full-size. Download opens it in a new tab, since a
// cross-origin URL can't be forced to save via an anchor's download attribute.
export function openImageLightbox(src, alt = "") {
  wire();
  currentSvg = "";
  currentImg = src;
  $("lightbox-body").innerHTML = `<img class="lightbox-img" src="${src}" alt="${escapeHtml(alt)}">`;
  show();
}

function show() {
  $("lightbox").hidden = false;
  document.body.classList.add("panel-open");
  $("lightbox-close").focus();
}

export function close() {
  $("lightbox").hidden = true;
  $("lightbox-body").innerHTML = "";
  document.body.classList.remove("panel-open");
}

function download() {
  if (currentImg) {
    window.open(currentImg, "_blank", "noopener");
    return;
  }
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
