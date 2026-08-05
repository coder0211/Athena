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
      return renderBlocks(part);
    })
    .join("");
}

// Inline markdown: escape, then `code`, [text](url) links, bare URLs, **bold**,
// *italic*, and ~~strikethrough~~. Links are resolved before the bare-URL pass so
// a URL already inside an <a href="…"> (preceded by ") isn't linkified twice.
function renderInline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_m, pre, url) => {
      // Trim trailing sentence punctuation so "see https://x." doesn't swallow the dot.
      const trail = (url.match(/[.,;:!?)]+$/) || [""])[0];
      const u = url.slice(0, url.length - trail.length);
      return `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>${trail}`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}

// Block-level markdown: ATX headings, horizontal rules, blockquotes, pipe
// tables, nested unordered/ordered lists, and paragraphs. Small and
// dependency-free; fenced code + mermaid are handled by the caller.
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const cellSplit = (row) =>
  row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function renderBlocks(text) {
  const lines = text.split(/\r?\n/);
  let html = "";
  const stack = []; // open lists, innermost last: {type:'ul'|'ol', delim, indent}
  let para = [];
  let quote = [];

  const flushPara = () => {
    if (para.length) {
      html += `<p>${para.map(renderInline).join("<br>")}</p>`;
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      html += `<blockquote>${quote.map(renderInline).join("<br>")}</blockquote>`;
      quote = [];
    }
  };
  const flushText = () => {
    flushPara();
    flushQuote();
  };
  // Close every open list nested deeper than `indent` (−1 closes them all).
  const closeLists = (indent = -1) => {
    while (stack.length && stack[stack.length - 1].indent > indent) {
      html += `</li></${stack.pop().type}>`;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    let m;

    // Pipe table: a row immediately followed by a |---|:--:| separator row.
    if (line.trim() && line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushText();
      closeLists();
      const head = cellSplit(line);
      let t = "<table><thead><tr>" + head.map((c) => `<th>${renderInline(c)}</th>`).join("") + "</tr></thead><tbody>";
      i += 1; // consume the separator row
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) {
        const row = cellSplit(lines[(i += 1)]);
        t += "<tr>" + head.map((_, j) => `<td>${renderInline(row[j] || "")}</td>`).join("") + "</tr>";
      }
      html += t + "</tbody></table>";
    } else if (!line.trim()) {
      flushText();
      closeLists();
    } else if ((m = line.match(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/))) {
      flushText();
      closeLists();
      html += "<hr>";
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushText();
      closeLists();
      html += `<h${m[1].length} class="md-h">${renderInline(m[2])}</h${m[1].length}>`;
    } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
      flushPara();
      closeLists();
      quote.push(m[1]);
    } else if (
      (m = line.match(/^(\s*)([-*])\s+(.*)$/)) ||
      (m = line.match(/^(\s*)(\d+)([.)])\s+(.*)$/))
    ) {
      flushText();
      const indent = m[1].replace(/\t/g, "  ").length;
      const ordered = /\d/.test(m[2]);
      const type = ordered ? "ol" : "ul";
      const delim = ordered ? m[3] : m[2];
      const content = ordered ? m[4] : m[3];
      const open = () => {
        html += ordered ? `<ol start="${parseInt(m[2], 10) || 1}">` : "<ul>";
        stack.push({ type, delim, indent });
        html += "<li>";
      };
      closeLists(indent); // pop anything deeper than this item
      const top = stack[stack.length - 1];
      if (top && top.indent === indent) {
        if (top.type === type && top.delim === delim) {
          html += "</li><li>"; // sibling in the same list
        } else {
          // Same indent but a different marker ('.' vs ')', or ul vs ol) → a new
          // list, so a "1)" sub-list doesn't keep counting from a "1." list.
          html += `</li></${stack.pop().type}>`;
          open();
        }
      } else {
        open(); // deeper than the current item → nest inside its open <li>
      }
      html += renderInline(content);
    } else {
      flushQuote();
      closeLists();
      para.push(line);
    }
  }
  flushText();
  closeLists();
  return html;
}
