// Documents tab: manage scan folders, upload files, list indexed documents,
// and trigger an incremental re-index (docs only — no full code rebuild).
import { $, el, escapeHtml, askConfirm } from "./dom.js";
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
const isUpload = (path) => /(^|\/)\.docs\/uploads(\/|$)/.test(path || "");

// Supported file extensions (filled from /api/docs/folders) — used to skip
// non-document files client-side when a whole folder is dropped/picked.
let SUPPORTED = [];
const extOf = (name) => {
  const i = (name || "").lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
};
const trimSlashes = (s) => (s || "").replace(/^\/+|\/+$/g, "");
// path under .docs/uploads/ ("" for the uploads root itself) — used for the API
const uploadRel = (path) => (path || "").replace(/^\.docs\/uploads\/?/, "");
// encode a relative path for a URL while keeping the "/" separators
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");

// Inline SVG line icons (Lucide-style: 24×24, stroke=currentColor) — crisp and
// theme-aware, unlike emoji. `icon(name, cls)` returns markup; paths only here.
const ICON_PATHS = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderOpen:
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  file:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  fileText:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  table:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  pencil:
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  folderPlus:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
  expand: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/>',
  collapse: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 12h8"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
};
const icon = (name, cls = "") =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `${ICON_PATHS[name] || ICON_PATHS.file}</svg>`;

// Map a filename to a file-type icon name + a colour class (IDE-style: docs
// blue, sheets green, PDFs red, everything else muted) for quick scanning.
const SHEET_EXT = new Set([".csv", ".tsv", ".xls", ".xlsx"]);
const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".rst", ".log", ".doc", ".docx", ".rtf", ".odt",
]);
const fileIconName = (name) => {
  const e = extOf(name);
  if (SHEET_EXT.has(e)) return "table";
  if (TEXT_EXT.has(e)) return "fileText";
  return "file";
};
const fileIconClass = (name) => {
  const e = extOf(name);
  if (SHEET_EXT.has(e)) return "ico-sheet";
  if (e === ".pdf") return "ico-pdf";
  if (TEXT_EXT.has(e)) return "ico-doc";
  return "ico-file";
};

// Remember which folders the user collapsed, keyed by their raw path, so the tree
// keeps its shape across reloads/reindexes (IDE explorers persist expand state).
const COLLAPSE_KEY = "athena.docs.collapsed";
function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* storage may be unavailable (private mode) — state just won't persist */
  }
}
let collapsed = loadCollapsed();

// Whole document set (kept so the filter box can re-render without a refetch).
let allDocs = [];
// Every upload subfolder path (relative to uploads/), so folders with no files
// still appear in the tree as drag/upload targets.
let uploadDirs = [];

// --- docs config ----------------------------------------------------------
// Load the supported file extensions (used to filter folder drops) and show them
// in the intro line. External scan-folders (docs.yaml) aren't managed here — the
// dashboard's flow is Upload + tree; folders would need a container-visible path.
async function loadDocsMeta() {
  try {
    const cfg = await api.get("/api/docs/folders");
    SUPPORTED = cfg.supported || [];
    $("docs-supported").textContent = SUPPORTED.join(", ");
  } catch {
    /* optional */
  }
}

