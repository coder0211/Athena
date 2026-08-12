// Voices tab: create/edit/delete voices (personas). A voice decides how an
// answer reads — its tone, structure, and intended reader. Built-in voices
// (Business, Technical) are shown read-only; custom ones are fully editable.
// Describe a reader and Athena drafts the instruction via /api/personas/generate.
// Voices are the building blocks agents speak in (see agents.js).
import { $, el, escapeHtml, askConfirm } from "./dom.js";
import { api } from "./api.js";
import { setDirty } from "./dirty.js";

let VOICES = [];
let lastDraft = null; // generate() extras (greeting/suggestions/followup_voice) to persist on save

function setMsg(node, text, kind) {
  node.textContent = text || "";
  node.className = "msg" + (kind ? " " + kind : "");
}

// --- list -----------------------------------------------------------------
function voiceCard(v) {
  const card = el("div", "agent-card");
  const refineN = (v.refinements || []).length;
  const badges =
    (v.builtin ? `<span class="agent-badge subtle">Built-in</span>` : "") +
    (refineN ? `<span class="agent-badge subtle">${refineN} refine${refineN === 1 ? "" : "s"}</span>` : "");
  const acts = v.builtin
    ? `<span class="agent-badge subtle">Read-only</span>`
    : `<button class="btn small" data-act="edit" type="button">Edit</button>` +
      `<button class="btn small danger" data-act="del" type="button">Delete</button>`;
  card.innerHTML =
    `<div class="agent-card-main">` +
    `<div class="agent-card-head"><span class="agent-name"></span></div>` +
    (v.description ? `<div class="agent-desc"></div>` : "") +
    (badges ? `<div class="agent-badges">${badges}</div>` : "") +
    `</div>` +
    `<div class="agent-card-acts">${acts}</div>`;
  card.querySelector(".agent-name").textContent = v.label;
  if (v.description) card.querySelector(".agent-desc").textContent = v.description;
  card.querySelector('[data-act="edit"]')?.addEventListener("click", () => openEditor(v));
  card.querySelector('[data-act="del"]')?.addEventListener("click", () => removeVoice(v));
  return card;
}

function renderList() {
  const list = $("voice-list");
  list.innerHTML = "";
  $("voice-count").textContent = VOICES.length ? `${VOICES.length} voice(s)` : "";
  VOICES.forEach((v) => list.append(voiceCard(v)));
}

// --- editor ---------------------------------------------------------------
function field(labelText, control, hint) {
  const f = el("div", "agent-field");
  f.append(el("label", "agent-field-label", escapeHtml(labelText)));
  f.append(control);
  if (hint) f.append(el("div", "agent-field-hint", escapeHtml(hint)));
  return f;
}

