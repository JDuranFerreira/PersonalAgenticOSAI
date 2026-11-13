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
      wakeWord: "agent",
      model: ZAZU_FAST_MODELS[0].id,
      fallbackModel: "",
      localModel: ZAZU_LOCAL_MODELS[0].id,
      skills: [],
      imageModel: "flux-2-klein-9b",
      voice: true,
      ttsEngine: "kokoro",
    };
  }

  return {
    name: agent.name,
    role: agent.role,
    description: agent.description || `Agent ${agent.name}`, // fallback to id if no description
    system: agent.system || `You are ${agent.name}, an agent of Agentic OS.`,
    wakeWord: agent.wakeWord || "agent",
    model: ZAZU_FAST_MODELS[0].id,
    fallbackModel: "",
    localModel: ZAZU_LOCAL_MODELS[0].id,
    // Scout ships with the web-search skill for better query crafting & sourcing
    skills: agentId === "scout" ? ["web-search"] : [],
    ...(agentId === "artist" ? { imageModel: "flux-2-klein-9b" } : {}),
    voice: true,
    ttsEngine: "kokoro",
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
    const oldGenericPrompt = `You are ${base.name}, an agent of Agentic OS.`;
    if (agentId !== "zazu" && (!stored.system || stored.system === oldGenericPrompt)) {
      merged.system = base.system;
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
