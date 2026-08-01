// Athena Chat — multi-turn chatbot over /api/ask (stateless server; the client
// keeps the running history and sends it with each turn).
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}
async function apiGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

let history = []; // [{role:'user'|'assistant', content}]
let busy = false;
let mode = localStorage.getItem("athena_mode") || "business"; // 'business' | 'technical'
let lang = localStorage.getItem("athena_lang");
if (lang !== "en" && lang !== "vi") lang = "en"; // 'auto' removed — default to English
let REPOS = []; // repo names, for @ mentions
let REPO_META = {}; // {name: {description, role, tags}} for @ mention hints
let scopeRepos = []; // ["a", ...]
let scopeSymbols = []; // [{name, id, repo}]
let mention = null; // active mention being typed: {type, start, query}
let mentionItems = [];
let mentionActive = -1;

// --- lightweight, dependency-free syntax highlight (works offline) ---
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
    "|\\b(" + CODE_KEYWORDS + ")\\b", // 4: keywords
  "g",
);
function highlightCode(raw) {
  return escapeHtml(raw).replace(CODE_TOKEN, (m, comment, str, num, kw) => {
    if (comment) return `<span class="tok-comment">${comment}</span>`;
    if (str) return `<span class="tok-string">${str}</span>`;
    if (num) return `<span class="tok-number">${num}</span>`;
    if (kw) return `<span class="tok-keyword">${kw}</span>`;
    return m;
  });
}

// --- lightweight markdown: fenced code blocks + inline code + bold ---
function formatAnswer(text) {
  const parts = String(text).split(/```/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const body = part.replace(/^\w*\n/, ""); // drop the ```lang line
        return `<pre><code>${highlightCode(body)}</code></pre>`;
      }
      return escapeHtml(part)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
    })
    .join("");
}

function scrollDown() {
  const m = $("messages");
  m.scrollTop = m.scrollHeight;
}
function hideEmpty() {
  const e = $("empty");
  if (e) e.remove();
}

function addUser(text, scope) {
  const row = el("div", "chat-msg user");
  const bubble = el("div", "bubble");
  if (scope && (scope.repos.length || scope.symbols.length)) {
    const tags = el("div", "msg-scope");
    scope.repos.forEach((r) => tags.append(el("span", "mtag", "@" + r)));
    scope.symbols.forEach((s) => tags.append(el("span", "mtag", "#" + s.name)));
    bubble.append(tags);
  }
  bubble.append(el("div", "msg-text", escapeHtml(text)));
  row.append(bubble);
  $("messages").append(row);
  scrollDown();
}
// Footer under an answer: tools used (left) + actions regenerate/copy (right).
function buildFooter(text, steps) {
  const foot = el("div", "msg-foot");
  if (steps?.length) {
    const tools = [...new Set(steps.map((s) => s.tool))];
    const box = el("div", "tools");
    box.append(el("span", "tools-ic", ICON_TOOL));
    tools.forEach((name) => box.append(el("span", "tool-chip", escapeHtml(name))));
    foot.append(box);
  }
  const actions = el("div", "msg-actions");
  actions.append(regenButton());
  actions.append(copyButton(text)); // copy the raw answer, not the rendered HTML
  foot.append(actions);
  return foot;
}
function addAssistant(text, steps, isError) {
  const row = el("div", "chat-msg assistant");
  const bubble = el("div", "bubble" + (isError ? " error" : ""), formatAnswer(text));
  row.append(bubble);
  if (!isError) {
    row.append(buildFooter(text, steps));
  }
  $("messages").append(row);
  scrollDown();
  if (!isError) pruneRegen(); // show regenerate only on this (now latest) answer
}

// Copy to clipboard, with a fallback for non-secure contexts.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const ta = el("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
const ICON_COPY =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_TOOL =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
const ICON_REGEN =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';

