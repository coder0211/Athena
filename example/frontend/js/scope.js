// Scope chips shown above the composer (@repo / #symbol the question is
// narrowed to). Renders from S.scopeRepos / S.scopeSymbols.
import { $, el, escapeHtml } from "./dom.js";
import { S } from "./state.js";

export function renderScope() {
  const bar = $("scope-bar");
  bar.innerHTML = "";
  S.scopeRepos.forEach((r, i) =>
    bar.append(
      scopeChip("@" + r, "repo", () => {
        S.scopeRepos.splice(i, 1);
        renderScope();
      }),
    ),
  );
  S.scopeSymbols.forEach((s, i) =>
    bar.append(
      scopeChip("#" + s.name, "symbol", () => {
        S.scopeSymbols.splice(i, 1);
        renderScope();
      }),
    ),
  );
  S.scopeDocs.forEach((d, i) =>
    bar.append(
      scopeChip("📄 " + d.name, "doc", () => {
        S.scopeDocs.splice(i, 1);
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
