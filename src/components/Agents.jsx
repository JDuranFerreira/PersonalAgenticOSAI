/* ==========================================================================
   Agentic OS — Agents tab
   Agent roster + settings editor. No chat here — talking to Zazu happens in
   the always-available right sidebar (ZazuPanel). This tab edits each agent's
   settings: description, system prompt (persona), wake word, voice, and which
   fast model the agent runs on.
   ========================================================================== */
import { useState, useEffect } from "react";
import { ZAZU, FUTURE_AGENTS } from "../agents/zazu";
import { loadAgentSettings, saveAgentSettings, resetAgentSettings } from "../agents/settings";
import ModelSelect from "./ModelSelect";
import { catalogLabel, fetchImageModels } from "../utils/api";
import zazuAvatar from "../assets/zazu-avatar.jpg";
import ResizeHandle from "./ResizeHandle";
import { useResizableWidth } from "../utils/useResizableWidth";
import { kokoroHealth, speak, speakKokoro, isTtsSupported } from "../utils/tts";
import { Bot, Search, Code, Image as ImageIcon, RotateCcw, Check, FileText, Globe } from "lucide-react";

const FUTURE_ICONS = { search: <Search size={15} />, code: <Code size={15} />, image: <ImageIcon size={15} />, fileText: <FileText size={15} />, globe: <Globe size={15} /> };

// Small live indicator: is the local Kokoro voice service running?
function VoiceHealth() {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    let alive = true;
    kokoroHealth().then((h) => alive && setHealth(h));
    return () => { alive = false; };
  }, []);
  if (!health) return <span className="voice-health">checking voice service…</span>;
  return (
    <span className={`voice-health ${health.ok ? "ok" : "down"}`}>
      {health.ok
        ? `Kokoro ready — ${health.voice} @ ${health.speed}`
        : "Kokoro service down — using browser voice"}
    </span>
  );
}