function copyButton(text) {
  const btn = el("button", "act-btn copy-btn");
  btn.type = "button";
  const setState = (copied) => {
    btn.innerHTML =
      (copied ? ICON_CHECK : ICON_COPY) + `<span>${copied ? t().copiedLabel : t().copyLabel}</span>`;
    btn.title = copied ? t().copiedLabel : t().copyLabel;
    btn.classList.toggle("done", copied);
  };
  setState(false);
  btn.onclick = async () => {
    const ok = await copyText(text);
    if (!ok) return;
    setState(true);
    setTimeout(() => setState(false), 1500);
  };
  return btn;
}
function regenButton() {
  const btn = el("button", "act-btn regen-btn", ICON_REGEN + `<span>${t().regenLabel}</span>`);
  btn.type = "button";
  btn.title = t().regenLabel;
  btn.onclick = () => regenerate();
  return btn;
}
// Keep the regenerate button only on the most recent answer.
function pruneRegen() {
  const rows = [...$("messages").querySelectorAll(".chat-msg.assistant:not(.typing)")];
  rows.forEach((row, i) => {
    const btn = row.querySelector(".regen-btn");
    if (btn) btn.style.display = i === rows.length - 1 ? "" : "none";
  });
}
const statusLabel = (tool) => t().status[tool] || t().status._default;
function addTyping() {
  const row = el("div", "chat-msg assistant typing");
  const bubble = el("div", "bubble typing-bubble");
  bubble.append(el("span", "typing-status", t().status.thinking));
  bubble.append(
    el("span", "typing-dots", '<span class="dot"></span><span class="dot"></span><span class="dot"></span>'),
  );
  row.append(bubble);
  $("messages").append(row);
  scrollDown();
  return row;
}
function setTypingStatus(row, text) {
  const s = row?.querySelector(".typing-status");
  if (s) s.textContent = text;
}

function setBusy(on) {
  busy = on;
  $("send").disabled = on;
  document.querySelectorAll(".regen-btn").forEach((b) => (b.disabled = on));
}

let lastRequest = null; // {question, priorHistory, scope} — replayed by regenerate

async function send(text) {
  const q = text.trim();
  if (!q || busy) return;
  hideEmpty();
  lockMode(); // this turn fixes the mode for the rest of the conversation
  const scope = { repos: scopeRepos.slice(), symbols: scopeSymbols.slice() };
  addUser(q, scope);
  const priorHistory = history.slice(); // turns before this question
  history.push({ role: "user", content: q });
  $("input").value = "";
  autoGrow();
  lastRequest = { question: q, priorHistory, scope };
  runAsk(lastRequest);
}

// Ask the server and stream the answer in. Shared by send() and regenerate().
async function runAsk({ question, priorHistory, scope }) {
  setBusy(true);
  const typing = addTyping();
  let row = null;
  let bubble = null;
  let acc = "";
  let steps = [];
  let unavailable = null;
  let streamError = null;

  // Lazily create the answer row on the first token (typing shows until then).
  const ensureRow = () => {
    if (row) return;
    typing.remove();
    row = el("div", "chat-msg assistant");
    bubble = el("div", "bubble");
    row.append(bubble);
    $("messages").append(row);
  };
  const handle = (ev) => {
    if (ev.unavailable) unavailable = ev.unavailable;
    else if (ev.error) streamError = ev.error;
    else if (ev.delta) {
      ensureRow();
      acc += ev.delta;
      bubble.innerHTML = formatAnswer(acc); // re-render markdown as it grows
      scrollDown();
    } else if (ev.tool) {
      steps.push({ tool: ev.tool });
      if (!row) setTypingStatus(typing, statusLabel(ev.tool)); // live status while investigating
    } else if (ev.done && ev.steps) steps = ev.steps;
  };

  try {
    const res = await fetch("/api/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history: priorHistory, scope, mode, lang }),
    });
    if (!res.ok || !res.body) throw new Error(res.statusText || "stream failed");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 2);
        if (!frame.startsWith("data:")) continue;
        try {
          handle(JSON.parse(frame.slice(5).trim()));
        } catch {
          /* ignore malformed frame */
        }
      }
    }

    typing.remove();
    if (unavailable) {
      row?.remove();
      addAssistant(unavailable, null, true);
    } else if (!row) {
      addAssistant(t().errorPrefix + (streamError || "empty response"), null, true);
    } else {
      bubble.innerHTML = formatAnswer(acc); // final render
      row.append(buildFooter(acc, steps));
      pruneRegen();
      history.push({ role: "assistant", content: acc });
    }
  } catch (e) {
    typing.remove();
    row?.remove();
    addAssistant(t().errorPrefix + e.message, null, true);
  } finally {
    setBusy(false);
    $("input").focus();
  }
}

// Re-run the last question, replacing the last answer with a fresh one.
function regenerate() {
  if (busy || !lastRequest) return;
  const rows = [...$("messages").querySelectorAll(".chat-msg.assistant:not(.typing)")];
  rows[rows.length - 1]?.remove(); // drop the previous answer's row
  if (history.at(-1)?.role === "assistant") history.pop(); // …and its history turn
  runAsk(lastRequest);
}

