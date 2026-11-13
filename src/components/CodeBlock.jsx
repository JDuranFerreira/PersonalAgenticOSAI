/* ==========================================================================
   Agentic OS — CodeBlock
   Syntax-highlighted code block with copy button (Milestone 1 formatting)
   Language components are loaded dynamically so missing grammars fall back
   gracefully instead of crashing the page.
 ========================================================================== */
import { useEffect, useRef, useState } from "react";
import Prism from "prismjs";
import { Copy } from "lucide-react";

const LANG_MAP = {
  js: "javascript",
  javascript: "javascript",
  ts: "typescript",
  typescript: "typescript",
  py: "python",
  python: "python",
  html: "markup",
  xml: "markup",
  css: "css",
  json: "json",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  cpp: "cpp",
  c: "c",
  java: "java",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
};

export default function CodeBlock({ code, language }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef(null);

  useEffect(() => {
    const el = codeRef.current;
    if (!el) return;

    const prismLang = LANG_MAP[language] || language;

    // Dynamically load the grammar component so missing languages don't crash.
    (async () => {
      if (prismLang && !Prism.languages[prismLang]) {
        try {
          await import(`prismjs/components/prism-${prismLang}.js`);
        } catch {
          // Grammar unavailable — highlight will just use plain text.
        }
      }
      Prism.highlightElement(el);
    })();
  }, [code, language]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  const displayLang = language || "code";

  return (
    <div className="code-block-wrap">
      <div className="code-header">
        <div className="code-lang">
          <span className="code-badge" />
          <span>{displayLang}</span>
        </div>
        <div className="code-actions">
          <button className="icon-btn" onClick={handleCopy} title="Copy code">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>
      <div className="code-content">
        <pre>
          <code ref={codeRef} className={`language-${LANG_MAP[language] || language || "text"}`}>
            {code}
          </code>
        </pre>
      </div>
    </div>
  );
}

function Check({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
