/* ==========================================================================
   Agentic OS — ErrorBoundary
   Wraps the app so a component crash shows a friendly recovery panel
   (with a reload button) instead of a blank screen.
   ========================================================================== */
import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("UI error:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          color: "#e6faff",
          padding: 40,
          textAlign: "center",
        }}>
          <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--red, #ff2a2a)" }}>
            Something went wrong
          </div>
          <pre style={{
            maxWidth: 640,
            maxHeight: 200,
            overflow: "auto",
            fontSize: "0.75rem",
            color: "#9fb8c8",
            background: "rgba(255,42,42,0.06)",
            border: "1px solid rgba(255,42,42,0.3)",
            borderRadius: 8,
            padding: 12,
            whiteSpace: "pre-wrap",
          }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button
            className="btn btn-outline"
            onClick={() => window.location.reload()}
            style={{ padding: "8px 18px", cursor: "pointer" }}
          >
            Reload the interface
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
