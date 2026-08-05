// Answer "type" (persona) control: the header type picker + its dropdown menu,
// the create/edit modal (describe → generate → edit → save), and the per-chat
// lock. A "type" decides how an answer is written — Business, Technical, or any
// custom audience the user adds (Sales, Marketing, …). `S.mode` holds the
// selected type's id; each answer in a conversation was produced in one type, so
// the picker locks once the conversation has started. Also owns the header title.
import { $, el, escapeHtml, ICON_EDIT } from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";
import { apiGet, apiPost, apiDelete } from "./api.js";
import { renderEmpty } from "./messages.js";
import { showToast } from "./toast.js";

// body[data-mode] themes the composer/bubbles for the built-in modes; a custom
// type simply falls through to the default theme.
export function applyModeTheme() {
  document.body.dataset.mode = S.mode;
}

const personaById = (id) => (S.PERSONAS || []).find((p) => p.id === id);
const currentPersona = () => personaById(S.mode);

// --- header picker button (shows the active type) -------------------------
export function refreshPersonaButton() {
  const p = currentPersona() || personaById("business") || (S.PERSONAS || [])[0];
  if (p) $("mode-picker-label").textContent = p.label;
  const btn = $("mode-picker-btn");
  if (btn) btn.title = S.modeLocked ? t().persona.locked : t().persona.pickerTitle;
}

// Switch type + reflect it everywhere (picker click, or opening a saved chat).
export function setMode(id) {
  S.mode = id;
  refreshPersonaButton();
  renderMenuActive();
  applyModeTheme();
}

export function lockMode() {
  if (S.modeLocked) return;
  S.modeLocked = true;
  $("mode-picker")?.classList.add("locked");
  $("mode-picker-btn")?.setAttribute("disabled", "");
  refreshPersonaButton();
}

export function unlockMode() {
  S.modeLocked = false;
  $("mode-picker")?.classList.remove("locked");
  $("mode-picker-btn")?.removeAttribute("disabled");
  refreshPersonaButton();
}

// Header shows which conversation is open (updates on open / new / first turn).
export function setHeaderTitle(text) {
  $("header-title").textContent = text || t().newChat;
}

// --- persona registry load + dropdown menu --------------------------------
export async function loadPersonas() {
  try {
    const data = await apiGet("/api/personas");
    S.PERSONAS = (data && data.personas) || [];
  } catch {
    S.PERSONAS = [];
  }
  // If the saved selection no longer exists (a since-deleted custom type), fall
  // back to a valid one so the picker + answers stay coherent.
  if (!currentPersona() && S.PERSONAS.length) {
    S.mode = personaById("business") ? "business" : S.PERSONAS[0].id;
    localStorage.setItem("athena_mode", S.mode);
  }
  renderPersonaMenu();
  refreshPersonaButton();
}

function renderMenuActive() {
  document
    .querySelectorAll("#mode-menu .mode-menu-item")
    .forEach((row) => row.classList.toggle("active", row.dataset.id === S.mode));
}

export function renderPersonaMenu() {
  const menu = $("mode-menu");
  if (!menu) return;
  const s = t().persona;
  menu.innerHTML = "";
  (S.PERSONAS || []).forEach((p) => {
    const row = el("div", "mode-menu-item");
    row.dataset.id = p.id;
    row.setAttribute("role", "option");
    row.innerHTML =
      `<span class="mode-menu-text">` +
      `<span class="mode-menu-label">${escapeHtml(p.label)}` +
      (p.builtin ? ` <span class="mode-menu-badge">${escapeHtml(s.builtin)}</span>` : "") +
      `</span>` +
      `<span class="mode-menu-desc">${escapeHtml(p.description || "")}</span>` +
      `</span>`;
    row.onclick = (e) => {
      if (e.target.closest(".mode-menu-edit")) return; // the edit button has its own handler
      pickPersona(p.id);
    };
    if (!p.builtin) {
      const edit = el("button", "mode-menu-edit", ICON_EDIT);
      edit.type = "button";
      edit.title = s.editTypeTitle;
      edit.onclick = (e) => {
        e.stopPropagation();
        closeMenu();
        openPersonaModal(p);
      };
      row.append(edit);
    }
    menu.append(row);
  });
  const add = el(
    "button",
    "mode-menu-add",
    `<span class="mode-menu-add-plus">＋</span> ${escapeHtml(s.newType)}`,
  );
  add.type = "button";
  add.onclick = () => {
    closeMenu();
    openPersonaModal(null);
  };
  menu.append(add);
  renderMenuActive();
}

function pickPersona(id) {
  closeMenu();
  if (S.modeLocked || id === S.mode) return;
  setMode(id);
  localStorage.setItem("athena_mode", id);
  renderEmpty(); // refresh the welcome copy + suggestions for the new type
}

