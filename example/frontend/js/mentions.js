// @repo / #symbol autocomplete in the composer. Detects a mention being typed,
// fetches symbol matches (debounced, cached, race-guarded), and inserts the
// picked item as a scope chip.
import { $, el, escapeHtml } from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";
import { apiGet } from "./api.js";
import { renderScope } from "./scope.js";
import { autoGrow } from "./composer.js";

let mentionSeq = 0; // bumps per search; stale async responses are ignored
const mentionCache = new Map(); // query -> rows, so re-typed prefixes skip the network

// Diacritic-insensitive fold so "@bang gia" (or "@hsk") matches "Bảng giá HSK.pdf".
// Strips combining marks and maps đ→d, so Vietnamese document names filter naturally.
export const fold = (s) =>
  (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();

export function detectMention() {
  const val = $("input").value;
  const pos = $("input").selectionStart;
  // Triggers: "/" (repos & docs), "@" (MCP tools), "#" (symbols). The trigger must
  // sit at a word boundary (start of input or after whitespace) so slashes inside
  // normal text or paths (src/query) don't open a mention. Query allows Unicode
  // letters/numbers plus . / - _ (so accented doc names and folder paths survive).
  const m = val.slice(0, pos).match(/(?<=^|\s)([@#/])([\p{L}\p{N}._/-]*)$/u);
  S.mention = m ? { type: m[1], query: m[2], start: pos - m[0].length } : null;
}

function symbolItems(rows) {
  return rows.map((n) => ({
    label: "#" + n.name,
    sub: (n.repo || "") + (n.type ? " · " + n.type : ""),
    kind: "symbol",
    value: { name: n.name, id: n.id, repo: n.repo },
  }));
}

// Nicer display name for a folder path prefix: drop the .docs/uploads/ noise.
function folderLabel(path) {
  if (path === ".docs/uploads") return "uploads";
  return path.replace(/^\.docs\/uploads\//, "") || path;
}

// Distinct folder prefixes across all indexed documents (every ancestor dir),
// so a whole subtree can be tagged. Pass-through prefixes — a container whose
// docs all live in one deeper prefix (e.g. ".docs" → ".docs/uploads") — are
// dropped so the list isn't cluttered with redundant roots. [{path, label, count}].
function docFolders() {
  const counts = new Map(); // raw prefix -> doc count under it
  for (const d of S.DOCS) {
    const parts = (d.path || "").split("/").filter(Boolean);
    parts.pop(); // drop the filename
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      counts.set(p, (counts.get(p) || 0) + 1);
    }
  }
  const all = [...counts.entries()];
  return all
    .filter(([p, n]) => !all.some(([q, m]) => q !== p && q.startsWith(p + "/") && m === n))
    .map(([path, n]) => ({ path, label: folderLabel(path), count: n }));
}

export async function updateMentions() {
  const mention = S.mention;
  if (!mention) return renderMentionList([]);
  if (mention.type === "/") {
    // "/" → repositories, document folders, and documents.
    const q = fold(mention.query);
    const repos = S.REPOS.filter((r) => fold(r).includes(q)).map((r) => {
      const meta = S.REPO_META[r] || {};
      const sub = meta.description || meta.role || "";
      return { label: "/" + r, sub, kind: "repo", value: r };
    });
    const folders = docFolders()
      .filter((f) => fold(f.label).includes(q))
      .map((f) => ({
        label: "📁 " + f.label,
        sub: `folder · ${f.count} doc(s)`,
        kind: "folder",
        value: { path: f.path, label: f.label },
      }));
    const docs = S.DOCS.filter((d) => fold(d.name).includes(q)).map((d) => ({
      label: "📄 " + d.name,
      sub: [d.file_type, d.sections ? d.sections + " sections" : ""].filter(Boolean).join(" · "),
      kind: "doc",
      value: { id: d.id, name: d.name },
    }));
    renderMentionList([...repos, ...folders, ...docs]);
  } else if (mention.type === "@") {
    // "@" → third-party MCP tools.
    const q = fold(mention.query);
    const tools = (S.TOOLS || [])
      .filter((tl) => fold(tl.tool).includes(q) || fold(tl.server).includes(q))
      .map((tl) => ({
        label: "@" + tl.tool,
        sub: `MCP · ${tl.server}${tl.description ? " · " + tl.description : ""}`,
        kind: "tool",
        value: { name: tl.name, label: tl.tool },
      }));
    ++mentionSeq; // no async search for tools
    renderMentionList(tools.length ? tools : [{ label: t().mentionToolsEmpty, kind: "hint" }]);
  } else if (mention.query.length >= 1) {
    const query = mention.query;
    const cached = mentionCache.get(query);
    if (cached) {
      ++mentionSeq; // any in-flight search is now stale
      return renderMentionList(symbolItems(cached));
    }
    const seq = ++mentionSeq;
    try {
      const rows = await apiGet("/api/search?compact=1&limit=8&q=" + encodeURIComponent(query));
      mentionCache.set(query, rows);
      if (mentionCache.size > 100) mentionCache.delete(mentionCache.keys().next().value);
      if (seq !== mentionSeq) return; // a newer keystroke already fired — drop stale result
      renderMentionList(symbolItems(rows));
    } catch {
      if (seq === mentionSeq) renderMentionList([]);
    }
  } else {
    ++mentionSeq; // invalidate any in-flight search
    renderMentionList([{ label: t().mentionHint, kind: "hint" }]);
  }
}

function renderMentionList(items) {
  S.mentionItems = items.filter((i) => i.kind !== "hint");
  S.mentionActive = S.mentionItems.length ? 0 : -1;
  const list = $("mention-list");
  list.innerHTML = "";
  if (!items.length) {
    list.hidden = true;
    return;
  }
  items.forEach((it, i) => {
    if (it.kind === "hint") {
      list.append(el("div", "mention-hint", escapeHtml(it.label)));
      return;
    }
    const row = el(
      "div",
      "mention-item" + (i === S.mentionActive ? " active" : ""),
      `<span class="mi-label">${escapeHtml(it.label)}</span>` +
        (it.sub ? `<span class="sub">${escapeHtml(it.sub)}</span>` : ""),
    );
    row.title = it.label + (it.sub ? " — " + it.sub : "");
    row.onmousedown = (e) => {
      e.preventDefault();
      pickMention(it);
    };
    list.append(row);
  });
  list.hidden = false;
}

export function pickMention(it) {
  const input = $("input");
  const val = input.value;
  const pos = input.selectionStart;
  input.value = val.slice(0, S.mention.start) + val.slice(pos);
  input.setSelectionRange(S.mention.start, S.mention.start);
  if (it.kind === "repo") {
    if (!S.scopeRepos.includes(it.value)) S.scopeRepos.push(it.value);
  } else if (it.kind === "folder") {
    if (!S.scopeFolders.some((f) => f.path === it.value.path)) S.scopeFolders.push(it.value);
  } else if (it.kind === "doc") {
    if (!S.scopeDocs.some((d) => d.id === it.value.id)) S.scopeDocs.push(it.value);
  } else if (it.kind === "tool") {
    if (!S.scopeTools.some((t) => t.name === it.value.name)) S.scopeTools.push(it.value);
  } else if (!S.scopeSymbols.some((s) => s.id === it.value.id)) {
    S.scopeSymbols.push(it.value);
  }
  S.mention = null;
  $("mention-list").hidden = true;
  renderScope();
  input.focus();
  autoGrow();
}

export function closeMentions() {
  S.mention = null;
  $("mention-list").hidden = true;
}
