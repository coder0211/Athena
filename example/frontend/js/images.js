// Inline images in answers (e.g. QuickChart chart URLs — see markdown.js). Wraps
// each image in a block with corner actions (zoom / open URL / copy URL, mirroring
// the mermaid block) and a graceful fallback: if the image can't load (offline,
// quickchart.io unreachable, or a bad config URL) it's swapped for a plain link so
// the source is never lost — the same "source stays visible" principle the mermaid
// renderer follows.
import { el, ICON_COPY, ICON_CHECK, ICON_ZOOM, ICON_EXTERNAL } from "./dom.js";
import { t } from "./i18n.js";
import { openImageLightbox } from "./lightbox.js";
import { copyText } from "./clipboard.js";
import { showToast } from "./toast.js";

// Enhance any not-yet-enhanced answer images inside `scope` (an element).
export function enhanceImages(scope) {
  scope.querySelectorAll("img.md-img:not([data-enh])").forEach((img) => {
    img.setAttribute("data-enh", "1"); // guard against double-wiring on re-render
    img.classList.add("md-img-zoomable");
    const src = img.src;

    // Wrap so the corner buttons anchor to the image (mirrors .mermaid-block).
    const block = el("div", "md-img-block");
    img.replaceWith(block);
    block.append(img, zoomButton(src), openButton(src), copyButton(src));

    img.addEventListener("click", () => openImageLightbox(src, img.alt));
    img.addEventListener("error", () => {
      // Couldn't render — fall back to a plain link so the chart is still reachable.
      const fb = el("span", "md-img-fallback");
      const a = el("a", null, img.alt || src);
      a.href = src;
      a.target = "_blank";
      a.rel = "noopener";
      fb.append(a);
      block.replaceWith(fb);
    });
  });
}

// Corner button: open the diagram/chart full-size in the lightbox.
function zoomButton(src) {
  const btn = cornerButton("md-img-zoom", ICON_ZOOM, t().zoomLabel);
  btn.onclick = () => openImageLightbox(src, "");
  return btn;
}

// Corner button: open the raw image URL in a new tab.
function openButton(src) {
  const btn = cornerButton("md-img-open", ICON_EXTERNAL, t().openImageLabel);
  btn.onclick = () => window.open(src, "_blank", "noopener");
  return btn;
}

// Corner button: copy the image URL to the clipboard.
function copyButton(src) {
  const btn = cornerButton("md-img-copy", ICON_COPY, t().copyLabel);
  btn.onclick = async () => {
    if (!(await copyText(src))) return;
    showToast(t().copiedToast);
    btn.innerHTML = ICON_CHECK;
    btn.classList.add("done");
    setTimeout(() => {
      btn.innerHTML = ICON_COPY;
      btn.classList.remove("done");
    }, 1500);
  };
  return btn;
}

function cornerButton(cls, icon, label) {
  const btn = el("button", "md-img-btn " + cls, icon);
  btn.type = "button";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  return btn;
}
