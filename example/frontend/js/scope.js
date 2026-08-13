// Scope chips shown above the composer (@repo / #symbol the question is
// narrowed to). Renders from S.scopeRepos / S.scopeSymbols.
import { $, el, escapeHtml, ICON_DOC, ICON_FOLDER } from "./dom.js";
import { S } from "./state.js";

export function renderScope() {
  const bar = $("scope-bar");
  bar.innerHTML = "";
  S.scopeRepos.forEach((r, i) =>
    bar.append(
      scopeChip("", "/" + r, "repo", () => {
        S.scopeRepos.splice(i, 1);
        renderScope();
      }),
    ),
  );
  S.scopeSymbols.forEach((s, i) =>
    bar.append(
      scopeChip("", "#" + s.name, "symbol", () => {
        S.scopeSymbols.splice(i, 1);
        renderScope();
      }),
    ),
  );
  S.scopeDocs.forEach((d, i) =>
    bar.append(
      scopeChip(ICON_DOC, d.name, "doc", () => {
        S.scopeDocs.splice(i, 1);
        renderScope();
      }),
    ),
  );
  S.scopeFolders.forEach((f, i) =>
    bar.append(
      scopeChip(ICON_FOLDER, f.label, "doc", () => {
        S.scopeFolders.splice(i, 1);
        renderScope();
      }),
    ),
  );
  S.scopeTools.forEach((t, i) =>
    bar.append(
      scopeChip("", "@" + t.label, "tool", () => {
        S.scopeTools.splice(i, 1);
        renderScope();
      }),
    ),
  );
}

function scopeChip(icon, label, kind, onRemove) {
  const chip = el("span", "scope-chip " + kind, (icon ? icon + " " : "") + escapeHtml(label));
  const x = el("button", null, "×");
  x.type = "button";
  x.onclick = onRemove;
  chip.append(x);
  return chip;
}
