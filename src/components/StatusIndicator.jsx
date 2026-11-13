/* ==========================================================================
   Agentic OS — StatusIndicator
   Shows what the agent is doing right now (Milestone 1 requirement)
 ========================================================================== */
export default function StatusIndicator({ status }) {
  const labels = {
    idle: "IDLE",
    thinking: "THINKING",
    speaking: "SPEAKING",
    listening: "LISTENING",
    working: "WORKING",
    stopped: "STOPPED",
    waiting: "AWAITING APPROVAL",
  };

  return (
    <div className="status-bar">
      <span className={`status-dot ${status}`} />
      <span className="status-text">{labels[status] || status}</span>
    </div>
  );
}
