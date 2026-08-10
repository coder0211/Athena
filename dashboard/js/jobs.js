// Fetch & Build pipeline: kick off background jobs and poll their status.
import { $, el, escapeHtml, askConfirm } from "./dom.js";
import { api } from "./api.js";
import { refreshStatus } from "./stats.js";

// Human labels for the pipeline phases the backend reports via job.progress, so
// a long build shows what it's doing ("Extracting repo 2/5") instead of a frozen
// spinner.
const PHASE_LABELS = {
  fetch: "Cloning repositories",
  extract: "Extracting code structure",
  cluster: "Detecting concept communities",
  documents: "Indexing documents",
  store: "Saving the graph",
  done: "Finishing up",
};

function progressLine(p) {
  if (!p || !p.phase) return "";
  const label = PHASE_LABELS[p.phase] || p.phase;
  const count = p.total ? ` ${Math.min(p.current + 1, p.total)}/${p.total}` : "";
  const detail = p.detail ? ` · ${escapeHtml(p.detail)}` : "";
  const pct = p.total ? Math.round((p.current / p.total) * 100) : null;
  const bar =
    pct === null
      ? ""
      : `<div class="job-bar"><span style="width:${pct}%"></span></div>`;
  return `<div class="job-progress">${escapeHtml(label)}${count}${detail}</div>${bar}`;
}

async function pollJob(jobId, kind) {
  const box = $("job-status");
  const card = el("div", "job");
  box.prepend(card);
  const tick = async () => {
    const j = await api.get("/api/jobs/" + jobId);
    const spin = j.status === "running" ? '<span class="spinner"></span>' : "";
    const secs = (j.finished || Date.now() / 1000) - j.started || 0;
    const dur = secs < 60 ? `${secs.toFixed(0)}s` : `${(secs / 60).toFixed(1)}m`;
    card.innerHTML =
      `<div class="job-line">${spin}<b>${kind}</b>` +
      `<span class="badge ${j.status}">${j.status}</span>` +
      `<span class="job-time">${dur}</span></div>` +
      (j.status === "running" ? progressLine(j.progress) : "") +
      (j.error ? `<div class="msg err">${escapeHtml(j.error)}</div>` : "");
    if (j.status === "running") setTimeout(tick, 1000);
    else refreshStatus();
  };
  tick();
}

$("run-fetch").onclick = async () => {
  const { job_id } = await api.post("/api/fetch");
  pollJob(job_id, "Fetch");
};
$("run-build").onclick = async () => {
  const { job_id } = await api.post("/api/build");
  pollJob(job_id, "Build");
};

// Clear the built graph data (graph + communities + document index). Destructive
// and not undoable, so it's gated behind a confirm; inputs (repos, uploads) stay.
$("clear-graph").onclick = async () => {
  const ok = await askConfirm({
    title: "Clear graph data",
    message:
      "Delete the current knowledge graph — code structure, concept communities, " +
      "and the document index? Your repo list and uploaded files are kept, so you " +
      "can rebuild it. This can't be undone.",
    ok: "Clear graph",
    danger: true,
  });
  if (!ok) return;
  const btn = $("clear-graph");
  btn.disabled = true;
  try {
    const r = await api.del("/api/graph");
    refreshStatus();
    showJobNote(`Cleared: ${(r.cleared || []).join(", ") || "nothing"} — rebuild to recreate the graph.`, "ok");
  } catch (e) {
    // 404 = nothing was built yet; surface the message either way.
    showJobNote(e.message || "Could not clear the graph.", "err");
  } finally {
    btn.disabled = false;
  }
};

// A one-off status line under the pipeline (reuses the job-status area).
function showJobNote(text, kind) {
  const note = el("div", "job");
  note.innerHTML = `<div class="msg ${kind === "err" ? "err" : "ok"}">${escapeHtml(text)}</div>`;
  $("job-status").prepend(note);
}
