// The composer: sending a turn, streaming the answer in (SSE), and regenerate.
// The backend owns history (keyed by S.conversationId), so we no longer send it.
import { $, el, scrollDown } from "./dom.js";
import { S } from "./state.js";
import { t, statusLabel } from "./i18n.js";
import { formatAnswer } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import {
  addUser,
  addTyping,
  setTypingStatus,
  addAssistant,
  buildFooter,
  pruneRegen,
  hideEmpty,
} from "./messages.js";
import { lockMode, setHeaderTitle } from "./mode.js";
import { loadConversations } from "./conversations.js";

export function autoGrow() {
  const ta = $("input");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
}

export async function send(text) {
  const q = text.trim();
  if (!q || S.busy) return;
  hideEmpty();
  lockMode(); // this turn fixes the mode for the rest of the conversation
  // Expand each tagged folder into the documents under it (by path prefix) and
  // merge with explicitly tagged docs, de-duped by id — the backend scope only
  // speaks documents, so a folder is just a convenient way to select a subtree.
  const folderDocs = S.DOCS.filter((d) =>
    S.scopeFolders.some((f) => (d.path || "").startsWith(f.path + "/")),
  ).map((d) => ({ id: d.id, name: d.name }));
  const seen = new Set();
  const docs = [...S.scopeDocs, ...folderDocs].filter((d) =>
    seen.has(d.id) ? false : seen.add(d.id),
  );
  const scope = {
    repos: S.scopeRepos.slice(),
    symbols: S.scopeSymbols.slice(),
    docs,
  };
  // The bubble shows the tags the user actually picked (folders stay collapsed).
  const displayScope = {
    repos: scope.repos,
    symbols: scope.symbols,
    docs: S.scopeDocs.slice(),
    folders: S.scopeFolders.slice(),
  };
  addUser(q, displayScope);
  S.history.push({ role: "user", content: q });
  $("input").value = "";
  autoGrow();
  S.lastRequest = { question: q, scope };
  runAsk(S.lastRequest);
}

// Ask the server and stream the answer in. Shared by send() and regenerate().
async function runAsk({ question, scope }, { regenerate = false } = {}) {
  setBusy(true);
  const typing = addTyping();
  let row = null;
  let bubble = null;
  let acc = "";
  let steps = [];
  let sources = [];
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
    if (ev.conversation) {
      S.conversationId = ev.conversation.id;
      if (ev.conversation.new) {
        setHeaderTitle(ev.conversation.title); // name the header from the first question
        loadConversations(); // show the fresh conversation in the sidebar
      }
    } else if (ev.unavailable) unavailable = ev.unavailable;
    else if (ev.error) streamError = ev.error;
    else if (ev.delta) {
      ensureRow();
      acc += ev.delta;
      bubble.innerHTML = formatAnswer(acc); // re-render markdown as it grows
      scrollDown();
    } else if (ev.tool) {
      steps.push({ tool: ev.tool });
      if (!row) setTypingStatus(typing, statusLabel(ev.tool)); // live status while investigating
    } else if (ev.done) {
      if (ev.steps) steps = ev.steps;
      if (ev.sources) sources = ev.sources;
    }
  };

  try {
    const res = await fetch("/api/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        conversation_id: S.conversationId,
        scope,
        mode: S.mode,
        lang: S.lang,
        regenerate,
      }),
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
      renderMermaid(bubble); // draw any mermaid diagrams (streaming showed source)
      row.append(buildFooter(acc, steps, sources));
      pruneRegen();
      S.history.push({ role: "assistant", content: acc });
      loadConversations(); // refresh title/preview/count in the sidebar
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
export function regenerate() {
  if (S.busy || !S.lastRequest) return;
  const rows = [...$("messages").querySelectorAll(".chat-msg.assistant:not(.typing)")];
  rows[rows.length - 1]?.remove(); // drop the previous answer's row
  if (S.history.at(-1)?.role === "assistant") S.history.pop(); // …and its history turn
  runAsk(S.lastRequest, { regenerate: true });
}

function setBusy(on) {
  S.busy = on;
  $("send").disabled = on;
  document.querySelectorAll(".regen-btn").forEach((b) => (b.disabled = on));
}