// One editable refine button: a {label, prompt} pair with a remove control.
function refineRow(item) {
  const row = el("div", "voice-refine-row");
  const label = el("input", "agent-input");
  label.value = (item && item.label) || "";
  label.placeholder = "Button (e.g. Shorter)";
  const prompt = el("input", "agent-input");
  prompt.value = (item && item.prompt) || "";
  prompt.placeholder = "What to ask Athena to do";
  const del = el("button", "btn small danger",
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>');
  del.type = "button";
  del.title = "Remove";
  del.addEventListener("click", () => {
    row.remove();
    setDirty("voices", true);
  });
  [label, prompt].forEach((n) => n.addEventListener("input", () => setDirty("voices", true)));
  row.append(label, prompt, del);
  return row;
}

function openEditor(voice) {
  const box = $("voice-editor");
  box.hidden = false;
  box.innerHTML = "";
  const editing = !!voice;
  const v = voice || {};
  lastDraft = editing ? { ...v } : null;

  const title = el("h3", "agent-editor-title", editing ? "Edit voice" : "New voice");

  const label = el("input", "agent-input");
  label.value = v.label || "";
  label.placeholder = "e.g. Sales";

  const desc = el("textarea", "agent-input agent-textarea");
  desc.value = v.description || "";
  desc.rows = 3;
  desc.placeholder =
    "e.g. Sales reps — persuasive, benefit-focused, what to tell a prospect. No code jargon.";

  const generate = el("button", "btn small", "Generate instruction");
  generate.type = "button";

  const instruction = el("textarea", "agent-input agent-textarea");
  instruction.value = v.instruction || "";
  instruction.rows = 8;
  instruction.placeholder = "Click Generate above, or write how this voice should answer.";

  const refines = el("div", "voice-refines");
  (v.refinements || []).forEach((it) => refines.append(refineRow(it)));
  const addRefine = el("button", "btn small", "+ Add refine");
  addRefine.type = "button";
  addRefine.addEventListener("click", () => {
    refines.append(refineRow({ label: "", prompt: "" }));
    setDirty("voices", true);
  });

  [label, desc, instruction].forEach((n) =>
    n.addEventListener("input", () => setDirty("voices", true)),
  );

  const msg = el("span", "msg");
  const cancel = el("button", "btn small", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", closeEditor);
  const save = el("button", "btn small primary", editing ? "Save changes" : "Create voice");
  save.type = "button";
  const actions = el("div", "agent-editor-actions");
  actions.append(cancel, save, msg);

  generate.addEventListener("click", async () => {
    const description = desc.value.trim();
    if (!description) {
      setMsg(msg, "Describe who the answers are for first.", "err");
      desc.focus();
      return;
    }
    generate.disabled = true;
    const prev = generate.textContent;
    generate.textContent = "Generating…";
    setMsg(msg, "");
    try {
      const draft = await api.post("/api/personas/generate", {
        description,
        label: label.value.trim(),
      });
      lastDraft = draft;
      if (draft.label && !label.value.trim()) label.value = draft.label;
      if (draft.description) desc.value = draft.description;
      if (draft.instruction) instruction.value = draft.instruction;
      if (draft.refinements && draft.refinements.length) {
        refines.innerHTML = "";
        draft.refinements.forEach((it) => refines.append(refineRow(it)));
      }
      setDirty("voices", true);
    } catch (e) {
      setMsg(msg, e.message || "Couldn't generate — try rephrasing the description.", "err");
    } finally {
      generate.disabled = false;
      generate.textContent = prev;
    }
  });

  save.addEventListener("click", async () => {
    const refinements = [...refines.querySelectorAll(".voice-refine-row")]
      .map((r) => {
        const [l, p] = r.querySelectorAll("input");
        return { label: l.value.trim(), prompt: p.value.trim() };
      })
      .filter((x) => x.label && x.prompt);
    const payload = {
      id: editing ? v.id : "",
      label: label.value.trim(),
      description: desc.value.trim(),
      instruction: instruction.value.trim(),
      greeting: (lastDraft && lastDraft.greeting) || "",
      suggestions: (lastDraft && lastDraft.suggestions) || [],
      followup_voice: (lastDraft && lastDraft.followup_voice) || "",
      refinements,
    };
    if (!payload.label) {
      setMsg(msg, "A name is required.", "err");
      label.focus();
      return;
    }
    if (!payload.instruction) {
      setMsg(msg, "Add an instruction, or generate one from a description.", "err");
      instruction.focus();
      return;
    }
    save.disabled = true;
    try {
      await api.post("/api/personas", payload);
      setDirty("voices", false);
      await loadVoices();
      closeEditor();
    } catch (e) {
      setMsg(msg, e.message || "Could not save the voice.", "err");
    } finally {
      save.disabled = false;
    }
  });

  box.append(title, field("Name", label));
  box.append(field("Who are the answers for?", desc,
    "Describe the reader and the style — Athena writes the instruction for you."));
  const genRow = el("div", "voice-gen-row");
  genRow.append(generate);
  box.append(genRow);
  box.append(field("Instruction", instruction, "How answers in this voice are written — edit freely."));
  const refineField = field("Refine buttons", refines,
    "One-tap tweaks shown under each answer (e.g. Shorter, More technical).");
  refineField.append(addRefine);
  box.append(refineField);
  box.append(actions);
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  label.focus();
}

function closeEditor() {
  const box = $("voice-editor");
  box.hidden = true;
  box.innerHTML = "";
  lastDraft = null;
  setDirty("voices", false);
}

async function removeVoice(v) {
  const ok = await askConfirm({
    title: "Delete voice",
    message: `Delete the voice “${v.label}”? Agents using it fall back to the default voice.`,
    ok: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del("/api/personas/" + encodeURIComponent(v.id));
    await loadVoices();
  } catch (e) {
    const note = el("p", "msg err", escapeHtml(e.message || "Could not delete."));
    $("voice-list").prepend(note);
  }
}

// --- load -----------------------------------------------------------------
export async function loadVoices() {
  try {
    const data = await api.get("/api/personas");
    VOICES = data.personas || [];
  } catch (e) {
    $("voice-list").innerHTML = `<p class="msg err">${escapeHtml(e.message)}</p>`;
    return;
  }
  renderList();
}

$("voice-new").addEventListener("click", () => openEditor(null));
