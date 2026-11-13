/* ==========================================================================
   Agentic OS — ApprovalPrompt
   Clear Approve / Reject prompt when the agent wants to take an action.
   The agent waits for the decision before continuing (Milestone 1).
 ========================================================================== */
export default function ApprovalPrompt({ description, onApprove, onReject, loading }) {
  return (
    <div className="approval-card">
      <div className="approval-header">
        <span className="approval-icon">&#9888;</span>
        <div>
          <div className="approval-title">Agent requests approval</div>
          <div className="approval-desc">{description}</div>
          <div className="approval-note">Approval only lets this chat continue; it does not execute a tool or external action.</div>
        </div>
      </div>
      <div className="approval-actions">
        <button className="btn btn-approve" onClick={onApprove} disabled={loading}>
          Approve
        </button>
        <button className="btn btn-reject" onClick={onReject} disabled={loading}>
          Reject
        </button>
      </div>
    </div>
  );
}
