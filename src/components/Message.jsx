/* ==========================================================================
   Agentic OS — Message
   Single chat message. Supports clean markdown rendering, collapsible
   thinking/process, syntax-highlighted code blocks, and attachments.
 ========================================================================== */
import { useEffect, useId, useRef, useState } from "react";
import { renderMarkdown } from "../utils/markdown";
import CodeBlock from "./CodeBlock";
import { Bot, User, FileImage, FileText } from "lucide-react";

const ICONS = {
  image: <FileImage size={16} />,
  pdf: <FileText size={16} />,
  default: <FileText size={16} />,
};

export default function Message({
  role,
  content,
  thinking,
  codeBlocks,
  attachments,
  streaming,
  timestamp,
  author,
}) {
  const contentRef = useRef(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const thinkingId = useId();

  // Auto-scroll to bottom when streaming content changes
  useEffect(() => {
    if (streaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content, streaming]);

  const isAgent = role === "agent";

  // Split agent content into segments: normal text or code fences
  const segments = extractSegments(content);

  const renderThinking = () => {
    if (!thinking) return null;
    return (
      <div className="thinking-block">
        <button
          type="button"
          className={`thinking-header ${thinkingExpanded ? "expanded" : ""}`}
          aria-expanded={thinkingExpanded}
          aria-controls={thinkingId}
          onClick={() => setThinkingExpanded((expanded) => !expanded)}
        >
          <span className="thinking-label">Agent process</span>
          <span className="thinking-arrow" aria-hidden="true" />
        </button>
        <div id={thinkingId} className={`thinking-content ${thinkingExpanded ? "" : "collapsed"}`}>
          <div dangerouslySetInnerHTML={{ __html: renderMarkdown(thinking) }} />
        </div>
      </div>
    );
  };

  const renderCodeBlocks = () => {
    const blocks = [...segments.codeBlocks, ...(codeBlocks || [])];
    if (blocks.length === 0) return null;
    return (
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {blocks.map((cb, i) => (
          <CodeBlock key={`${cb.language || "text"}-${i}`} code={cb.code} language={cb.language} />
        ))}
      </div>
    );
  };

  const renderAttachments = () => {
    if (!attachments || attachments.length === 0) return null;
    return (
      <div className="attachments-list">
        {attachments.map((a, i) => {
          const isImage = Boolean(a.type && a.type.startsWith("image/"));
          const previewUrl = [a.previewUrl, a.url].find((candidate) =>
            typeof candidate === "string" && (/^blob:/i.test(candidate) || /^data:image\/(png|jpeg|gif|webp);base64,/i.test(candidate))
          );
          return (
            <div key={i} className="attachment-card">
              {isImage && previewUrl ? (
                <img className="attachment-thumb" src={previewUrl} alt={a.name} />
              ) : (
                <div className="attachment-icon">{ICONS.default}</div>
              )}
              <span className="attachment-name">{a.name}</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className={`message-wrapper ${role}`}>
      {isAgent ? (
        <>
          <div className="message-meta">
            <span style={{ marginRight: 6 }}><Bot size={14} fill="var(--cyan)" /></span>
            {author || "AGENT"}
            {streaming ? " <span style={{color:'var(--cyan)'}>&bull;&bull;&bull;</span>" : ""}
          </div>
        </>
      ) : (
        <div className="message-meta">
          <span style={{ marginRight: 6 }}><User size={14} fill="var(--magenta)" /></span>
          YOU
        </div>
      )}

      <div
        ref={contentRef}
        className={`message-bubble ${role} ${streaming ? "streaming" : ""}`}
        dangerouslySetInnerHTML={{
          __html: segments.html + (streaming ? '<span class="cursor"></span>' : ""),
        }}
      />

      {isAgent && renderThinking()}
      {renderCodeBlocks()}

      {renderAttachments()}

      {timestamp && (
        <div className="message-meta" style={{ opacity: 0.6, fontSize: "0.68rem", marginTop: 6 }}>
          {new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      )}
    </div>
  );
}

// Extract code fences so they can be rendered as syntax-highlighted blocks
// instead of raw markdown.
function extractSegments(text) {
  // Simple code-fence splitter
  const fenceRegex = /```([\w+-]*)\n([\s\S]*?)```/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  let html = "";

  while ((match = fenceRegex.exec(text))) {
    const before = text.slice(lastIndex, match.index);
    if (before) html += renderMarkdown(before);
    parts.push({ code: match[2], language: match[1] || "text" });
    lastIndex = fenceRegex.lastIndex;
  }
  if (lastIndex < text.length) {
    html += renderMarkdown(text.slice(lastIndex));
  }

  return { html, codeBlocks: parts };
}
