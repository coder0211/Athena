// Export the current conversation as a Markdown file — the answers are already
// markdown, so this just interleaves the questions and offers it as a download.
import { $ } from "./dom.js";
import { S } from "./state.js";
import { t } from "./i18n.js";
import { showToast } from "./toast.js";

function conversationMarkdown() {
  const title = $("header-title")?.textContent?.trim() || t().newChat;
  const lines = [`# ${title}`, ""];
  S.history.forEach((m) => {
    if (!m.content) return;
    lines.push(m.role === "user" ? "## " + t().youLabel : "## Athena");
    lines.push("", m.content.trim(), "");
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// Turn a title into a safe file name stem.
function slug(s) {
  return (
    (s || "athena-chat")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "athena-chat"
  );
}

export function exportConversation() {
  if (!S.history.length) return; // nothing to export yet
  const md = conversationMarkdown();
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = slug($("header-title")?.textContent) + ".md";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(t().exportedToast);
}