// --- upload ---------------------------------------------------------------
// Items are {file, relDir}: relDir is the file's own subfolder chain (from a
// folder pick/drop), which we prefix with the user's Target folder so the tree
// is preserved on the server.
async function uploadItems(items) {
  const msg = $("doc-upload-msg");
  const target = trimSlashes($("doc-target-folder").value.trim());
  // keep only supported document types; count the rest as skipped
  const docs = items.filter((it) => !SUPPORTED.length || SUPPORTED.includes(extOf(it.file.name)));
  const skipped = items.length - docs.length;
  if (!docs.length) {
    msg.className = "msg err";
    msg.textContent = skipped ? `No supported documents (skipped ${skipped}).` : "No files.";
    return;
  }
  let ok = 0;
  const errs = [];
  // Aggregate progress bar across all files (byte-weighted).
  const totalBytes = docs.reduce((n, it) => n + (it.file.size || 0), 0);
  let uploadedBytes = 0;
  const renderProgress = (cur, n) => {
    const pct = totalBytes ? Math.round(((uploadedBytes + cur) / totalBytes) * 100) : 0;
    msg.className = "msg";
    msg.innerHTML =
      `<div class="upload-progress"><div class="upload-bar" style="width:${pct}%"></div></div>` +
      `<div class="upload-progress-label">Uploading ${n} of ${docs.length}… ${pct}%</div>`;
  };
  renderProgress(0, 1);
  let idx = 0;
  for (const { file, relDir } of docs) {
    idx++;
    const sub = trimSlashes([target, relDir].filter(Boolean).join("/"));
    try {
      await api.uploadWithProgress("/api/docs/upload", file, sub, (loaded) =>
        renderProgress(loaded, idx),
      );
      ok++;
    } catch (e) {
      errs.push(`${file.name}: ${e.message}`);
    }
    uploadedBytes += file.size || 0;
  }
  msg.className = "msg " + (errs.length ? "err" : "ok");
  msg.innerHTML =
    `Uploaded ${ok} file(s)` +
    (skipped ? ` · skipped ${skipped} non-document` : "") +
    (errs.length ? ` · ${errs.length} failed: ${escapeHtml(errs.join("; "))}` : "") +
    (ok ? " — indexing…" : "");
  if (ok) runReindex(); // index the new files automatically
}

// Flat FileList → items. `webkitRelativePath` is set when a folder is picked
// (webkitdirectory); its leading folder name is kept so the tree is preserved.
const filesToItems = (files) =>
  [...files].map((f) => {
    const rel = f.webkitRelativePath || "";
    const relDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    return { file: f, relDir };
  });

// Recursively read a dropped directory tree via the (webkit) entries API, so a
// dropped folder keeps its structure. Falls back to flat files if unsupported.
function readEntries(reader) {
  return new Promise((res, rej) => reader.readEntries(res, rej));
}
async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, relDir: prefix });
  } else if (entry.isDirectory) {
    const dir = [prefix, entry.name].filter(Boolean).join("/");
    const reader = entry.createReader();
    let batch;
    do {
      batch = await readEntries(reader);
      for (const e of batch) await walkEntry(e, dir, out);
    } while (batch.length);
  }
}
async function itemsFromDrop(dt) {
  const entries = [...(dt.items || [])]
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length) {
    const out = [];
    for (const e of entries) await walkEntry(e, "", out);
    return out;
  }
  return [...(dt.files || [])].map((f) => ({ file: f, relDir: "" }));
}

// Show exactly where files will land as the user types the target folder, so the
// field isn't a mystery box. Drop-a-folder note reminds that structure is kept.
function updateDestHint() {
  const v = trimSlashes($("doc-target-folder").value.trim());
  $("doc-dest-hint").innerHTML = v
    ? `New files go to <b>uploads/${escapeHtml(v)}/</b> · drop a folder to keep its structure`
    : `New files go to <b>uploads/</b> (root) · pick or type a subfolder above, or drop a folder to keep its structure`;
}

