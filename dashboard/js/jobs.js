// Fetch & Build pipeline: kick off background jobs and poll their status.
import { $, el, escapeHtml } from "./dom.js";
import { api } from "./api.js";
import { refreshStatus } from "./stats.js";

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
