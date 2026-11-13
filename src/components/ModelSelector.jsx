/* ==========================================================================
   Agentic OS — ModelSelector
   Dropdown to pick an AI model (OpenRouter, opencode Zen, Hermes/Nous cloud
   or Ollama local).
 ========================================================================== */
import { useState } from "react";
import { MODELS, modelDisplayName } from "../utils/api";

export default function ModelSelector({ value, onChange }) {
  const [open, setOpen] = useState(false);

  const byProvider = {};
  for (const m of MODELS) {
    if (!byProvider[m.provider]) byProvider[m.provider] = [];
    byProvider[m.provider].push(m);
  }

  const labels = {
    openrouter: "OpenRouter (cloud, free)",
    ollama: "Ollama (local)",
    opencode: "opencode Zen (free)",
    hermes: "Hermes (Nous Portal)",
  };

  return (
    <div className="model-selector" style={{ position: "relative", display: "inline-block" }}>
      <button
        className="btn btn-outline"
        onClick={() => setOpen(!open)}
        title="Select AI model"
      >
        {value ? modelDisplayName(value) : "Model"} &nbsp;
        <span style={{ fontSize: 12 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="model-dropdown">
          {Object.entries(byProvider).map(([provider, models]) => (
            <div key={provider} className="model-group">
              <div className="model-group-label">{labels[provider]}</div>
              {models.map((m) => (
                <button
                  key={m.id}
                  className={`model-item ${value === m.id ? "active" : ""}`}
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                >
                  <span className="model-name">{m.label}</span>
                  <span className="model-meta">
                    {m.provider === "openrouter" ? "cloud · free"
                      : m.provider === "opencode" ? "opencode · free"
                      : m.provider === "hermes" ? (m.id.endsWith(":free") ? "hermes · free" : "hermes · paid")
                      : "local · Ollama"}
                    {m.context ? ` · ${(m.context / 1000).toFixed(0)}k ctx` : ""}
                    {m.vision ? " · vision" : ""}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