// Offer the existing upload subfolders as autocomplete options.
function populateFolderOptions(docs) {
  const set = new Set();
  for (const d of docs) {
    if (!isUpload(d.path)) continue;
    const parts = uploadRel(d.path).split("/");
    parts.pop(); // drop the filename
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  const dl = $("doc-folder-list");
  dl.innerHTML = "";
  [...set].sort().forEach((p) => {
    const o = document.createElement("option");
    o.value = p;
    dl.append(o);
  });
}

function wireUpload() {
  const zone = $("doc-dropzone");
  const ico = $("doc-dropzone-ico");
  if (ico) ico.innerHTML = icon("upload");
  const fileInput = $("doc-file-input");
  const folderInput = $("doc-folder-input");
  $("doc-target-folder").oninput = updateDestHint;
  updateDestHint();
  $("doc-browse").onclick = () => fileInput.click();
  $("doc-browse-folder").onclick = () => folderInput.click();
  fileInput.onchange = () => fileInput.files.length && uploadItems(filesToItems(fileInput.files));
  folderInput.onchange = () =>
    folderInput.files.length && uploadItems(filesToItems(folderInput.files));
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
  zone.addEventListener("drop", async (e) => {
    const items = await itemsFromDrop(e.dataTransfer);
    if (items.length) uploadItems(items);
  });
}

// --- indexed documents list ----------------------------------------------
// Centered empty/placeholder state with a big muted icon. `html` may contain
// markup (callers escape any dynamic text).
const emptyState = (iconName, html) =>
  `<div class="doc-empty">${icon(iconName)}<p>${html}</p></div>`;

// Shimmer placeholders shaped like a folder tree, shown while the first load is
// in flight (skipped on refreshes, where content is already on screen).
function renderDocSkeleton() {
  const row = (w, indent) =>
    `<div class="doc-skel-row${indent ? " indent" : ""}">` +
    `<span class="skel-ico"></span><span class="skel-bar" style="width:${w}"></span></div>`;
  $("doc-list").innerHTML =
    `<div class="doc-skeleton" aria-hidden="true">` +
    row("32%") + row("56%", true) + row("44%", true) + row("50%", true) +
    row("28%") + row("40%", true) + row("48%", true) +
    `</div>`;
}

async function loadDocList() {
  if (!allDocs.length && !uploadDirs.length) renderDocSkeleton(); // initial load only
  let docs = [];
  try {
    docs = await api.get("/api/docs");
  } catch {
    allDocs = [];
    $("doc-list").innerHTML = emptyState("file", "Build the graph first to see indexed documents.");
    $("doc-tree-toolbar")?.style.setProperty("display", "none");
    return;
  }
  allDocs = docs;
  // Upload subfolders (incl. empty ones) so they render even with no files yet.
  try {
    uploadDirs = (await api.get("/api/docs/folders")).dirs || [];
  } catch {
    uploadDirs = [];
  }
  populateFolderOptions(docs); // refresh the "Save into folder" autocomplete
  $("doc-count").textContent = docs.length ? `${docs.length} document(s)` : "";
  $("doc-tree-toolbar")?.style.setProperty("display", "flex"); // New-folder is always available
  renderDocTree();
}

// Build + paint the tree from `allDocs` + `uploadDirs`, honouring the filter box.
// When a filter is active every matching folder is force-expanded (so hits are
// always visible); otherwise each folder's saved collapse state applies.
function renderDocTree() {
  const list = $("doc-list");
  list.innerHTML = "";
  if (!allDocs.length && !uploadDirs.length) {
    list.innerHTML = emptyState(
      "folderOpen",
      "No documents indexed yet.<br>Drag files above or create a folder — they index automatically.",
    );
    return;
  }
  const q = ($("doc-filter")?.value || "").trim().toLowerCase();
  const docs = q
    ? allDocs.filter((d) => (d.path || d.name || "").toLowerCase().includes(q))
    : allDocs;
  const dirs = q ? uploadDirs.filter((d) => d.toLowerCase().includes(q)) : uploadDirs;
  if (!docs.length && !dirs.length) {
    list.innerHTML = emptyState("file", `No documents match “${escapeHtml(q)}”.`);
    return;
  }
  const tree = buildTree(docs);
  for (const rel of dirs) addUploadDir(tree, rel); // graft in empty/known folders
  compress(tree);
  renderTree(tree, list, !!q);
}

// Ensure the folder chain `rel` (relative to uploads/) exists in `root`, creating
// empty dir nodes as needed. buildTree nests upload docs under their full
// PROJECT_ROOT-relative path (".docs" → "uploads" → …), so we traverse the same
// components and raw paths — otherwise the folder lands in a duplicate subtree and
// isUpload/uploadRel/drag-drop break.
function addUploadDir(root, rel) {
  const parts = [".docs", "uploads", ...rel.split("/").filter(Boolean)];
  let node = root;
  const acc = [];
  for (const p of parts) {
    acc.push(p);
    const raw = acc.join("/");
    if (!node.dirs.has(p)) node.dirs.set(p, { name: p, path: raw, dirs: new Map(), files: [] });
    node = node.dirs.get(p);
  }
}

// Group documents into a directory tree keyed by their path components (the last
// component is the file). `path` is the node's full raw prefix (for the manage
// API). { name, path, dirs: Map<name,node>, files: [doc] }.
function buildTree(docs) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const d of docs) {
    const parts = (d.path || d.name).split("/").filter(Boolean);
    parts.pop(); // drop the filename
    let node = root;
    const acc = [];
    for (const p of parts) {
      acc.push(p);
      const raw = acc.join("/");
      if (!node.dirs.has(p)) node.dirs.set(p, { name: p, path: raw, dirs: new Map(), files: [] });
      node = node.dirs.get(p);
    }
    node.files.push(d);
  }
  return root;
}

