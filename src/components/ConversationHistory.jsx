/* ==========================================================================
   Agentic OS — ConversationHistory
   Searchable, resumable conversation history with per-item delete.
 ========================================================================== */
import { Search, Trash2 } from "lucide-react";

export default function ConversationHistory({
  conversations,
  activeId,
  onSelect,
  onDelete,
  onNew,
  searchQuery,
  onSearchChange,
}) {
  const filtered = conversations.filter((c) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const messageHit = (c.messages || []).some((message) => String(message.content || "").toLowerCase().includes(q));
    return c.title.toLowerCase().includes(q) || (c.preview || "").toLowerCase().includes(q) || messageHit;
  });

  return (
    <div>
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
              <button
                className={`history-item ${c.id === activeId ? "active" : ""}`}
                onClick={() => onSelect(c.id)}
                title={c.title}
              >
                {c.title}
              </button>
              <button
                className="history-del"
                onClick={() => onDelete(c.id)}
                title="Delete conversation"
                aria-label={`Delete ${c.title}`}
              >
                <Trash2 size={11} />
              </button>
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
