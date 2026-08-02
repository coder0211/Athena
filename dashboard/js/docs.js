// Documents tab: manage scan folders, upload files, list indexed documents,
// and trigger an incremental re-index (docs only — no full code rebuild).
import { $, el, escapeHtml } from "./dom.js";
import { api } from "./api.js";
import { refreshStatus } from "./stats.js";

const fmtSize = (b) => {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
};

// A folder is user-owned (deletable via the upload API) when it lives under
// .docs/uploads/; configured external folders are managed by the user directly.
const isUpload = (path) => /(^|\/)\.docs\/uploads\//.test(path || "");

// --- folders --------------------------------------------------------------
function folderRow(path = "") {
  const row = el("div", "repo-row");
  const inp = el("input", "doc-folder");
  inp.value = path;
  inp.placeholder = "./product-specs  or  /Users/me/Drive/specs";
  const del = el("button", "icon-btn", "✕");
  del.type = "button";
  del.title = "Remove";
  del.onclick = () => row.remove();
  row.append(inp, del);
  return row;
}

async function loadDocFolders() {
  const rows = $("doc-folder-rows");
  rows.innerHTML = "";
  const cfg = await api.get("/api/docs/folders");
  $("docs-supported").textContent = (cfg.supported || []).join(", ");
  (cfg.folders.length ? cfg.folders : [""]).forEach((f) => rows.append(folderRow(f)));
}

$("add-doc-folder").onclick = () => $("doc-folder-rows").append(folderRow());

$("save-doc-folders").onclick = async () => {
  const folders = [...$("doc-folder-rows").children]
    .map((r) => r.querySelector(".doc-folder").value.trim())
    .filter(Boolean);
  const msg = $("doc-folders-msg");
  try {
    await api.put("/api/docs/folders", { folders });
    msg.textContent = `Saved ${folders.length} folder(s) — reindex to apply`;
    msg.className = "msg ok";
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "msg err";
  }
};

// --- upload ---------------------------------------------------------------
async function uploadFiles(files) {
  const msg = $("doc-upload-msg");
  let ok = 0;
  const errs = [];
  for (const file of files) {
    try {
      await api.upload("/api/docs/upload", file);
      ok++;
    } catch (e) {
      errs.push(`${file.name}: ${e.message}`);
    }
  }
  msg.className = "msg " + (errs.length ? "err" : "ok");
  msg.innerHTML =
    `Uploaded ${ok} file(s)` +
    (errs.length ? ` · ${errs.length} failed: ${escapeHtml(errs.join("; "))}` : "") +
    (ok ? " — click <b>Reindex documents</b> to index them." : "");
}

function wireUpload() {
  const zone = $("doc-dropzone");
  const input = $("doc-file-input");
  $("doc-browse").onclick = () => input.click();
  input.onchange = () => input.files.length && uploadFiles([...input.files]);
  ["dragover", "dragenter"].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
    }),
  );
  zone.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) uploadFiles(files);
  });
}

// --- indexed documents list ----------------------------------------------
async function loadDocList() {
  const list = $("doc-list");
  list.innerHTML = "";
  let docs = [];
  try {
    docs = await api.get("/api/docs");
  } catch {
    list.innerHTML = `<p class="hint">Build the graph first to see indexed documents.</p>`;
    return;
  }
  $("doc-count").textContent = docs.length ? `${docs.length} document(s)` : "";
  if (!docs.length) {
    list.innerHTML = `<p class="hint">No documents indexed yet. Add a folder or upload files, then reindex.</p>`;
    return;
  }
  docs.forEach((d) => {
    const row = el("div", "doc-row");
    const meta =
      `<span class="doc-name" title="${escapeHtml(d.path || "")}">${escapeHtml(d.name)}</span>` +
      `<span class="doc-tag">${escapeHtml(d.file_type || "?")}</span>` +
      `<span class="doc-sub">${d.sections ?? "?"} sections · ${fmtSize(d.size_bytes)}</span>`;
    row.innerHTML = `<div class="doc-meta">${meta}</div>`;
    if (isUpload(d.path)) {
      const del = el("button", "icon-btn", "✕");
      del.type = "button";
      del.title = "Delete uploaded file (reindex to apply)";
      del.onclick = async () => {
        if (!confirm(`Delete uploaded file "${d.name}"?`)) return;
        try {
          await api.del("/api/docs/upload/" + encodeURIComponent(d.name));
          row.remove();
        } catch (e) {
          alert(e.message);
        }
      };
      row.append(del);
    }
    list.append(row);
  });
}

// --- reindex (background job) ---------------------------------------------
async function pollReindex(jobId) {
  const box = $("doc-reindex-status");
  const tick = async () => {
    const j = await api.get("/api/jobs/" + jobId);
    const spin = j.status === "running" ? '<span class="spinner"></span>' : "";
    let detail = "";
    if (j.status === "succeeded" && j.result) {
      const r = j.result;
      detail =
        `<div class="msg ok">Indexed ${r.documents} document(s), ${r.sections} sections, ` +
        `${r.mentions} code link(s)` +
        (r.errors?.length ? ` · ${r.errors.length} skipped` : "") +
        `.</div>`;
    }
    box.innerHTML =
      `<div class="job-line">${spin}<b>Reindex documents</b>` +
      `<span class="badge ${j.status}">${j.status}</span></div>` +
      (j.error ? `<div class="msg err">${escapeHtml(j.error)}</div>` : detail);
    if (j.status === "running") setTimeout(tick, 1000);
    else {
      loadDocList();
      refreshStatus();
    }
  };
  tick();
}

$("doc-reindex").onclick = async () => {
  const box = $("doc-reindex-status");
  try {
    const { job_id } = await api.post("/api/docs/reindex");
    pollReindex(job_id);
  } catch (e) {
    box.innerHTML = `<div class="msg err">${escapeHtml(e.message)}</div>`;
  }
};

export async function loadDocs() {
  wireUpload();
  await Promise.all([loadDocFolders(), loadDocList()]);
}
