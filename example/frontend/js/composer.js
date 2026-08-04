// The composer: sending a turn, streaming the answer in (SSE), and regenerate.
// The backend owns history (keyed by S.conversationId), so we no longer send it.
import { $, el, scrollDown, nearBottom, ICON_STOP } from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";
import { formatAnswer } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import { enhanceCodeBlocks } from "./codeblocks.js";
import { createTrace } from "./trace.js";
import {
  addUser,
  addTyping,
  addAssistant,
  buildFooter,
  pruneRegen,
  renderFollowups,
  pruneFollowups,
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
    tools: S.scopeTools.map((t) => t.name),
  };
  // The bubble shows the tags the user actually picked (folders stay collapsed).
  const displayScope = {
    repos: scope.repos,
    symbols: scope.symbols,
    docs: S.scopeDocs.slice(),
    folders: S.scopeFolders.slice(),
    tools: S.scopeTools.slice(),
  };
  addUser(q, displayScope);
  S.history.push({ role: "user", content: q });
  S.lastUserText = q; // recalled by the ↑ shortcut on an empty composer
  $("input").value = "";
  localStorage.removeItem("athena_draft"); // the draft was just sent
  autoGrow();
  S.lastRequest = { question: q, scope };
  runAsk(S.lastRequest);
}

// Ask the server and stream the answer in. Shared by send(), regenerate(), and
// editResend() (the last passes edit:true so the server rewrites the user turn).
async function runAsk({ question, scope }, { regenerate = false, edit = false } = {}) {
  const ctrl = new AbortController();
  S.abort = ctrl;
  setBusy(true);
  const typing = addTyping();
  let row = null;
  let bubble = null;
  let trace = null; // investigation trace (created when the first tool runs)
  let acc = "";
  let steps = [];
  let sources = [];
  let followups = [];
  let unavailable = null;
  let streamError = null;

  // Lazily create the answer row on the first token (typing shows until then).
  const ensureRow = () => {
    if (row) return;
    typing.remove();
    row = el("div", "chat-msg assistant");
    bubble = el("div", "bubble");
    if (trace) row.append(trace.node); // move the live trace above the answer
    row.append(bubble);
    $("messages").append(row);
  };
  // Show the trace as soon as Athena runs its first tool — above the still-visible
  // typing indicator until the answer row takes over.
  const ensureTrace = () => {
    if (trace) return;
    trace = createTrace();
    typing.before(trace.node);
  };
  // Re-rendering the whole markdown on every SSE token is expensive and janky;
  // coalesce renders to at most one per animation frame.
  let raf = 0;
  const scheduleRender = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const stick = nearBottom(); // only auto-scroll if the user is already at the bottom
      bubble.innerHTML = formatAnswer(acc); // re-render markdown as it grows
      if (stick) scrollDown();
    });
  };
  const stopRender = () => raf && (cancelAnimationFrame(raf), (raf = 0));
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
      scheduleRender();
    } else if (ev.tool) {
      ensureTrace();
      const step = { tool: ev.tool, input: ev.input }; // input enriches the trace target
      steps.push(step);
      trace.addStep(step);
    } else if (ev.followups) {
      followups = ev.followups;
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
        edit,
      }),
      signal: ctrl.signal,
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

    stopRender(); // finalizeAnswer does the final full render below
    typing.remove();
    if (unavailable) {
      row?.remove();
      trace?.node.remove();
      addAssistant(unavailable, null, true);
    } else if (!row) {
      trace?.node.remove();
      addAssistant(t().errorPrefix + (streamError || "empty response"), null, true);
    } else {
      trace?.finalize(steps);
      finalizeAnswer(row, bubble, acc, steps, sources, followups);
    }
  } catch (e) {
    stopRender();
    typing.remove();
    // A user-initiated stop (AbortError) keeps whatever streamed so far instead
    // of dropping it as an error; a genuine failure still surfaces.
    if (ctrl.signal.aborted) {
      if (row) {
        trace?.finalize(steps);
        finalizeAnswer(row, bubble, acc, steps, sources, followups);
      } else {
        trace?.node.remove();
      }
    } else {
      row?.remove();
      trace?.node.remove();
      addAssistant(t().errorPrefix + e.message, null, true);
    }
  } finally {
    S.abort = null;
    setBusy(false);
    $("input").focus();
  }
}

// Commit a completed (or stopped) answer: final markdown + diagrams, footer,
// and any follow-up suggestions, then record it in history.
function finalizeAnswer(row, bubble, acc, steps, sources, followups) {
  bubble.innerHTML = formatAnswer(acc); // final render
  enhanceCodeBlocks(bubble); // add copy buttons to fenced code blocks
  renderMermaid(bubble); // draw any mermaid diagrams (streaming showed source)
  row.append(buildFooter(acc, steps, sources));
  const fu = renderFollowups(followups);
  if (fu) row.append(fu);
  pruneRegen();
  pruneFollowups();
  S.history.push({ role: "assistant", content: acc });
  loadConversations(); // refresh title/preview/count in the sidebar
}

// Cancel an in-flight answer (the Stop button / stopping the composer).
export function stopGeneration() {
  S.abort?.abort();
}

// Re-run the last question, replacing the last answer with a fresh one.
export function regenerate() {
  if (S.busy || !S.lastRequest) return;
  const rows = [...$("messages").querySelectorAll(".chat-msg.assistant:not(.typing)")];
  rows[rows.length - 1]?.remove(); // drop the previous answer's row
  if (S.history.at(-1)?.role === "assistant") S.history.pop(); // …and its history turn
  runAsk(S.lastRequest, { regenerate: true });
}

// Resend the last question with edited text: update the visible user bubble +
// history, drop the stale answer, and re-ask with edit:true so the server
// rewrites the stored user turn to match (keeps the original scope).
export function editResend(newText) {
  if (S.busy || !S.lastRequest) return;
  const userRows = [...$("messages").querySelectorAll(".chat-msg.user")];
  const lastUser = userRows[userRows.length - 1];
  const te = lastUser?.querySelector(".msg-text");
  if (te) te.textContent = newText;
  const asst = [...$("messages").querySelectorAll(".chat-msg.assistant:not(.typing)")];
  asst[asst.length - 1]?.remove(); // drop the previous answer (and its trace)
  if (S.history.at(-1)?.role === "assistant") S.history.pop();
  if (S.history.at(-1)?.role === "user") S.history[S.history.length - 1].content = newText;
  S.lastUserText = newText;
  S.lastRequest = { question: newText, scope: S.lastRequest.scope };
  runAsk(S.lastRequest, { regenerate: true, edit: true });
}

function setBusy(on) {
  S.busy = on;
  // While busy the Send button turns into a Stop button (stays enabled so the
  // user can cancel a long-running answer); main.js routes its click to stop.
  const send = $("send");
  send.classList.toggle("stopping", on);
  send.innerHTML = on ? ICON_STOP + `<span>${t().stopLabel}</span>` : t().send;
  document.querySelectorAll(".regen-btn").forEach((b) => (b.disabled = on));
}
