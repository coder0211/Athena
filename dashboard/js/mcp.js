// MCP tab (Cursor-style): edit mcp_servers.json directly, then Save. After
// saving, each configured server is shown as a box with its live tools/prompts.
import { $, el, escapeHtml } from "./dom.js";
import { api } from "./api.js";
import { setDirty } from "./dirty.js";

const STARTER = '{\n  "mcpServers": {}\n}\n';

// --- syntax highlighting (transparent textarea over a highlighted <pre>) ---
const HL_RE =
  /("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlight(src) {
  const html = escapeHtml(src).replace(HL_RE, (m, key, str, lit) => {
    if (key) return `<span class="tok-key">${key}</span>`;
    if (str) return `<span class="tok-str">${str}</span>`;
    if (lit) return `<span class="tok-lit">${m}</span>`;
    return `<span class="tok-num">${m}</span>`;
  });
  // A trailing newline needs a filler char so the <pre>'s last line has height.
  return html.endsWith("\n") ? html + "​" : html;
}

function paint() {
  const ta = $("mcp-json");
  $("mcp-hl").innerHTML = highlight(ta.value);
  syncScroll();
  updateActiveLine();
}
function syncScroll() {
  const ta = $("mcp-json");
  const pre = $("mcp-hl").parentElement; // .mcp-code-hl
  pre.scrollTop = ta.scrollTop;
  pre.scrollLeft = ta.scrollLeft;
}

// Fill the background of the line the caret is on (like a code editor's active
// line). Positioned from the caret's line index, offset by the scroll.
function updateActiveLine() {
  const ta = $("mcp-json");
  const al = $("mcp-active");
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || 18;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const line = ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
  const top = padTop + line * lh - ta.scrollTop;
  if (top < 0 || top > ta.clientHeight - 1) {
    al.style.display = "none";
    return;
  }
  al.style.display = "block";
  al.style.top = `${top}px`;
  al.style.height = `${lh}px`;
}

async function loadEditor() {
  let content = STARTER;
  try {
    content = (await api.get("/api/mcp/config")).content || STARTER;
  } catch {
    /* keep starter */
  }
  $("mcp-json").value = content;
  paint();
  setDirty("mcp", false); // in sync with the server after a load
}

// Pretty-print the JSON in place. Returns true on success.
function formatJson(quiet) {
  const ta = $("mcp-json");
  try {
    ta.value = JSON.stringify(JSON.parse(ta.value || "{}"), null, 2) + "\n";
    paint();
    if (!quiet) setMsg("Formatted", "ok");
    return true;
  } catch (e) {
    if (!quiet) setMsg("Can't format: " + e.message, "err");
    return false;
  }
}

function setMsg(text, kind) {
  const msg = $("mcp-msg");
  msg.textContent = text;
  msg.className = "msg" + (kind ? " " + kind : "");
}

const statusOf = (s) => (!s.enabled ? "off" : s.error ? "err" : "ok");
const headRight = (s) => {
  if (!s.enabled) return "disabled";
  if (s.error) return "unreachable";
  const n = (s.tools || []).length;
  return `${n} tool${n === 1 ? "" : "s"}`;
};

function itemsBlock(items, title) {
  if (!items || !items.length) return "";
  return (
    `<div class="mcp-items"><div class="mcp-items-title">${title}</div>` +
    items
      .map(
        (t) =>
          `<div class="mcp-item"><code class="mcp-item-name">${escapeHtml(t.name)}</code>` +
          (t.description ? `<span class="mcp-item-desc">${escapeHtml(t.description)}</span>` : "") +
          `</div>`,
      )
      .join("") +
    `</div>`
  );
}

function serverCard(s) {
  const card = el("div", "mcp-card" + (s.enabled ? "" : " disabled"));
  card.innerHTML =
    `<div class="mcp-card-head">` +
    `<span class="mcp-dot ${statusOf(s)}" title="${escapeHtml(headRight(s))}"></span>` +
    `<span class="mcp-srv-name">${escapeHtml(s.name || "(unnamed)")}</span>` +
    `<span class="mcp-badge">${escapeHtml(s.transport || "stdio")}</span>` +
    `<span class="ws-spacer"></span>` +
    `<span class="ws-sub">${escapeHtml(headRight(s))}</span>` +
    `</div>` +
    (s.description ? `<div class="mcp-srv-desc">${escapeHtml(s.description)}</div>` : "") +
    (s.error && s.enabled ? `<div class="msg err mcp-err">${escapeHtml(s.error)}</div>` : "") +
    itemsBlock(s.tools, "Tools") +
    itemsBlock(s.prompts, "Prompts");
  return card;
}

// Discovering connects to every enabled server, so it's only run on demand
// (opening the tab, Refresh, or after Save) — not on every dashboard load.
async function loadServers() {
  const list = $("mcp-list");
  list.innerHTML = `<p class="hint">Connecting to servers…</p>`;
  let servers = [];
  try {
    servers = await api.get("/api/mcp/servers");
  } catch (e) {
    list.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
    return;
  }
  $("mcp-count").textContent = servers.length ? `${servers.length} server(s)` : "";
  list.innerHTML = "";
  if (!servers.length) {
    list.innerHTML = `<p class="hint">No MCP servers yet — add one to the JSON above and Save.</p>`;
    return;
  }
  servers.forEach((s) => list.append(serverCard(s)));
}

// --- editor events ---
const ta = $("mcp-json");
ta.addEventListener("input", () => {
  paint();
  setDirty("mcp", true);
});
ta.addEventListener("scroll", () => {
  syncScroll();
  updateActiveLine();
});
ta.addEventListener("keyup", updateActiveLine); // caret moved via keyboard
ta.addEventListener("click", updateActiveLine); // caret moved via mouse
ta.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    // Insert two spaces instead of moving focus.
    e.preventDefault();
    const s = ta.selectionStart, en = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(en);
    ta.selectionStart = ta.selectionEnd = s + 2;
    paint();
  }
});
$("mcp-format").onclick = () => formatJson(false);

$("mcp-save").onclick = async () => {
  formatJson(true); // auto-format on save (no-op if invalid — backend reports it)
  const btn = $("mcp-save");
  btn.disabled = true; // guard against a double-submit while the PUT is in flight
  setMsg("Saving…", "");
  try {
    const r = await api.put("/api/mcp/config", { content: ta.value });
    setDirty("mcp", false);
    setMsg(`Saved ${r.servers} server(s)`, "ok");
    loadServers(); // re-discover tools/prompts with the new config
  } catch (e) {
    setMsg(e.message, "err"); // JSON / validation error from the backend
  } finally {
    btn.disabled = false;
  }
};
$("mcp-refresh").onclick = loadServers;

// Called by main.js when the MCP tab is shown, so discovery runs lazily.
export function refreshMcpServers() {
  loadServers();
}

export async function loadMcp() {
  await loadEditor();
}