// --- scope chips ---
function renderScope() {
  const bar = $("scope-bar");
  bar.innerHTML = "";
  scopeRepos.forEach((r, i) =>
    bar.append(
      scopeChip("@" + r, "repo", () => {
        scopeRepos.splice(i, 1);
        renderScope();
      }),
    ),
  );
  scopeSymbols.forEach((s, i) =>
    bar.append(
      scopeChip("#" + s.name, "symbol", () => {
        scopeSymbols.splice(i, 1);
        renderScope();
      }),
    ),
  );
}
function scopeChip(label, kind, onRemove) {
  const chip = el("span", "scope-chip " + kind, escapeHtml(label));
  const x = el("button", null, "×");
  x.type = "button";
  x.onclick = onRemove;
  chip.append(x);
  return chip;
}

// --- @repo / #symbol mentions ---
function detectMention() {
  const val = $("input").value;
  const pos = $("input").selectionStart;
  const m = val.slice(0, pos).match(/([@#])([\w./-]*)$/);
  mention = m ? { type: m[1], query: m[2], start: pos - m[0].length } : null;
}
let mentionTimer = null;
let mentionSeq = 0; // bumps per search; stale async responses are ignored
const mentionCache = new Map(); // query -> rows, so re-typed prefixes skip the network
function symbolItems(rows) {
  return rows.map((n) => ({
    label: "#" + n.name,
    sub: (n.repo || "") + (n.type ? " · " + n.type : ""),
    kind: "symbol",
    value: { name: n.name, id: n.id, repo: n.repo },
  }));
}
async function updateMentions() {
  if (!mention) return renderMentionList([]);
  if (mention.type === "@") {
    const q = mention.query.toLowerCase();
    renderMentionList(
      REPOS.filter((r) => r.toLowerCase().includes(q)).map((r) => {
        const meta = REPO_META[r] || {};
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
      const rows = await apiGet(
        "/api/search?compact=1&limit=8&q=" + encodeURIComponent(query),
      );
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
  mentionItems = items.filter((i) => i.kind !== "hint");
  mentionActive = mentionItems.length ? 0 : -1;
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
      "mention-item" + (i === mentionActive ? " active" : ""),
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
function pickMention(it) {
  const input = $("input");
  const val = input.value;
  const pos = input.selectionStart;
  input.value = val.slice(0, mention.start) + val.slice(pos);
  input.setSelectionRange(mention.start, mention.start);
  if (it.kind === "repo") {
    if (!scopeRepos.includes(it.value)) scopeRepos.push(it.value);
  } else if (!scopeSymbols.some((s) => s.id === it.value.id)) {
    scopeSymbols.push(it.value);
  }
  mention = null;
  $("mention-list").hidden = true;
  renderScope();
  input.focus();
  autoGrow();
}
function closeMentions() {
  mention = null;
  $("mention-list").hidden = true;
}

// --- composer: auto-grow textarea, mentions, Enter to send ---
function autoGrow() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 200) + "px";
}
$("input").addEventListener("input", () => {
  autoGrow();
  detectMention();
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(updateMentions, mention && mention.type === "#" ? 180 : 0);
});
$("input").addEventListener("blur", () => setTimeout(closeMentions, 150));
$("input").addEventListener("keydown", (e) => {
  const open = !$("mention-list").hidden && mentionItems.length;
  if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    mentionActive = (mentionActive + (e.key === "ArrowDown" ? 1 : -1) + mentionItems.length) % mentionItems.length;
    [...$("mention-list").querySelectorAll(".mention-item")].forEach((c, i) =>
      c.classList.toggle("active", i === mentionActive),
    );
    return;
  }
  if (open && (e.key === "Enter" || e.key === "Tab")) {
    e.preventDefault();
    pickMention(mentionItems[mentionActive]);
    return;
  }
  if (e.key === "Escape") return closeMentions();
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send($("input").value);
  }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("input").value);
});
$("new-chat").onclick = () => {
  history = [];
  scopeRepos = [];
  scopeSymbols = [];
  $("messages").innerHTML = "";
  location.reload();
};

// --- Business ⇄ Technical mode toggle ---
// Reflect the mode on <body> so CSS can theme the composer + message bubbles.
let modeLocked = false;
function applyModeTheme() {
  document.body.dataset.mode = mode;
}
// The mode colours every past bubble, and each answer was produced in a given
// mode — so once the conversation starts, lock it. New chat unlocks it.
function lockMode() {
  if (modeLocked) return;
  modeLocked = true;
  const tog = $("mode-toggle");
  tog.classList.add("locked");
  tog.title = t().modeLocked;
  document.querySelectorAll(".mode-btn").forEach((b) => (b.disabled = true));
}
applyModeTheme();
document.querySelectorAll(".mode-btn").forEach((b) => {
  b.classList.toggle("active", b.dataset.mode === mode);
  b.onclick = () => {
    if (modeLocked) return;
    mode = b.dataset.mode;
    localStorage.setItem("athena_mode", mode);
    document.querySelectorAll(".mode-btn").forEach((x) => x.classList.toggle("active", x === b));
    applyModeTheme();
    renderEmpty(); // refresh the welcome copy + suggestions for the new mode
  };
});

// --- i18n: every static string lives here, so changing the language re-skins
// the whole chat UI — headings, starter prompts, buttons, placeholder, tip,
// tooltips and banners. Welcome copy is also split by Business/Technical mode. ---
const I18N = {
  en: {
    business: "Business",
    technical: "Technical",
    newChat: "New chat",
    send: "Send",
    placeholder: "Ask anything…  @repo or #symbol to narrow scope · Enter to send",
    tip: 'Tip: type <b>@</b> to focus on one app, <b>#</b> to focus on a specific feature/screen.',
    modeLocked: "Locked for this conversation — start a new chat to switch modes.",
    mentionHint: "Type a symbol name…",
    copyLabel: "Copy",
    copiedLabel: "Copied",
    regenLabel: "Regenerate",
    status: {
      thinking: "Thinking…",
      overview: "Scanning the graph…",
      search_symbols: "Searching the code…",
      get_symbol: "Inspecting a symbol…",
      callers: "Following call paths…",
      callees: "Following call paths…",
      impact: "Tracing impact…",
      find_path: "Connecting the dots…",
      list_communities: "Finding the feature area…",
      community_members: "Exploring the feature area…",
      repos_info: "Mapping the apps…",
      repo_relations: "Mapping the apps…",
      read_source: "Reading the source…",
      read_file: "Reading the source…",
      writing: "Writing the answer…",
      _default: "Working…",
    },
    unavailable: "Q&A is unavailable.",
    errorPrefix: "Error: ",
    bannerNotBuilt: "⚠️ Graph not built yet — build it in the Manage app first.",
    bannerAskOff: "⚠️ Q&A is off — set OPENAI_API_KEY and restart the server.",
    bannerUnreachable: "API unreachable.",
    copy: {
      business: {
        title: "Understand how the product works",
        desc: "Ask in plain language — it reads the real code and explains the business flow, step by step. No technical background needed.",
        suggestions: [
          "How does a customer book and pay for a ticket?",
          "Walk me through the checkout process step by step.",
          "What happens when a payment fails?",
          "What are the different apps and what does each one do?",
        ],
      },
      technical: {
        title: "Understand how the code works",
        desc: "Ask in plain language — it reads the real code and explains the implementation: call paths, data flow, and where each piece lives.",
        suggestions: [
          "Trace the request flow when a ticket is booked.",
          "Which functions handle payment processing?",
          "How is state managed through the checkout flow?",
          "What are the main services and how do they depend on each other?",
        ],
      },
    },
  },
  vi: {
    business: "Nghiệp vụ",
    technical: "Kỹ thuật",
    newChat: "Trò chuyện mới",
    send: "Gửi",
    placeholder: "Hỏi bất cứ điều gì…  @repo hoặc #symbol để thu hẹp phạm vi · Enter để gửi",
    tip: 'Mẹo: gõ <b>@</b> để tập trung vào một ứng dụng, <b>#</b> để tập trung vào một tính năng/màn hình cụ thể.',
    modeLocked: "Đã khoá cho cuộc trò chuyện này — mở trò chuyện mới để đổi chế độ.",
    mentionHint: "Nhập tên một symbol…",
    copyLabel: "Sao chép",
    copiedLabel: "Đã chép",
    regenLabel: "Tạo lại",
    status: {
      thinking: "Đang suy nghĩ…",
      overview: "Đang quét đồ thị…",
      search_symbols: "Đang tìm trong mã nguồn…",
      get_symbol: "Đang xem một symbol…",
      callers: "Đang lần theo lời gọi hàm…",
      callees: "Đang lần theo lời gọi hàm…",
      impact: "Đang truy vết ảnh hưởng…",
      find_path: "Đang nối các liên hệ…",
      list_communities: "Đang tìm khu vực tính năng…",
      community_members: "Đang khám phá khu vực tính năng…",
      repos_info: "Đang lập bản đồ ứng dụng…",
      repo_relations: "Đang lập bản đồ ứng dụng…",
      read_source: "Đang đọc mã nguồn…",
      read_file: "Đang đọc mã nguồn…",
      writing: "Đang viết câu trả lời…",
      _default: "Đang xử lý…",
    },
    unavailable: "Q&A hiện không khả dụng.",
    errorPrefix: "Lỗi: ",
    bannerNotBuilt: "⚠️ Chưa dựng graph — hãy dựng nó trong app Manage trước.",
    bannerAskOff: "⚠️ Q&A đang tắt — đặt OPENAI_API_KEY rồi khởi động lại server.",
    bannerUnreachable: "Không kết nối được API.",
    copy: {
      business: {
        title: "Hiểu sản phẩm hoạt động thế nào",
        desc: "Hỏi bằng ngôn ngữ đời thường — hệ thống đọc mã nguồn thật và giải thích luồng nghiệp vụ theo từng bước. Không cần kiến thức kỹ thuật.",
        suggestions: [
          "Khách hàng đặt và thanh toán vé như thế nào?",
          "Hướng dẫn tôi quy trình thanh toán theo từng bước.",
          "Điều gì xảy ra khi thanh toán thất bại?",
          "Có những ứng dụng nào và mỗi ứng dụng làm gì?",
        ],
      },
      technical: {
        title: "Hiểu mã nguồn hoạt động thế nào",
        desc: "Hỏi bằng ngôn ngữ đời thường — hệ thống đọc mã nguồn thật và giải thích cách cài đặt: luồng gọi hàm, luồng dữ liệu, và vị trí từng thành phần.",
        suggestions: [
          "Lần theo luồng xử lý khi một vé được đặt.",
          "Những hàm nào xử lý việc thanh toán?",
          "Trạng thái được quản lý ra sao xuyên suốt luồng thanh toán?",
          "Các service chính là gì và chúng phụ thuộc lẫn nhau thế nào?",
        ],
      },
    },
  },
};
const t = () => I18N[lang] || I18N.en;

// Re-skin all static chrome for the current language.
function applyLang() {
  document.documentElement.lang = lang;
  const s = t();
  document.querySelectorAll(".mode-btn").forEach((b) => (b.textContent = s[b.dataset.mode]));
  $("new-chat").textContent = s.newChat;
  $("send").textContent = s.send;
  $("input").placeholder = s.placeholder;
  if (modeLocked) $("mode-toggle").title = s.modeLocked;
  renderEmpty();
}

function renderEmpty() {
  const e = $("empty");
  if (!e) return; // gone once the conversation starts
  const s = t();
  const c = s.copy[mode] || s.copy.business;
  e.querySelector("h2").textContent = c.title;
  e.querySelector("p").textContent = c.desc;
  e.querySelector(".chat-empty-tip").innerHTML = s.tip;
  const box = $("suggestions");
  box.innerHTML = "";
  c.suggestions.forEach((q) => {
    const chip = el("button", "suggestion", escapeHtml(q));
    chip.type = "button";
    chip.onclick = () => send(q);
    box.append(chip);
  });
}

// --- response language: whole UI follows the choice ---
$("lang-select").value = lang;
$("lang-select").onchange = () => {
  lang = $("lang-select").value;
  localStorage.setItem("athena_lang", lang);
  applyLang();
};
async function init() {
  try {
    const s = await apiGet("/api/status");
    REPOS = Object.keys((s.graph && s.graph.by_repo) || {}).sort();
    if (!s.built) {
      showBanner(t().bannerNotBuilt);
    } else if (!s.ask_available) {
      showBanner(t().bannerAskOff);
    }
  } catch {
    showBanner(t().bannerUnreachable);
  }
  try {
    const ws = await apiGet("/api/workspace"); // repo descriptions for @ hints
    if (ws.repos_available?.length) REPOS = ws.repos_available;
    REPO_META = ws.repos || {};
  } catch {
    /* workspace optional */
  }
  renderScope();
  applyLang();
  $("input").focus();
}
function showBanner(msg) {
  const b = $("banner");
  b.textContent = msg;
  b.hidden = false;
}
init();
