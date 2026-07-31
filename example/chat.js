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
let lang = localStorage.getItem("athena_lang") || "auto"; // 'auto' | 'en' | 'vi'
let REPOS = []; // repo names, for @ mentions
let REPO_META = {}; // {name: {description, role, tags}} for @ mention hints
let scopeRepos = []; // ["a", ...]
let scopeSymbols = []; // [{name, id, repo}]
let mention = null; // active mention being typed: {type, start, query}
let mentionItems = [];
let mentionActive = -1;

// --- lightweight markdown: fenced code blocks + inline code + bold ---
function formatAnswer(text) {
  const parts = String(text).split(/```/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/^\w*\n/, ""))}</code></pre>`;
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
function addAssistant(text, steps, isError) {
  const row = el("div", "chat-msg assistant");
  const bubble = el("div", "bubble" + (isError ? " error" : ""), formatAnswer(text));
  row.append(bubble);
  if (steps?.length) {
    const tools = [...new Set(steps.map((s) => s.tool))];
    row.append(el("div", "tools", "🔧 " + tools.map((t) => `<code>${t}</code>`).join(" ")));
  }
  $("messages").append(row);
  scrollDown();
}
function addTyping() {
  const row = el("div", "chat-msg assistant typing");
  row.append(el("div", "bubble", '<span class="dot"></span><span class="dot"></span><span class="dot"></span>'));
  $("messages").append(row);
  scrollDown();
  return row;
}

function setBusy(on) {
  busy = on;
  $("send").disabled = on;
}

async function send(text) {
  const q = text.trim();
  if (!q || busy) return;
  hideEmpty();
  lockMode(); // this turn fixes the mode for the rest of the conversation
  const scopeSnap = { repos: scopeRepos.slice(), symbols: scopeSymbols.slice() };
  addUser(q, scopeSnap);
  const priorHistory = history.slice(); // turns before this question
  history.push({ role: "user", content: q });
  $("input").value = "";
  autoGrow();
  setBusy(true);
  const typing = addTyping();
  try {
    const r = await apiPost("/api/ask", {
      question: q,
      history: priorHistory,
      scope: { repos: scopeRepos.slice(), symbols: scopeSymbols.slice() },
      mode,
      lang,
    });
    typing.remove();
    if (!r.available) {
      addAssistant(r.reason || "Q&A is unavailable.", null, true);
    } else {
      addAssistant(r.answer, r.steps);
      history.push({ role: "assistant", content: r.answer });
    }
  } catch (e) {
    typing.remove();
    addAssistant("Error: " + e.message, null, true);
  } finally {
    setBusy(false);
    $("input").focus();
  }
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
    try {
      const rows = await apiGet("/api/search?q=" + encodeURIComponent(mention.query) + "&limit=8");
      renderMentionList(
        rows.map((n) => ({
          label: "#" + n.name,
          sub: (n.repo || "") + (n.type ? " · " + n.type : ""),
          kind: "symbol",
          value: { name: n.name, id: n.id, repo: n.repo },
        })),
      );
    } catch {
      renderMentionList([]);
    }
  } else {
    renderMentionList([{ label: "Type a symbol name…", kind: "hint" }]);
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
  tog.title = "Locked for this conversation — start a new chat to switch modes.";
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

// --- response language ---
$("lang-select").value = lang;
$("lang-select").onchange = () => {
  lang = $("lang-select").value;
  localStorage.setItem("athena_lang", lang);
};

// --- startup: availability check + suggestions ---
// Welcome copy + starter prompts are mode-specific, so they stay in sync when
// the user flips Business ⇄ Technical.
const COPY = {
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
};

function renderEmpty() {
  const e = $("empty");
  if (!e) return; // gone once the conversation starts
  const c = COPY[mode] || COPY.business;
  e.querySelector("h2").textContent = c.title;
  e.querySelector("p").textContent = c.desc;
  const box = $("suggestions");
  box.innerHTML = "";
  c.suggestions.forEach((q) => {
    const chip = el("button", "suggestion", escapeHtml(q));
    chip.type = "button";
    chip.onclick = () => send(q);
    box.append(chip);
  });
}
async function init() {
  try {
    const s = await apiGet("/api/status");
    REPOS = Object.keys((s.graph && s.graph.by_repo) || {}).sort();
    if (!s.built) {
      showBanner("⚠️ Graph not built yet — build it in the Manage app first.");
    } else if (!s.ask_available) {
      showBanner("⚠️ Q&A is off — set OPENAI_API_KEY and restart the server.");
    }
  } catch {
    showBanner("API unreachable.");
  }
  try {
    const ws = await apiGet("/api/workspace"); // repo descriptions for @ hints
    if (ws.repos_available?.length) REPOS = ws.repos_available;
    REPO_META = ws.repos || {};
  } catch {
    /* workspace optional */
  }
  renderScope();
  renderEmpty();
  $("input").focus();
}
function showBanner(msg) {
  const b = $("banner");
  b.textContent = msg;
  b.hidden = false;
}
init();