// Collapse single-child folder chains into one row (".docs/uploads/guides")
// so deep prefixes stay readable. `path` keeps the deepest raw prefix.
function compress(node) {
  for (const child of node.dirs.values()) {
    compress(child);
    while (child.files.length === 0 && child.dirs.size === 1) {
      const grand = [...child.dirs.values()][0];
      child.name += "/" + grand.name;
      child.path = grand.path;
      child.dirs = grand.dirs;
      child.files = grand.files;
    }
  }
}

const countFiles = (node) =>
  node.files.length + [...node.dirs.values()].reduce((n, d) => n + countFiles(d), 0);

function renderTree(node, container, filtering) {
  [...node.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((dir) => {
      const det = el("details", "doc-folder-node");
      // While filtering, force-open so matches are visible; otherwise honour the
      // user's saved collapse state (default open).
      det.open = filtering || !collapsed.has(dir.path);
      const sum = el(
        "summary",
        "doc-folder-sum",
        `<span class="doc-twist">${icon("chevron")}</span>` +
          `<span class="doc-fico">${icon("folder", "ico-folder")}${icon("folderOpen", "ico-folder-open")}</span>` +
          `<span class="doc-folder-name">${escapeHtml(dir.name)}</span>` +
          `<span class="doc-sub">${countFiles(dir) || "empty"}</span>`,
      );
      // Persist expand/collapse as the user toggles (skipped during filtering,
      // where open state is transient).
      det.addEventListener("toggle", () => {
        if (filtering) return;
        if (det.open) collapsed.delete(dir.path);
        else collapsed.add(dir.path);
        saveCollapsed();
      });
      // rel is the folder's path under uploads/: "" is the uploads root itself
      // (a drop target for "move to root", but you can't rename/delete/drag it),
      // a non-empty string is a normal upload subfolder, null is external.
      const rel = isUpload(dir.path) ? uploadRel(dir.path) : null;
      if (rel !== null) {
        if (rel !== "") {
          const acts = el("div", "doc-acts");
          acts.append(actionBtn(icon("pencil"), "Rename / move folder", () => renameFolder(dir)));
          acts.append(actionBtn(icon("trash"), "Delete folder and its contents", () => deleteFolder(dir)));
          sum.append(acts);
          makeDraggable(sum, rel); // drag the folder by its row
        }
        makeDropTarget(det, rel); // drop files/folders into here (root or subfolder)
      } else {
        const ext = el("span", "doc-ext", "external");
        sum.append(ext);
      }
      det.append(sum);
      const inner = el("div", "doc-folder-children");
      renderTree(dir, inner, filtering);
      det.append(inner);
      container.append(det);
    });
  node.files
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .forEach((d) => container.append(fileRow(d)));
}

function fileRow(d) {
  const row = el("div", "doc-row");
  const meta =
    `<span class="doc-file-ico ${fileIconClass(d.name)}">${icon(fileIconName(d.name))}</span>` +
    `<button type="button" class="doc-name doc-name-btn" title="${escapeHtml(d.path || "")} — click to preview">${escapeHtml(d.name)}</button>` +
    `<span class="doc-tag">${escapeHtml(d.file_type || "?")}</span>` +
    `<span class="doc-sub">${d.sections ?? "?"} sections · ${fmtSize(d.size_bytes)}</span>`;
  row.innerHTML = `<div class="doc-meta">${meta}</div>`;
  row.querySelector(".doc-name-btn").onclick = (e) => {
    e.stopPropagation();
    openPreview(d);
  };
  if (isUpload(d.path)) {
    const acts = el("div", "doc-acts");
    acts.append(actionBtn(icon("pencil"), "Rename / move file", () => moveFile(d)));
    acts.append(actionBtn(icon("trash"), "Delete uploaded file", () => deleteFile(d, row)));
    row.append(acts);
    makeDraggable(row, uploadRel(d.path)); // drag the file onto a folder to move it
  }
  return row;
}

// --- themed text-input modal (replaces the native prompt()) --------------
// Returns a Promise<string|null> — the entered text, or null if cancelled.
function askText({ title, label = "", value = "", placeholder = "", ok = "OK" }) {
  return new Promise((resolve) => {
    const dlg = el("dialog", "modal");
    dlg.innerHTML =
      `<form class="modal-card">` +
      `<h3 class="modal-title"></h3>` +
      (label ? `<label class="modal-label"></label>` : "") +
      `<input class="modal-input" type="text" autocomplete="off" spellcheck="false" />` +
      `<div class="modal-actions">` +
      `<button type="button" class="btn small" data-act="cancel">Cancel</button>` +
      `<button type="submit" class="btn small primary" data-act="ok"></button>` +
      `</div></form>`;
    dlg.querySelector(".modal-title").textContent = title;
    if (label) dlg.querySelector(".modal-label").textContent = label;
    dlg.querySelector('[data-act="ok"]').textContent = ok;
    const input = dlg.querySelector(".modal-input");
    input.value = value;
    input.placeholder = placeholder;

    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
      dlg.close();
      dlg.remove();
    };
    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      finish(input.value);
    });
    dlg.querySelector('[data-act="cancel"]').onclick = () => finish(null);
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(null);
    }); // Esc
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) finish(null);
    }); // backdrop

    document.body.append(dlg);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

