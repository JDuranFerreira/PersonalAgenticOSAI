/* ==========================================================================
   Agentic OS — Agent settings store
   Per-agent settings (persona, model, wake word, voice) persisted in
   localStorage. Editors dispatch "zazu-settings-changed" so live components
   (e.g. the ZazuPanel right sidebar) pick changes up immediately.
   ========================================================================== */
import { ZAZU, ZAZU_FAST_MODELS, ZAZU_LOCAL_MODELS, FUTURE_AGENTS } from "./zazu";

const SETTINGS_KEY = "agentic_os_agent_settings_v2";
export const SETTINGS_EVENT = "agentic_os-agent-settings-changed";

function defaults(agentId) {
  const agent = agentId === "zazu" ? ZAZU : FUTURE_AGENTS.find((a) => a.id === agentId);
  if (!agent) {
    return {
      name: "Unknown Agent",
      role: "Agent",
      description: "Agent settings",
      system: "You are an agent.",
      promptVersion: 1,
      wakeWord: "agent",
      model: ZAZU_FAST_MODELS[0].id,
      fallbackModel: "",
      localModel: ZAZU_LOCAL_MODELS[0].id,
      skills: [],
      imageModel: "flux-2-klein-9b",
      voice: true,
      ttsEngine: "kokoro",
      ttsVoice: "",
    };
  }

  return {
    name: agent.name,
    role: agent.role,
    description: agent.description || `Agent ${agent.name}`, // fallback to id if no description
    system: agent.system || `You are ${agent.name}, an agent of Agentic OS.`,
    promptVersion: agent.promptVersion || 1,
    wakeWord: agent.wakeWord || "agent",
    model: ZAZU_FAST_MODELS[0].id,
    fallbackModel: "",
    localModel: ZAZU_LOCAL_MODELS[0].id,
    skills: agent.defaultSkills || [],
    ...(agentId === "artist" ? { imageModel: "flux-2-klein-9b" } : {}),
    voice: agentId === "zazu",
    ttsEngine: "kokoro",
    ttsVoice: "",
  };
}

export function loadAgentSettings(agentId) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaults(agentId);
    const all = JSON.parse(raw);
    const base = defaults(agentId);
    const stored = all[agentId] || {};
    const merged = { ...base, ...stored };
    // Upgrade the earlier generic specialist prompt to the profile's new
    // operational prompt, while preserving any prompt the user customized.
    // Bumping an agent's promptVersion in zazu.js refreshes its system prompt
    // once (overriding a stale stored copy); after that, user edits stick.
    const oldGenericPrompt = `You are ${base.name}, an agent of Agentic OS.`;
    const versionOutdated = (stored.promptVersion ?? 1) !== base.promptVersion;
    if (agentId !== "zazu" && (!stored.system || stored.system === oldGenericPrompt || versionOutdated)) {
      merged.system = base.system;
      merged.promptVersion = base.promptVersion;
    }
    return merged;
  } catch {
    return defaults(agentId);
  }
}

export function saveAgentSettings(agentId, settings) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[agentId] = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(all));
    window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: { agentId, settings } }));
  } catch {
  }
}

export function resetAgentSettings(agentId) {
  const def = defaults(agentId);
  saveAgentSettings(agentId, def);
  return def;
}

export function getAgentIcon(agentId) {
  if (agentId === "zazu") return "zazuAvatar"; // handled specially
  const agent = FUTURE_AGENTS.find((a) => a.id === agentId);
  return agent?.icon || "bot";
}

export function getAgentById(agentId) {
  if (agentId === "zazu") return ZAZU;
  return FUTURE_AGENTS.find((a) => a.id === agentId);
}
