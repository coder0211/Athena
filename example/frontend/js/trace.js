// Investigation trace: the step-by-step of tools Athena runs while answering.
// Shown live (with a working spinner) above the streaming answer, then collapsed
// into a one-line "Looked at N steps" summary that expands on click. Reuses the
// i18n status labels (already localized) so each step reads naturally. Repeated
// identical steps (the model re-reading the same symbol) collapse into one row
// with a ×N counter so the list stays readable.
import { el, escapeHtml, ICON_SEARCH, ICON_CHEVRON } from "./dom.js";
import { t, statusLabel } from "./i18n.js";

// A short, human target for a step. Prefer the backend-resolved `target` (a
// symbol name / file / query); fall back to mining the raw tool input for older
// saved conversations that predate it — but never show a bare node-id hash.
function stepTarget(step) {
  if (step && step.target) return truncate(step.target);
  const input = step && step.input;
  if (!input || typeof input !== "object") return "";
  const raw = input.query ?? (input.repo && input.path ? input.repo + "/" + input.path : input.path) ?? input.community ?? "";
  return truncate(String(raw).trim());
}
function truncate(s) {
  return s.length > 48 ? s.slice(0, 47) + "…" : s;
}
function stepKey(step) {
  return step.tool + "|" + stepTarget(step);
}

function makeRow(step) {
  const row = el("div", "trace-step");
  row.append(el("span", "trace-label", escapeHtml(statusLabel(step.tool))));
  const target = stepTarget(step);
  if (target) row.append(el("span", "trace-target", escapeHtml(target)));
  const count = el("span", "trace-count"); // only revealed once a step repeats
  count.hidden = true;
  row.append(count);
  row._count = 1;
  row._countEl = count;
  return row;
}
function bumpRow(row) {
  row._countEl.textContent = "×" + ++row._count;
  row._countEl.hidden = false;
}

// Create a trace panel. Returns the node plus live controls:
//   addStep(step) — append a row while streaming and reflect it in the header
//   finalize(steps) — swap in the final steps and collapse to the summary
export function createTrace() {
  const node = el("div", "trace working open");
  const head = el("button", "trace-head");
  head.type = "button";
  head.append(el("span", "trace-ic", ICON_SEARCH));
  const label = el("span", "trace-headline", escapeHtml(t().trace.working));
  const chev = el("span", "trace-chev", ICON_CHEVRON);
  head.append(label, chev);
  const list = el("div", "trace-steps");
  node.append(head, list);
  head.onclick = () => node.classList.toggle("open");

  const summarize = (n) => {
    const s = t().trace;
    return `${s.done} ${n} ${n === 1 ? s.step : s.steps}`;
  };

  // Append a step, collapsing a consecutive repeat into the previous row's ×N.
  let lastRow = null;
  let lastKey = null;
  let distinct = 0;
  const push = (step) => {
    const key = stepKey(step);
    if (lastRow && key === lastKey) {
      bumpRow(lastRow);
      return;
    }
    lastRow = makeRow(step);
    lastKey = key;
    distinct += 1;
    list.append(lastRow);
  };

  return {
    node,
    addStep(step) {
      push(step);
      list.scrollTop = list.scrollHeight; // keep the newest step in view
      label.textContent = statusLabel(step.tool); // header tracks the latest action
    },
    finalize(steps) {
      list.innerHTML = "";
      lastRow = lastKey = null;
      distinct = 0;
      (steps || []).forEach(push);
      label.textContent = summarize(distinct); // count distinct rows, not raw repeats
      node.classList.remove("working", "open"); // done → collapse to the summary
    },
  };
}

// A finalized, collapsed trace built from stored steps (used when re-opening a
// saved conversation, where there's no live stream to attach to).
export function staticTrace(steps) {
  if (!steps?.length) return null;
  const tr = createTrace();
  tr.finalize(steps);
  return tr.node;
}
