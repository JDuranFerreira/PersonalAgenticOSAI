/* ==========================================================================
   Agentic OS — Markdown renderer (Milestone 1 formatting requirements)
   - Clean heading / list / spacing rendering
   - Collapsible thinking handled by caller
   - Code blocks extracted for syntax highlighting
   ========================================================================== */
import { marked } from "marked";
import DOMPurify from "dompurify";

// Render a message's markdown into safe HTML. Code fences are kept as <pre><code>
// so the caller can apply syntax highlighting / copy buttons.
export function renderMarkdown(text = "") {
  const html = marked(text, {
    gfm: true,
    breaks: true,
    mangle: false,
    headerIds: false,
  });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

// Escape HTML for safe text-only display
export function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}
