// Mermaid diagrams: lazy-loaded from CDN only when a diagram actually appears.
// If the CDN is unreachable (offline), the ```mermaid source stays visible as
// the fallback (see markdown.js).
import { $, el, scrollDown, ICON_COPY, ICON_CHECK, ICON_ZOOM } from "./dom.js";
import { t } from "./i18n.js";
import { copyText } from "./clipboard.js";
import { openLightbox } from "./lightbox.js";
import { showToast } from "./toast.js";

let mermaidLoading = null;

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoading) return mermaidLoading;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  mermaidLoading = import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs").then((mod) => {
    const mermaid = mod.default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
    window.mermaid = mermaid;
    return mermaid;
  });
  return mermaidLoading;
}

// Render any not-yet-rendered mermaid blocks inside `scope` (an element).
export async function renderMermaid(scope) {
  const blocks = scope.querySelectorAll(".mermaid-block:not([data-rendered])");
  if (!blocks.length) return;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return; // CDN unreachable — leave the source fallback in place
  }
  for (const block of blocks) {
    block.setAttribute("data-rendered", "1"); // guard against double render
    const src = (block.querySelector("code")?.textContent || "").trim();
    if (!src) continue;
    try {
      const { svg } = await mermaid.render("mmd-" + Math.random().toString(36).slice(2), src);
      block.innerHTML = svg;
      // Click the diagram (or the zoom button) to view it full-size — large
      // flowcharts/sequence diagrams would otherwise be clipped by the bubble.
      const rendered = block.querySelector("svg");
      if (rendered) {
        rendered.classList.add("mermaid-zoomable");
        rendered.addEventListener("click", () => openLightbox(svg));
      }
      block.append(mermaidZoomButton(svg), mermaidCopyButton(src));
    } catch {
      block.removeAttribute("data-rendered"); // invalid diagram → keep source visible
    }
  }
  scrollDown();
}

// Small corner button that copies a rendered diagram's mermaid source.
function mermaidCopyButton(src) {
  const btn = el("button", "mermaid-copy", ICON_COPY);
  btn.type = "button";
  btn.title = t().copyLabel;
  btn.setAttribute("aria-label", t().copyLabel);
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

// Corner button that opens the rendered diagram full-size in the lightbox.
function mermaidZoomButton(svg) {
  const btn = el("button", "mermaid-copy mermaid-zoom", ICON_ZOOM);
  btn.type = "button";
  btn.title = t().zoomLabel;
  btn.setAttribute("aria-label", t().zoomLabel);
  btn.onclick = () => openLightbox(svg);
  return btn;
}
