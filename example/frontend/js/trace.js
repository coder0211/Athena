// Investigation trace: the step-by-step of tools Athena runs while answering.
// Shown live (with a working spinner) above the streaming answer, then collapsed
// into a one-line "Looked at N steps" summary that expands on click. Reuses the
// i18n status labels (already localized) so each step reads naturally, and pulls
// a concrete target (the query / file / passage) out of the step's tool input.
import { el, escapeHtml, ICON_SEARCH, ICON_CHEVRON } from "./dom.js";
import { t, statusLabel } from "./i18n.js";

// A short, human target for a step, taken from the tool's input arguments.
function stepTarget(input) {
  if (!input || typeof input !== "object") return "";
  const raw =
    input.query ??
    (input.repo ? input.repo + (input.path ? "/" + input.path : "") : null) ??
    input.path ??
    input.community ??
    input.node_id ??
    input.section_id ??
    input.doc_id ??
    "";
  const s = String(raw).trim();
  return s.length > 48 ? s.slice(0, 47) + "…" : s;
}

function stepRow(step) {
  const row = el("div", "trace-step");
  row.append(el("span", "trace-label", escapeHtml(statusLabel(step.tool))));
  const target = stepTarget(step.input);
  if (target) row.append(el("span", "trace-target", escapeHtml(target)));
  return row;
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

  return {
    node,
    addStep(step) {
      list.append(stepRow(step));
      list.scrollTop = list.scrollHeight; // keep the newest step in view
      label.textContent = statusLabel(step.tool); // header tracks the latest action
    },
    finalize(steps) {
      list.innerHTML = "";
      (steps || []).forEach((s) => list.append(stepRow(s)));
      label.textContent = summarize((steps || []).length);
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
