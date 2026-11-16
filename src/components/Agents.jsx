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
import { catalogLabel, fetchImageModels, fetchSkills } from "../utils/api";
import zazuAvatar from "../assets/zazu-avatar.jpg";
import ResizeHandle from "./ResizeHandle";
import { useResizableWidth } from "../utils/useResizableWidth";
import { kokoroHealth, speak, speakKokoro, isTtsSupported, getVoices } from "../utils/tts";
import { Bot, Search, Code, Image as ImageIcon, RotateCcw, Check, FileText, Globe, GraduationCap, BookOpen, Wrench, ArrowUpRight } from "lucide-react";

const FUTURE_ICONS = { search: <Search size={15} />, code: <Code size={15} />, image: <ImageIcon size={15} />, fileText: <FileText size={15} />, globe: <Globe size={15} />, "graduation-cap": <GraduationCap size={17} /> };
const ZAZU_TOOLS = ["LIST", "READ", "ASK", "LEARN", "NAVIGATE", "CALENDAR", "REMIND", "PROJECTS", "ROUTINE", "SYNC"];
const TOOL_LABELS = {
  LIST: "Browse files", READ: "Read files", ASK: "Ask you questions", WRITE: "Save files",
  SEARCH: "Web search", FETCH: "Read web pages", IMAGE: "Create images", NAVIGATE: "Navigate tabs",
  CALENDAR: "Read calendar", REMIND: "Create reminders", PROJECTS: "Inspect projects", ROUTINE: "Create routines", SYNC: "Sync models", LEARN: "Update memory",
};

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
  const [installedSkills, setInstalledSkills] = useState([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState("");
  const [browserVoices, setBrowserVoices] = useState([]);

  const selectedProfile = selectedAgentId === "zazu" ? ZAZU : FUTURE_AGENTS.find((agent) => agent.id === selectedAgentId);
  const permittedTools = selectedAgentId === "zazu" ? ZAZU_TOOLS : (selectedProfile?.tools || []);
  const toolScope = selectedAgentId === "zazu"
    ? "Coordinates specialists, reads the Vault and project summaries, and manages reminders, routines, and model sync."
    : selectedProfile?.toolScope;
  const selectedSkills = settings.skills || [];
  const zazuSettings = loadAgentSettings("zazu");

  function selectAgent(agentId) {
    setSelectedAgentId(agentId);
    setSettings(loadAgentSettings(agentId));
    setSkillsError("");
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

  useEffect(() => {
    if (!isTtsSupported()) return undefined;
    const refresh = () => setBrowserVoices(getVoices());
    refresh();
    window.speechSynthesis.addEventListener?.("voiceschanged", refresh);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", refresh);
  }, []);

  useEffect(() => {
    let alive = true;
    fetchSkills()
      .then((data) => alive && setInstalledSkills(data.installed || []))
      .catch(() => alive && setInstalledSkills([]))
      .finally(() => alive && setSkillsLoading(false));
    return () => { alive = false; };
  }, []);

  function toggleSkill(slug) {
    const current = settings.skills || [];
    if (!current.includes(slug) && current.length >= 8) {
      setSkillsError("Each agent can use up to 8 skills. Remove one before assigning another.");
      return;
    }
    setSkillsError("");
    update({ skills: current.includes(slug) ? current.filter((id) => id !== slug) : [...current, slug] });
  }

  function openSkillsTab() {
    window.dispatchEvent(new CustomEvent("agentic_os_navigate", { detail: { tab: "skills" } }));
  }

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
            <div className="agent-card-name">{zazuSettings.name}</div>
            <div className="agent-card-role">{zazuSettings.role} · {ZAZU_TOOLS.length} tools</div>
            <div className="agent-card-model">{catalogLabel(zazuSettings.model)}</div>
          </div>
        </button>

        {FUTURE_AGENTS.map((a) => (
          <button
            key={a.id}
            className={`agent-card agent-card-${a.id} ${selectedAgentId === a.id ? "active" : ""}`}
            onClick={() => selectAgent(a.id)}
            title={`Edit ${a.name} settings`}
          >
            <div className={`agent-avatar agent-avatar-${a.id}`}>
              {FUTURE_ICONS[a.icon] || <Bot size={15} />}
            </div>
            <div className="agent-card-body">
              <div className="agent-card-name">{a.name}</div>
              <div className="agent-card-role">
                {a.role} · {a.status === "ready" ? `${a.tools?.length || 0} scoped tools` : "chat only"}
              </div>
              {a.status === "ready" && <div className="agent-card-model">{loadAgentSettings(a.id).skills?.length || 0} skills assigned</div>}
            </div>
          </button>
        ))}
      </aside>

      <ResizeHandle side="right" onDragStart={rosterRail.startDrag} onReset={rosterRail.reset} />

      {/* ---------------- Settings editor ---------------- */}
      <div className={`main agent-settings agent-settings-${selectedAgentId}`}>
        <div className="workspace-header">
          <div className="settings-title">
            <div className="settings-avatar">
              {selectedAgentId === "zazu" ? (
                <img className="zazu-img" src={zazuAvatar} alt="Zazu" />
              ) : (
                <div className={`agent-avatar agent-avatar-${selectedAgentId}`}>
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
          <section className={`agent-capability-card agent-capability-${selectedAgentId}`}>
            <div className="agent-capability-head">
              <div className="agent-capability-avatar">
                {selectedAgentId === "zazu" ? <img className="zazu-img" src={zazuAvatar} alt="" /> : FUTURE_ICONS[selectedProfile?.icon] || <Bot size={20} />}
              </div>
              <div className="agent-capability-copy">
                <span className="agent-section-kicker">Agent profile</span>
                <h2>{settings.name} <small>{settings.role}</small></h2>
                <p>{settings.description}</p>
              </div>
            </div>
            <div className="agent-capability-block">
              <div className="agent-capability-label"><Wrench size={13} /> Scoped tools <span>Fixed permissions</span></div>
              {permittedTools.length ? (
                <div className="agent-tool-chips">
                  {permittedTools.map((tool) => <span className="agent-tool-chip" key={tool} title={tool}>{TOOL_LABELS[tool] || tool}</span>)}
                </div>
              ) : <p className="settings-hint">Chat only — this profile cannot run local or web tools.</p>}
              {toolScope && <p className="agent-tool-scope">{toolScope}</p>}
              <p className="settings-hint">Tool access is defined per profile and enforced by the local runner. Skills never grant additional permissions.</p>
            </div>
            <div className="agent-capability-block agent-skill-block">
              <div className="agent-capability-label"><BookOpen size={13} /> Installed skills <span>{selectedSkills.length}/8 assigned</span></div>
              {skillsLoading ? <p className="settings-hint">Loading installed skills…</p> : installedSkills.length ? (
                <div className="agent-skill-grid">
                  {installedSkills.map((skill) => {
                    const checked = selectedSkills.includes(skill.slug);
                    return (
                      <label className={`agent-skill-option ${checked ? "checked" : ""}`} key={skill.slug}>
                        <input type="checkbox" checked={checked} onChange={() => toggleSkill(skill.slug)} />
                        <span><b>{skill.name}</b><small>{skill.description}</small></span>
                      </label>
                    );
                  })}
                </div>
              ) : <p className="settings-hint">No skills installed yet. Add a skill from the Skills tab.</p>}
              {skillsError && <p className="settings-hint warning">{skillsError}</p>}
              <button type="button" className="agent-manage-skills" onClick={openSkillsTab}>Browse and install skills <ArrowUpRight size={13} /></button>
            </div>
          </section>

          <div className="settings-field">
            <label>Short description</label>
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
              The selected profile uses this model in Chat and in the right-side task panel.
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
            {selectedAgentId === "zazu" && <div className="settings-field half">
              <label>Wake word</label>
              <input
                className="settings-input"
                value={settings.wakeWord}
                onChange={(e) => update({ wakeWord: e.target.value.trim().toLowerCase() || ZAZU.wakeWord })}
              />
              <p className="settings-hint">Say this word to get his attention when the mic is armed.</p>
            </div>}
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
              <option value="kokoro">Kokoro · local George voice (bm_george)</option>
              <option value="browser">Browser voice · choose an installed voice</option>
            </select>
            {settings.ttsEngine === "browser" && (
              <div className="settings-field">
                <label>Voice for {settings.name}</label>
                <select
                  className="model-select wide"
                  value={settings.ttsVoice || ""}
                  onChange={(e) => update({ ttsVoice: e.target.value })}
                  disabled={!browserVoices.length}
                >
                  <option value="">System default voice</option>
                  {browserVoices.map((voice) => <option key={`${voice.name}-${voice.lang}`} value={voice.name}>{voice.name} · {voice.lang}{voice.default ? " · default" : ""}</option>)}
                </select>
                {!browserVoices.length && <p className="settings-hint warning">No browser voices are available in this browser.</p>}
              </div>
            )}
            <div className="voice-test-row">
              <button
                className="btn btn-outline"
                disabled={settings.ttsEngine === "browser" && !isTtsSupported()}
                onClick={async () => {
                  const engine = settings.ttsEngine || "kokoro";
                  if (engine === "kokoro") {
                    try {
                      const h = await speakKokoro(`Hello, I'm ${settings.name}. This is my local voice.`);
                      setTimeout(() => h.stop(), 8000);
                    } catch {
                      if (isTtsSupported()) speak(`Hello, I'm ${settings.name}. The local voice is unavailable, so I'm using your browser voice.`, { rate: 1.15, voicePref: settings.ttsVoice || undefined });
                      else window.alert("Kokoro is unavailable and this browser does not support speech synthesis.");
                    }
                  } else if (isTtsSupported()) {
                    speak(`Hello, I'm ${settings.name}. This is my selected browser voice.`, { rate: 1.15, voicePref: settings.ttsVoice || undefined });
                  }
                }}
              >
                Test voice
              </button>
              {settings.ttsEngine === "kokoro" ? <VoiceHealth /> : <span className={`voice-health ${browserVoices.length ? "ok" : "down"}`}>{browserVoices.length ? `${browserVoices.length} browser voices available` : "Browser speech unavailable"}</span>}
            </div>
            <p className="settings-hint">
              Voice enabled, engine, and browser voice choice are saved per agent. Kokoro uses the local bm_george voice; browser speech can use any voice installed in this browser.
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
              Tool permissions are fixed for this profile; skills add knowledge only. Keep the tool protocol intact for the right-side task panel. Reset restores the original prompt.
            </p>
          </div>

          <div className="settings-note">
            <Bot size={13} />
            <span>
              Select an agent in the Chat tab for tailored replies. The right-side task panel can run this profile's scoped tools; the main Chat stays conversation-only.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
