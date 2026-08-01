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

export function detectMention() {
  const val = $("input").value;
  const pos = $("input").selectionStart;
  const m = val.slice(0, pos).match(/([@#])([\w./-]*)$/);
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

export async function updateMentions() {
  const mention = S.mention;
  if (!mention) return renderMentionList([]);
  if (mention.type === "@") {
    const q = mention.query.toLowerCase();
    renderMentionList(
      S.REPOS.filter((r) => r.toLowerCase().includes(q)).map((r) => {
        const meta = S.REPO_META[r] || {};
        const sub = meta.description || meta.role || "";
        return { label: "@" + r, sub, kind: "repo", value: r };
      }),
    );
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
