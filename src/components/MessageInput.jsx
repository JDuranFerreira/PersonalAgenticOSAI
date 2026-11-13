/* ==========================================================================
   Agentic OS — MessageInput
   Text chat, attachments (drag & drop / picker), speech-to-text mic, send.
 ========================================================================== */
import { useRef, useState } from "react";
import { Paperclip, Mic, Send, SquareStop, X } from "lucide-react";
import { isSttSupported } from "../utils/stt";

export default function MessageInput({
  value,
  onChange,
  onSend,
  onAttach,
  sending,
  listening,
  onToggleListening,
  attachments = [],
  onRemoveAttachment,
  attachmentError,
}) {
  const textareaRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleChange = (e) => {
    onChange(e.target.value);
    // Auto-grow within limits
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onAttach(files);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = () => setDragging(false);

  const handleFiles = (e) => {
    const files = Array.from(e.target.files);
    if (files.length) onAttach(files);
    e.target.value = "";
  };

  const disabledStt = !isSttSupported();

  return (
    <div
      className="input-area"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragging && (
        <div style={{
          position: "absolute", inset: 0, border: "2px dashed var(--cyan)",
          background: "rgba(0,243,255,0.1)", borderRadius: "12px",
          pointerEvents: "none", zIndex: 5, display: "flex",
          alignItems: "center", justifyContent: "center",
          color: "var(--cyan)", fontSize: "0.9rem", fontWeight: 700,
          textTransform: "uppercase", letterSpacing: "0.1em",
        }}>
          Drop files to attach
        </div>
      )}
      <div className="input-row">
        <label className="attach-chip" title="Attach files">
          <Paperclip size={16} />
          <input
            className="file-input"
            type="file"
            multiple
            onChange={handleFiles}
            aria-label="Attach files"
          />
        </label>

        <div className="textarea-wrap">
          <textarea
            ref={textareaRef}
            className="message-input"
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Message the agent..."
            rows={1}
            disabled={sending}
            aria-label="Message input"
          />
        </div>

        <div className="input-controls">
          <button
            className={`mic-btn ${listening ? "active" : ""} ${disabledStt ? "disabled-stt" : ""}`}
            onClick={onToggleListening}
            disabled={disabledStt}
            title={disabledStt ? "Speech not supported" : listening ? "Stop listening" : "Dictate message"}
            aria-label={listening ? "Stop listening" : "Start dictation"}
          >
            {listening ? <SquareStop size={16} fill="#fff" /> : <Mic size={16} />}
          </button>

          <button
            className="send-btn"
            onClick={onSend}
            disabled={sending || (!value.trim() && attachments.length === 0)}
            aria-label="Send message"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
      {attachments.length > 0 && (
        <div className="pending-attachments" aria-label="Attachments to send">
          {attachments.map((attachment) => (
            <div className="pending-attachment" key={attachment.id}>
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt="" className="pending-attachment-thumb" />
              ) : <FileBadge />}
              <span title={attachment.name}>{attachment.name}</span>
              <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemoveAttachment?.(attachment.id)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachmentError && <div className="attachment-error" role="alert">{attachmentError}</div>}
    </div>
  );
}

function FileBadge() {
  return <span className="pending-file-badge" aria-hidden="true"><Paperclip size={13} /></span>;
}
