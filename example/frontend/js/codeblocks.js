// Adds a hover "copy" button to every fenced code block in an answer, mirroring
// the mermaid diagram copy affordance. Each <pre> is wrapped in a positioned
// container so the button stays put while long lines scroll horizontally.
import { el, ICON_COPY, ICON_CHECK } from "./dom.js";
import { t } from "./i18n.js";
import { copyText } from "./clipboard.js";

export function enhanceCodeBlocks(scope) {
  scope.querySelectorAll("pre:not([data-cb])").forEach((pre) => {
    pre.setAttribute("data-cb", "1"); // guard against double-enhancing on re-render
    if (pre.classList.contains("mermaid-src")) return; // mermaid supplies its own button
    const src = pre.querySelector("code")?.textContent || "";
    if (!src.trim()) return;
    const wrap = el("div", "code-block");
    pre.replaceWith(wrap);
    wrap.append(pre, codeCopyButton(src));
  });
}

function codeCopyButton(src) {
  const btn = el("button", "code-copy", ICON_COPY);
  btn.type = "button";
  btn.title = t().copyLabel;
  btn.setAttribute("aria-label", t().copyLabel);
  btn.onclick = async () => {
    if (!(await copyText(src))) return;
    btn.innerHTML = ICON_CHECK;
    btn.classList.add("done");
    setTimeout(() => {
      btn.innerHTML = ICON_COPY;
      btn.classList.remove("done");
    }, 1500);
  };
  return btn;
}
