// Lightweight, dependency-free markdown + syntax highlight (works offline).
// formatAnswer handles fenced code, inline code, bold, and ```mermaid blocks
// (emitted as a container that mermaid.js later swaps for an SVG).
import { escapeHtml } from "./dom.js";

// One pass over already-escaped code: comments → strings → numbers → keywords.
// Ordering matters so we don't recolour inside comments/strings.
const CODE_KEYWORDS =
  "if|else|elif|for|while|return|function|fn|def|lambda|class|struct|enum|interface|" +
  "type|const|let|var|final|new|delete|import|from|export|module|package|use|mod|pub|" +
  "async|await|yield|try|catch|except|finally|throw|raise|switch|case|match|default|" +
  "break|continue|do|in|of|is|as|with|where|impl|extends|implements|super|this|self|" +
  "public|private|protected|static|abstract|void|null|nil|None|undefined|true|false|" +
  "True|False|and|or|not|int|float|double|bool|boolean|string|str|char|byte|long";
const CODE_TOKEN = new RegExp(
  "(\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)" + // 1: line/block comments
    "|(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)" + // 2: strings (quotes aren't HTML-escaped)
    "|\\b(\\d[\\d_]*(?:\\.\\d+)?)\\b" + // 3: numbers
    "|\\b(" +
    CODE_KEYWORDS +
    ")\\b", // 4: keywords
  "g",
);

export function highlightCode(raw) {
  return escapeHtml(raw).replace(CODE_TOKEN, (m, comment, str, num, kw) => {
    if (comment) return `<span class="tok-comment">${comment}</span>`;
    if (str) return `<span class="tok-string">${str}</span>`;
    if (num) return `<span class="tok-number">${num}</span>`;
    if (kw) return `<span class="tok-keyword">${kw}</span>`;
    return m;
  });
}

export function formatAnswer(text) {
  const parts = String(text).split(/```/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const lang = (part.match(/^(\w+)\r?\n/) || ["", ""])[1].toLowerCase();
        const body = part.replace(/^\w*\r?\n/, ""); // drop the ```lang line
        if (lang === "mermaid") {
          // Keep the raw source as the code's textContent — renderMermaid()
          // reads it back and swaps in an SVG once the lib is loaded. If the
          // lib can't load (offline), this source view stays as the fallback.
          return `<div class="mermaid-block"><pre class="mermaid-src"><code>${escapeHtml(body)}</code></pre></div>`;
        }
        return `<pre><code>${highlightCode(body)}</code></pre>`;
      }
      return escapeHtml(part)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
    })
    .join("");
}