export default function Agents() {
  const [selectedAgentId, setSelectedAgentId] = useState("zazu");
  const [settings, setSettings] = useState(() => loadAgentSettings(selectedAgentId));
  const [saved, setSaved] = useState(false);
  const [imageModels, setImageModels] = useState([]);
  const [imageProviderConfigured, setImageProviderConfigured] = useState(false);

  function selectAgent(agentId) {
    setSelectedAgentId(agentId);
    setSettings(loadAgentSettings(agentId));
  }

  // Resizable roster rail (drag its right edge)
  const rosterRail = useResizableWidth({
    storageKey: "agentic_os_width_agents_rail",
    defaultValue: 232,
    min: 150,
    max: 360,
    side: "right",
  });

  useEffect(() => {
    let alive = true;
    fetchImageModels()
      .then((data) => {
        if (!alive) return;
        setImageModels(data.models || []);
        setImageProviderConfigured(Boolean(data.configured));
      })
      .catch(() => {
        if (alive) {
          setImageModels([]);
          setImageProviderConfigured(false);
        }
      });
    return () => { alive = false; };
  }, []);

  function update(patch) {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveAgentSettings(selectedAgentId, next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  }

  return (
    <div className="agents-page">
      {/* ---------------- Agent roster ---------------- */}
      <aside className="agent-rail" style={{ width: rosterRail.width }}>
        <div className="sidebar-section-title">Agents</div>

        <button
          className={`agent-card ${selectedAgentId === "zazu" ? "active" : ""}`}
          onClick={() => selectAgent("zazu")}
        >
          <div className="agent-avatar zazu">
            <img className="zazu-img" src={zazuAvatar} alt="Zazu" />
            <span className="agent-dot idle" />
          </div>
          <div className="agent-card-body">
            <div className="agent-card-name">{settings.name}</div>
            <div className="agent-card-role">{settings.role}</div>
            <div className="agent-card-model">{catalogLabel(settings.model)}</div>
          </div>
        </button>

        {FUTURE_AGENTS.map((a) => (
          <button
            key={a.id}
            className={`agent-card ${selectedAgentId === a.id ? "active" : ""}`}
            onClick={() => selectAgent(a.id)}
            title={`Edit ${a.name} settings`}
          >
            <div className="agent-avatar">
              {FUTURE_ICONS[a.icon] || <Bot size={15} />}
            </div>
            <div className="agent-card-body">
              <div className="agent-card-name">{a.name}</div>
              <div className="agent-card-role">
                {a.role} · {a.status === "ready" ? "tools ready" : "chat only"}
              </div>
            </div>
          </button>
        ))}
      </aside>

      <ResizeHandle side="right" onDragStart={rosterRail.startDrag} onReset={rosterRail.reset} />

      {/* ---------------- Settings editor ---------------- */}
      <div className="main agent-settings">
        <div className="workspace-header">
          <div className="settings-title">
            <div className="settings-avatar">
              {selectedAgentId === "zazu" ? (
                <img className="zazu-img" src={zazuAvatar} alt="Zazu" />
              ) : (
                <div className="agent-avatar">
                  {FUTURE_ICONS[FUTURE_AGENTS.find(a => a.id === selectedAgentId)?.icon] || <Bot size={15} />}
                </div>
              )}
            </div>
            <div>
              <div className="settings-name">{settings.name}</div>
              <div className="settings-role">{settings.role} · settings</div>
            </div>
          </div>
          <div className="workspace-controls">
            {saved && (
              <span className="saved-chip"><Check size={12} /> Saved</span>
            )}
            <button
              className="btn btn-outline"
              onClick={() => {
                const d = resetAgentSettings(selectedAgentId);
                setSettings(d);
              }}
              title={selectedAgentId === "zazu" 
                ? "Restore Zazu's original settings" 
                : `Restore ${FUTURE_AGENTS.find(a => a.id === selectedAgentId)?.name || "agent"}'s original settings`
              }
            >
              <RotateCcw size={13} /> Reset
            </button>
          </div>
        </div>

        <div className="settings-body">
          <div className="settings-field">
            <label>Description</label>
            <input
              className="settings-input"
              value={settings.description}
              onChange={(e) => update({ description: e.target.value })}
            />
          </div>

          {selectedAgentId === "artist" && (
            <div className="settings-field">
              <label>Cloudflare image model</label>
              <select
                className="model-select wide"
                value={settings.imageModel || "flux-2-klein-9b"}
                onChange={(e) => update({ imageModel: e.target.value })}
              >
                {imageModels.map((model) => (
                  <option key={model.id} value={model.id} disabled={!model.available}>
                    {model.label}{model.available ? ` — ${model.note}` : " — configure Cloudflare credentials"}
                  </option>
                ))}
                {!imageModels.length && <option value="flux-2-klein-9b">FLUX.2 Klein 9B</option>}
              </select>
              <p className={`settings-hint ${imageProviderConfigured ? "" : "warning"}`}>
                {imageProviderConfigured
                  ? "Generated images are saved to Vault/Images. Cloudflare Workers AI limits and billing apply."
                  : "Cloudflare Workers AI credentials are not configured in this app's server. Models will be listed but generation is unavailable until configured."}
              </p>
            </div>
          )}

          <div className="settings-field">
            <label>Fast model (primary)</label>
            <ModelSelect
              value={settings.model}
              onChange={(model) => update({ model })}
            />
            <p className="settings-hint">
              Every free model in the Agentic OS, grouped by provider. The right
              sidebar companion uses this model for every task.
            </p>
          </div>

          <div className="settings-field">
            <label>Fallback model (2nd in chain)</label>
            <ModelSelect
              value={settings.fallbackModel}
              onChange={(fallbackModel) => update({ fallbackModel })}
              includeNone
              noneLabel="None — auto: try the other fast models"
            />
            <p className="settings-hint">
              Used when the primary is rate-limited or unavailable. With no explicit
              fallback, the other fast models are tried automatically.
            </p>
          </div>

          <div className="settings-field">
            <label>Local model (last resort)</label>
            <ModelSelect
              value={settings.localModel}
              onChange={(localModel) => update({ localModel })}
              filterProviders={["ollama"]}
              includeNone
              noneLabel="None"
            />
            <p className="settings-hint">
              Runs on your machine via Ollama — never rate-limited, always tried
              last when every cloud model fails. Requires Ollama to be running.
            </p>
          </div>

          <div className="settings-row">
            <div className="settings-field half">
              <label>Wake word</label>
              <input
                className="settings-input"
                value={settings.wakeWord}
                onChange={(e) => update({ wakeWord: e.target.value.trim().toLowerCase() || ZAZU.wakeWord })}
              />
              <p className="settings-hint">Say this word to get his attention when the mic is armed.</p>
            </div>
            <div className="settings-field half">
              <label>Voice (text to speech)</label>
              <button
                className={`btn btn-outline toggle-btn ${settings.voice ? "on" : "off"}`}
                onClick={() => update({ voice: !settings.voice })}
              >
                {settings.voice ? "On — briefings read aloud" : "Off"}
              </button>
            </div>
          </div>

          <div className="settings-field">
            <label>Voice engine</label>
            <select
              className="model-select wide"
              value={settings.ttsEngine || "kokoro"}
              onChange={(e) => update({ ttsEngine: e.target.value })}
            >
              <option value="kokoro">Kokoro — local, unlimited (bm_george · brisk 1.15)</option>
              <option value="browser">Browser voice — speechSynthesis fallback</option>
            </select>
            <div className="voice-test-row">
              <button
                className="btn btn-outline"
                onClick={async () => {
                  const engine = settings.ttsEngine || "kokoro";
                  if (engine === "kokoro") {
                    try {
                      const h = await speakKokoro("Good day, Sir. Agent here, voice service fully operational.");
                      setTimeout(() => h.stop(), 8000);
                    } catch {
                      window.alert("Kokoro voice service is not running on port 8765. Using the browser voice instead.");
                    }
                  } else if (isTtsSupported()) {
                    speak("Good day, Sir. Agent here, browser voice fully operational.", { rate: 1.15 });
                  }
                }}
              >
                Test voice
              </button>
              <VoiceHealth />
            </div>
            <p className="settings-hint">
              Kokoro is Zazu's voice from the reference OS config: local, free,
              unlimited. If the voice service is down, briefings fall back to the
              browser voice automatically.
            </p>
          </div>

          <div className="settings-field grow">
            <label>System prompt (persona &amp; instructions)</label>
            <textarea
              className="settings-textarea"
              value={settings.system}
              onChange={(e) => update({ system: e.target.value })}
              spellCheck={false}
            />
            <p className="settings-hint">
              Keep the tool protocol ([[LIST]] [[READ]] [[ASK]] [[LEARN]],
              [DELEGATE: Agent — task] and the Brief/[[DETAILS]] reporting format) intact —
              the right-sidebar companion depends on it. Reset restores the original.
            </p>
          </div>

          <div className="settings-note">
            <Bot size={13} />
            <span>
              Talking to {settings.name} happens in the right sidebar — available on every
              tab. Chat with him there; edit him here.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