// Transient toast notification (replaces alert()). type: "ok" | "err" | "info".
function toast(message, type = "info") {
  let host = $("toast-host");
  if (!host) {
    host = el("div", "toast-host");
    host.id = "toast-host";
    document.body.append(host);
  }
  const t = el("div", `toast toast-${type}`, escapeHtml(message));
  host.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    t.addEventListener("transitionend", () => t.remove(), { once: true });
  }, 4000);
}

// --- document preview -----------------------------------------------------
// Open a modal showing what Athena actually extracted from a document: its
// sections, each expandable to full passage text + the code symbols it links to.
async function openPreview(d) {
  const dlg = el("dialog", "modal modal-lg");
  dlg.innerHTML =
    `<div class="preview">` +
    `<div class="preview-head">` +
    `<span class="doc-file-ico">${icon(fileIconName(d.name))}</span>` +
    `<h3 class="modal-title"></h3>` +
    `<button type="button" class="icon-btn preview-close" title="Close" aria-label="Close">${icon("close")}</button>` +
    `</div>` +
    `<div class="preview-sub"></div>` +
    `<div class="preview-body"></div>` +
    `</div>`;
  dlg.querySelector(".modal-title").textContent = d.name;
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  dlg.querySelector(".preview-close").onclick = close;
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) close();
  });
  document.body.append(dlg);
  dlg.showModal();

  const body = dlg.querySelector(".preview-body");
  body.innerHTML = `<div class="preview-loading"><span class="spinner"></span> Loading…</div>`;
  let detail;
  try {
    detail = await api.get("/api/docs/detail?id=" + encodeURIComponent(d.id));
  } catch (e) {
    body.innerHTML = `<div class="msg err">${escapeHtml(e.message)}</div>`;
    return;
  }
  if (detail.error) {
    body.innerHTML = `<div class="msg err">${escapeHtml(detail.error)}</div>`;
    return;
  }
  const secs = detail.sections || [];
  dlg.querySelector(".preview-sub").textContent =
    `${(detail.file_type || "?").toUpperCase()} · ${secs.length} section(s) · ${fmtSize(detail.size_bytes)}`;
  body.innerHTML = "";
  if (!secs.length) {
    body.innerHTML = `<p class="hint">No sections were extracted from this document.</p>`;
    return;
  }
  secs.forEach((s, i) => body.append(previewSection(s, i)));
}

// One collapsible section row in the preview; its text is fetched lazily the
// first time it's opened.
function previewSection(s, i) {
  const det = el("details", "preview-section");
  const title = s.title || `Section ${i + 1}`;
  const loc = s.locator ? `<span class="doc-sub">${escapeHtml(s.locator)}</span>` : "";
  det.append(
    el(
      "summary",
      "preview-section-sum",
      `<span class="doc-twist">${icon("chevron")}</span>` +
        `<span class="preview-section-title">${escapeHtml(title)}</span>${loc}`,
    ),
  );
  const bodyEl = el("div", "preview-section-body");
  det.append(bodyEl);
  let loaded = false;
  det.addEventListener("toggle", async () => {
    if (!det.open || loaded) return;
    loaded = true;
    bodyEl.innerHTML = `<div class="preview-loading"><span class="spinner"></span></div>`;
    try {
      const p = await api.get("/api/docs/section?id=" + encodeURIComponent(s.id));
      const links = (p.mentions_code || [])
        .map((m) => `<span class="doc-tag">${escapeHtml(m.name || m.qualified_name || "?")}</span>`)
        .join("");
      bodyEl.innerHTML =
        (links ? `<div class="preview-mentions">Links to code: ${links}</div>` : "") +
        `<pre class="preview-text">${escapeHtml(p.text || "")}</pre>`;
    } catch (e) {
      loaded = false;
      bodyEl.innerHTML = `<div class="msg err">${escapeHtml(e.message)}</div>`;
    }
  });
  return det;
}

