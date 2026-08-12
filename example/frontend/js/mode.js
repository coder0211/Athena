// Answer "voice" (persona) helpers for the chat. Voices are authored in the
// dashboard admin now — the chat only *reads* them: to theme the composer, to
// choose the welcome copy / starters / refine buttons, and to resolve which
// voice a selected agent speaks in. There is no voice picker or editor here
// anymore; the user picks an agent (see agent.js) and the agent carries the
// voice. `S.mode` holds the effective voice id (an agent's persona, or the
// 'business' default when no agent is selected).
import { $ } from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";
import { apiGet } from "./api.js";

const personaById = (id) => (S.PERSONAS || []).find((p) => p.id === id);

// body[data-mode] themes the composer/bubbles for the built-in voices; a custom
// voice simply falls through to the default theme.
export function applyModeTheme() {
  document.body.dataset.mode = S.mode;
}

// Header shows which conversation is open (updates on open / new / first turn).
export function setHeaderTitle(text) {
  $("header-title").textContent = text || t().newChat;
}

// --- voice registry load --------------------------------------------------
// Loaded so the welcome copy / starters / refine buttons can reflect the voice
// a selected agent speaks in. Read-only: management lives in the dashboard.
export async function loadPersonas() {
  try {
    const data = await apiGet("/api/personas");
    S.PERSONAS = (data && data.personas) || [];
  } catch {
    S.PERSONAS = [];
  }
  // Keep S.mode pointing at a voice that still exists (a since-deleted custom
  // one falls back to a valid default, so copy stays coherent).
  if (!personaById(S.mode) && S.PERSONAS.length) {
    S.mode = personaById("business") ? "business" : S.PERSONAS[0].id;
  }
  applyModeTheme();
}
