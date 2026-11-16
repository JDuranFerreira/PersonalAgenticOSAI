/* ==========================================================================
   Agentic OS — ConversationHistory
   Searchable, resumable conversation history with per-item delete.
 ========================================================================== */
import { useState } from "react";
import { Search, Trash2, Pencil, Check, X } from "lucide-react";

export default function ConversationHistory({
  conversations,
  activeId,
  onSelect,
  onDelete,
  onRename,
  onNew,
  searchQuery,
  onSearchChange,
}) {
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");

  function beginRename(conversation) {
    setEditingId(conversation.id);
    setEditValue(conversation.title || "");
  }

  function saveRename(id) {
    const title = editValue.trim();
    if (title) onRename?.(id, title);
    setEditingId(null);
  }

  const filtered = conversations.filter((c) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const messageHit = (c.messages || []).some((message) => String(message.content || "").toLowerCase().includes(q));
    return c.title.toLowerCase().includes(q) || (c.preview || "").toLowerCase().includes(q) || messageHit;
  });

  return (
    <div>
      <button className="new-conv-btn" onClick={onNew} title="New conversation">
        + New conversation
      </button>
      <div className="sidebar-section-title">History</div>
      <div className="search-box">
        <span className="search-icon"><Search size={12} /></span>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search conversations"
          aria-label="Search history"
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {filtered.length === 0 ? (
          <div className="history-empty">No conversations found</div>
        ) : (
            filtered.map((c) => (
              <div className="history-row" key={c.id}>
                {editingId === c.id ? (
                  <form className="history-rename" onSubmit={(event) => { event.preventDefault(); saveRename(c.id); }}>
                    <input
                      autoFocus
                      value={editValue}
                      aria-label={`Rename ${c.title}`}
                      onChange={(event) => setEditValue(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") setEditingId(null); }}
                      maxLength={80}
                    />
                    <button className="history-action save" type="submit" title="Save title" aria-label="Save title"><Check size={12} /></button>
                    <button className="history-action" type="button" onClick={() => setEditingId(null)} title="Cancel rename" aria-label="Cancel rename"><X size={12} /></button>
                  </form>
                ) : (
                  <>
                    <button
                      className={`history-item ${c.id === activeId ? "active" : ""}`}
                      onClick={() => onSelect(c.id)}
                      title={c.title}
                    >
                      {c.title}
                    </button>
                    <button
                      className="history-action history-rename-btn"
                      onClick={() => beginRename(c)}
                      title={`Rename ${c.title}`}
                      aria-label={`Rename ${c.title}`}
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      className="history-del"
                      onClick={() => onDelete(c.id)}
                      title="Delete conversation"
                      aria-label={`Delete ${c.title}`}
                    >
                      <Trash2 size={11} />
                    </button>
                  </>
                )}
              </div>
          ))
        )}
      </div>
      <button className="new-conv-btn" onClick={onNew} title="New conversation">
        + New conversation
      </button>
    </div>
  );
}