// --- manage folders/files (all auto-reindex after) -----------------------
// Icon button that runs `fn` without toggling its parent <details>.
function actionBtn(glyph, title, fn) {
  const b = el("button", "icon-btn", glyph);
  b.type = "button";
  b.title = title;
  b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  return b;
}

// Run a management op, then auto-reindex to apply it; surface errors.
async function manage(op) {
  try {
    await op();
    runReindex();
  } catch (e) {
    toast(e.message, "err");
  }
}

async function renameFolder(dir) {
  const cur = uploadRel(dir.path);
  const dst = await askText({
    title: "Rename / move folder",
    label: "Path under uploads/",
    value: cur,
    ok: "Save",
  });
  if (dst == null) return;
  const to = trimSlashes(dst);
  if (!to || to === cur) return;
  manage(() => api.post("/api/docs/move", { src: cur, dst: to }));
}

async function deleteFolder(dir) {
  const n = countFiles(dir);
  const message = n
    ? `“${dir.name}” and all ${n} file(s) inside it will be deleted. This cannot be undone.`
    : `The empty folder “${dir.name}” will be deleted.`;
  if (!(await askConfirm({ title: "Delete folder", message, ok: "Delete", danger: true }))) return;
  manage(() => api.del("/api/docs/folder/" + encPath(uploadRel(dir.path))));
}

// Create an empty folder under uploads/. No reindex (nothing to index) — just
// refresh the tree so the new folder shows as a drag/upload target.
async function newFolder() {
  const name = await askText({
    title: "New folder",
    label: "Path under uploads/",
    placeholder: "e.g. guides/onboarding",
    ok: "Create",
  });
  const rel = trimSlashes(name || "");
  if (!rel) return;
  try {
    await api.post("/api/docs/folder", { path: rel });
    await loadDocList();
    toast(`Folder “${rel}” created.`, "ok");
  } catch (e) {
    toast(e.message, "err");
  }
}

async function moveFile(d) {
  const cur = uploadRel(d.path);
  const dst = await askText({
    title: "Rename / move file",
    label: "Path under uploads/",
    value: cur,
    ok: "Save",
  });
  if (dst == null) return;
  const to = trimSlashes(dst);
  if (!to || to === cur) return;
  manage(() => api.post("/api/docs/move", { src: cur, dst: to }));
}

async function deleteFile(d, row) {
  const ok = await askConfirm({
    title: "Delete file",
    message: `“${d.name}” will be deleted and removed from the index.`,
    ok: "Delete",
    danger: true,
  });
  if (!ok) return;
  manage(async () => {
    await api.del("/api/docs/upload/" + encPath(uploadRel(d.path)));
    row.remove();
  });
}

// --- drag & drop move ----------------------------------------------------
// The path (under uploads/) of the file or folder currently being dragged.
let dragSrc = null;

// Move `srcRel` into folder `destRel` ("" = uploads root), guarding no-ops and
// moving a folder into itself/a descendant. Then auto-reindex.
function moveInto(srcRel, destRel) {
  if (!srcRel) return;
  const name = srcRel.split("/").pop();
  const dst = destRel ? `${destRel}/${name}` : name;
  if (dst === srcRel) return; // already there
  if (destRel === srcRel || destRel.startsWith(srcRel + "/")) return; // into itself/child
  manage(() => api.post("/api/docs/move", { src: srcRel, dst }));
}

function makeDraggable(elm, rel) {
  elm.draggable = true;
  elm.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    dragSrc = rel;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", rel);
  });
  elm.addEventListener("dragend", () => {
    dragSrc = null;
    document.querySelectorAll(".drop-hi").forEach((n) => n.classList.remove("drop-hi"));
  });
}