// --- menu open/close ------------------------------------------------------
function openMenu() {
  if (S.modeLocked) return;
  $("mode-menu").hidden = false;
  $("mode-picker-btn").setAttribute("aria-expanded", "true");
  setTimeout(() => document.addEventListener("click", onDocClick), 0);
}
function closeMenu() {
  const menu = $("mode-menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $("mode-picker-btn").setAttribute("aria-expanded", "false");
  document.removeEventListener("click", onDocClick);
}
function onDocClick(e) {
  if (!e.target.closest("#mode-picker")) closeMenu();
}

export function initPersonaPicker() {
  $("mode-picker-btn").onclick = (e) => {
    e.stopPropagation();
    $("mode-menu").hidden ? openMenu() : closeMenu();
  };
  wirePersonaModal();
}

// --- create / edit modal --------------------------------------------------
let editingId = null; // id when editing an existing custom type, else null
let lastDraft = null; // generated extras (greeting/suggestions/followup_voice) to persist on save

function openPersonaModal(persona) {
  const s = t().persona;
  editingId = persona ? persona.id : null;
  lastDraft = persona ? { ...persona } : null;
  $("persona-modal-title").textContent = persona ? s.editTypeTitle : s.newTypeTitle;
  $("persona-name").value = persona ? persona.label : "";
  $("persona-desc").value = persona ? persona.description || "" : "";
  $("persona-instruction").value = persona ? persona.instruction || "" : "";
  $("persona-delete").hidden = !persona; // only custom types are editable/deletable
  setError("");
  $("persona-modal").hidden = false;
  $("persona-name").focus();
}

function closePersonaModal() {
  $("persona-modal").hidden = true;
  editingId = null;
  lastDraft = null;
}

function setError(msg) {
  const e = $("persona-error");
  e.textContent = msg || "";
  e.hidden = !msg;
}

async function generateInstruction() {
  const s = t().persona;
  const description = $("persona-desc").value.trim();
  if (!description) return setError(s.needDesc);
  const btn = $("persona-generate");
  const lbl = $("persona-generate-label");
  const prev = lbl.textContent;
  btn.disabled = true;
  btn.classList.add("busy");
  lbl.textContent = s.generating;
  setError("");
  try {
    const draft = await apiPost("/api/personas/generate", {
      description,
      label: $("persona-name").value.trim(),
    });
    lastDraft = draft;
    if (draft.label && !$("persona-name").value.trim()) $("persona-name").value = draft.label;
    if (draft.instruction) $("persona-instruction").value = draft.instruction;
    if (draft.description) $("persona-desc").value = draft.description;
  } catch (err) {
    setError((err && err.message) || s.genFailed);
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
    lbl.textContent = prev;
  }
}

async function savePersona() {
  const s = t().persona;
  const label = $("persona-name").value.trim();
  const instruction = $("persona-instruction").value.trim();
  if (!label) return setError(s.needName);
  if (!instruction) return setError(s.needInstruction);
  const btn = $("persona-save");
  btn.disabled = true;
  try {
    const saved = await apiPost("/api/personas", {
      id: editingId || "",
      label,
      description: $("persona-desc").value.trim(),
      instruction,
      greeting: (lastDraft && lastDraft.greeting) || "",
      suggestions: (lastDraft && lastDraft.suggestions) || [],
      followup_voice: (lastDraft && lastDraft.followup_voice) || "",
    });
    await loadPersonas();
    closePersonaModal();
    showToast(s.saved);
    // Select the just-saved type (unless the current chat is locked to another).
    if (!S.modeLocked) {
      setMode(saved.id);
      localStorage.setItem("athena_mode", saved.id);
      renderEmpty();
    }
  } catch (err) {
    setError((err && err.message) || "");
  } finally {
    btn.disabled = false;
  }
}

async function deletePersona() {
  const s = t().persona;
  if (!editingId || !confirm(s.deleteConfirm)) return;
  const removed = editingId;
  try {
    await apiDelete(`/api/personas/${removed}`);
    const wasCurrent = S.mode === removed;
    await loadPersonas();
    closePersonaModal();
    showToast(s.deleted);
    if (wasCurrent && !S.modeLocked) {
      setMode("business");
      localStorage.setItem("athena_mode", "business");
      renderEmpty();
    }
  } catch (err) {
    setError((err && err.message) || "");
  }
}

function wirePersonaModal() {
  $("persona-generate").onclick = generateInstruction;
  $("persona-save").onclick = savePersona;
  $("persona-delete").onclick = deletePersona;
  $("persona-cancel").onclick = closePersonaModal;
  $("persona-close").onclick = closePersonaModal;
  $("persona-backdrop").onclick = closePersonaModal;
  applyPersonaI18n();
}

// Re-skin the static picker menu + modal labels for the current language.
export function applyPersonaI18n() {
  const s = t().persona;
  $("persona-name-label").textContent = s.name;
  $("persona-name").placeholder = s.namePlaceholder;
  $("persona-audience-label").textContent = s.audience;
  $("persona-audience-hint").textContent = s.audienceHint;
  $("persona-desc").placeholder = s.audiencePlaceholder;
  $("persona-generate-label").textContent = s.generate;
  $("persona-instruction-label").textContent = s.instruction;
  $("persona-instruction-hint").textContent = s.instructionHint;
  $("persona-instruction").placeholder = s.instructionPlaceholder;
  $("persona-cancel").textContent = s.cancel;
  $("persona-save").textContent = s.save;
  $("persona-delete").textContent = s.delete;
  renderPersonaMenu();
  refreshPersonaButton();
}
