// Single shared, mutable app state. Modules import `S` and read/write `S.x`
// (a plain object, so there are no live-binding reassignment issues across
// ES modules). Persisted preferences (mode, language) are seeded here.
const savedLang = localStorage.getItem("athena_lang");

export const S = {
  history: [], // [{role:'user'|'assistant', content}]
  conversationId: null, // current conversation on the backend (null = not created yet)
  busy: false,
  mode: localStorage.getItem("athena_mode") || "business", // persona id (answer "type")
  agent: localStorage.getItem("athena_agent") || "", // selected agent id ("" = none)
  agentLocked: false, // once a conversation has turns, the agent is fixed for it
  lang: savedLang === "en" || savedLang === "vi" ? savedLang : "en",
  PERSONAS: [], // answer "types": [{id, label, description, icon, instruction, greeting, suggestions, builtin}]
  AGENTS: [], // saved agents: [{id, label, description, persona, scope, tools, model}]
  REPOS: [], // repo names, for @ mentions
  REPO_META: {}, // {name: {description, role, tags}} for @ mention hints
  DOCS: [], // [{id, name, file_type, sections}] ingested documents, for @ mentions
  TOOLS: [], // [{name, server, tool, description}] third-party MCP tools, for @ mentions
  scopeRepos: [], // ["a", ...]
  scopeSymbols: [], // [{name, id, repo}]
  scopeDocs: [], // [{id, name}] documents the search is narrowed to
  scopeFolders: [], // [{path, label}] doc folders the search is narrowed to (whole subtree)
  scopeTools: [], // [{name, label}] MCP tools the user asked the agent to use
  mention: null, // active mention being typed: {type, start, query}
  mentionItems: [],
  mentionActive: -1,
  lastRequest: null, // {question, scope} — replayed by regenerate
  lastUserText: "", // last question text — recalled by the ↑ shortcut on an empty composer
  abort: null, // AbortController for the in-flight answer (Stop button)
};
