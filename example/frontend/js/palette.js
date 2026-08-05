// Command palette (Cmd/Ctrl+K): fuzzy-search conversations and run quick actions
// (new chat, export) from one keyboard-driven overlay.
import { $, el, escapeHtml } from "./dom.js";
import { t } from "./i18n.js";
import { fold } from "./mentions.js";
import { newChat, openConversation, getConvCache } from "./conversations.js";
import { exportConversation } from "./exportmd.js";

let wired = false;
let items = []; // flat list of currently-shown selectable entries
let active = 0;

function actionEntries() {
  const s = t();
  return [
    { kind: "action", label: s.actNewChat, run: () => newChat() },
    { kind: "action", label: s.actExport, run: () => exportConversation() },
  ];
}

function build(query) {
  const q = fold(query.trim());
  const list = $("palette-list");
  list.innerHTML = "";
  items = [];

  const acts = actionEntries().filter((a) => !q || fold(a.label).includes(q));
  const convs = getConvCache()
    .filter((c) => !q || fold(c.title).includes(q) || fold(c.preview || "").includes(q))
    .slice(0, 8)
    .map((c) => ({
      kind: "conv",
      label: c.title,
      sub: c.preview || "",
      run: () => openConversation(c.id),
    }));

  const section = (title, rows) => {
    if (!rows.length) return;
    list.append(el("div", "palette-group", escapeHtml(title)));
    rows.forEach((r) => {
      const i = items.length;
      items.push(r);
      const row = el("div", "palette-item");
      row.append(el("div", "palette-item-label", escapeHtml(r.label)));
      if (r.sub) row.append(el("div", "palette-item-sub", escapeHtml(r.sub)));
      row.onmousedown = (e) => {
        e.preventDefault();
        choose(i);
      };
      row.onmousemove = () => setActive(i);
      list.append(row);
    });
  };
  section(t().paletteActions, acts);
  section(t().paletteConvs, convs);
  active = 0;
  paintActive();
}

function paintActive() {
  [...$("palette-list").querySelectorAll(".palette-item")].forEach((r, i) =>
    r.classList.toggle("active", i === active),
  );
}
function setActive(i) {
  active = i;
  paintActive();
}

function choose(i) {
  const it = items[i];
  close();
  it?.run();
}

export function openPalette() {
  wire();
  $("palette").hidden = false;
  const input = $("palette-input");
  input.value = "";
  input.placeholder = t().paletteHint;
  build("");
  input.focus();
}

export function close() {
  $("palette").hidden = true;
}

function wire() {
  if (wired) return;
  wired = true;
  const input = $("palette-input");
  input.addEventListener("input", () => build(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length) setActive((active + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) setActive((active - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items.length) choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  $("palette-backdrop").onclick = close;
}