// Wire `elm` as a drop target that moves the dragged item into `destRel`.
function makeDropTarget(elm, destRel) {
  elm.addEventListener("dragover", (e) => {
    if (dragSrc == null) return;
    e.preventDefault();
    e.stopPropagation(); // closest folder wins; don't also mark the root
    e.dataTransfer.dropEffect = "move";
    elm.classList.add("drop-hi");
  });
  elm.addEventListener("dragleave", (e) => {
    if (!elm.contains(e.relatedTarget)) elm.classList.remove("drop-hi");
  });
  elm.addEventListener("drop", (e) => {
    if (dragSrc == null) return;
    e.preventDefault();
    e.stopPropagation();
    elm.classList.remove("drop-hi");
    moveInto(dragSrc, destRel);
  });
}

// --- reindex (background job) ---------------------------------------------
// Resolves when the job reaches a terminal state, so callers can chain a
// follow-up reindex without overlapping (see runReindex).
function pollReindex(jobId) {
  const box = $("doc-reindex-status");
  return new Promise((resolve) => {
    const tick = async () => {
      let j;
      try {
        j = await api.get("/api/jobs/" + jobId);
      } catch (e) {
        box.innerHTML = `<div class="msg err">${escapeHtml(e.message)}</div>`;
        return resolve();
      }
      const spin = j.status === "running" ? '<span class="spinner"></span>' : "";
      let detail = "";
      if (j.status === "succeeded" && j.result) {
        const r = j.result;
        const reused = r.reused != null ? `, reused ${r.reused} embedding(s)` : "";
        const n = r.errors?.length || 0;
        // List the actual files that failed so the user knows which to fix.
        const errBlock = n
          ? `<details class="reindex-errors"><summary>${n} file(s) skipped — couldn't be indexed</summary>` +
            `<ul>${r.errors.map((e) => `<li>${escapeHtml(String(e))}</li>`).join("")}</ul></details>`
          : "";
        detail =
          `<div class="msg ok">Indexed ${r.documents} document(s), ${r.sections} sections, ` +
          `${r.mentions} code link(s)${reused}` +
          (n ? ` · ${n} skipped` : "") +
          `.</div>` +
          errBlock;
      }
      box.innerHTML =
        `<div class="job-line">${spin}<b>Reindex documents</b>` +
        `<span class="badge ${j.status}">${j.status}</span></div>` +
        (j.error ? `<div class="msg err">${escapeHtml(j.error)}</div>` : detail);
      if (j.status === "running") {
        setTimeout(tick, 1000);
      } else {
        loadDocList();
        refreshStatus();
        resolve();
      }
    };
    tick();
  });
}

// Single-flight reindex: if one is already running, coalesce this request into a
// single follow-up run (so a Save + Upload in quick succession never launch two
// jobs that would both write graph.json and race).
let _reindexing = false;
let _reindexPending = false;
async function runReindex() {
  if (_reindexing) {
    _reindexPending = true;
    return;
  }
  _reindexing = true;
  const box = $("doc-reindex-status");
  try {
    const { job_id } = await api.post("/api/docs/reindex");
    await pollReindex(job_id);
  } catch (e) {
    box.innerHTML = `<div class="msg err">${escapeHtml(e.message)}</div>`;
  } finally {
    _reindexing = false;
    if (_reindexPending) {
      _reindexPending = false;
      runReindex();
    }
  }
}

$("doc-reindex").onclick = () => runReindex();

// --- tree toolbar (filter + expand/collapse all) --------------------------
// Set every rendered folder open/closed at once; the per-folder toggle listeners
// persist the new state (skipped while filtering, where it's transient).
function setAllFolders(open) {
  document.querySelectorAll("#doc-list .doc-folder-node").forEach((det) => {
    det.open = open;
  });
}

function wireTreeToolbar() {
  const filter = $("doc-filter");
  if (filter) filter.oninput = renderDocTree;
  const wire = (id, glyph, fn) => {
    const b = $(id);
    if (!b) return;
    b.innerHTML = icon(glyph);
    b.onclick = fn;
  };
  wire("doc-new-folder", "folderPlus", newFolder);
  wire("doc-expand-all", "expand", () => setAllFolders(true));
  wire("doc-collapse-all", "collapse", () => setAllFolders(false));
}

export async function loadDocs() {
  wireUpload();
  wireTreeToolbar();
  await Promise.all([loadDocsMeta(), loadDocList()]);
}
