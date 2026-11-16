/* ==========================================================================
   Agentic OS — API Client
   Talks to the local model proxy server (http://127.0.0.1:5175) which
   forwards to OpenRouter (cloud), Nous Research / Hermes (cloud), and
   Ollama (local). API keys are read from C:\AgenticOS\config\.env by the
   proxy — never exposed here.
 ========================================================================== */

import { ZAZU_FAST_MODELS, ZAZU_LOCAL_MODELS } from "../agents/zazu";

const PROXY_URL = "http://127.0.0.1:5175";

export async function fetchModels() {
  const res = await fetch(`${PROXY_URL}/api/models`);
  if (!res.ok) throw new Error(`Failed to load models: ${res.status}`);
  return res.json();
}

export async function* streamChat({
  model,
  messages,
  temperature = 0.7,
  maxTokens,
  fallbackChain = "default",
  customChain = null,
  localModel,
  agent,
  signal,
}) {
  const res = await fetch(`${PROXY_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true, temperature, max_tokens: maxTokens, fallbackChain, customChain, localModel, agent }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Chat error ${res.status}: ${errText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.type === "fatal") throw new Error(parsed.error || "Model stream failed");
          if (parsed.type === "delta" && parsed.content) yield parsed.content;
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Full model catalog (from the proxy /api/models — openrouter, opencode, hermes, ollama)
// Flattened to entries: { id: "provider/model", label, provider, context, vision }
// Cached for the session after the first fetch.
// ---------------------------------------------------------------------------
let catalogCache = null;
const catalogListeners = new Set();

// Invalidation event: syncFreeModels() notifies subscribers so mounted
// dropdowns re-fetch immediately instead of staying stale until remount.
export function onCatalogInvalidated(fn) {
  catalogListeners.add(fn);
  return () => catalogListeners.delete(fn);
}

const PROVIDER_PREFIX = { openrouter: "openrouter", ollama: "ollama", opencode: "opencode", hermes: "hermes" };

export function flattenCatalog(data) {
  const out = [];
  for (const [provider, models] of Object.entries(data.models || {})) {
    for (const m of models) {
      out.push({
        id: `${PROVIDER_PREFIX[provider] || provider}/${m.id.replace(/^(openrouter|ollama|opencode|hermes)\//, "")}`,
        label: m.label,
        provider,
        context: m.context || 0,
        vision: Boolean(m.vision),
        paid: Boolean(m.paid),
      });
    }
  }
  return out;
}

export async function fetchModelCatalog() {
  if (catalogCache) return catalogCache;
  const data = await fetchModels();
  catalogCache = {
    entries: flattenCatalog(data),
    availability: data.provider || {},
  };
  return catalogCache;
}

// Chat-model health: which models are on rate-limit cooldown (server cache).
// Cached briefly on the client so the fallback chain doesn't re-query per turn.
let chatHealthCache = null;
export async function fetchChatHealth() {
  if (chatHealthCache && chatHealthCache.at > Date.now() - 30000) return chatHealthCache.data;
  try {
    const res = await fetch(`${PROXY_URL}/api/chat/health`);
    const data = await res.json();
    chatHealthCache = { data, at: Date.now() };
    return data;
  } catch {
    return { limited: [] };
  }
}

// Health tab: full model inventory, provider status, usage activity
export async function fetchHealth() {
  const res = await fetch(`${PROXY_URL}/api/health`);
  if (!res.ok) throw new Error(`Health failed ${res.status}`);
  return res.json();
}

// Sync the free-model catalog against the live provider lists
export async function syncFreeModels() {
  const res = await fetch(`${PROXY_URL}/api/models/sync`, { method: "POST" });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || `Sync failed ${res.status}`);
  catalogCache = null; // force the model dropdowns to re-fetch the updated catalog
  for (const fn of catalogListeners) { try { fn(); } catch { /* listener errors must not break sync */ } }
  return data;
}

// ---------------------------------------------------------------------------
// RAG: semantic retrieval over the Vault (server does vector+BM25 hybrid)
// ---------------------------------------------------------------------------
export async function ragStatus() {
  const res = await fetch(`${PROXY_URL}/api/rag/status`);
  if (!res.ok) throw new Error(`RAG status failed ${res.status}`);
  return res.json();
}

export async function ragReindex(force = false) {
  const res = await fetch(`${PROXY_URL}/api/rag/reindex`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  if (!res.ok) throw new Error(`RAG reindex failed ${res.status}`);
  return res.json();
}

export async function ragQuery(q, k = 5) {
  const res = await fetch(`${PROXY_URL}/api/rag/query?q=${encodeURIComponent(q)}&k=${k}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `RAG query failed ${res.status}`);
  return data.results || [];
}

// ---------------------------------------------------------------------------
// Routines: scheduled tasks Zazu runs automatically
// ---------------------------------------------------------------------------
export async function fetchRoutines() {
  const res = await fetch(`${PROXY_URL}/api/routines`);
  if (!res.ok) throw new Error(`Routines failed ${res.status}`);
  return res.json();
}

export async function createRoutine(payload) {
  const res = await fetch(`${PROXY_URL}/api/routines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Create failed ${res.status}`);
  return data.routine;
}

export async function updateRoutine(id, payload) {
  const res = await fetch(`${PROXY_URL}/api/routines/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Update failed ${res.status}`);
  return data.routine;
}

export async function deleteRoutine(id) {
  const res = await fetch(`${PROXY_URL}/api/routines/${id}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Delete failed ${res.status}`);
  return true;
}

export async function runRoutineNow(id) {
  const res = await fetch(`${PROXY_URL}/api/routines/${id}/run`, { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Run failed ${res.status}`);
  return true;
}

// Ask Zazu to draft a routine from a plain-language description
export async function assistRoutine(description) {
  const res = await fetch(`${PROXY_URL}/api/routines/assist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Zazu assist failed ${res.status}`);
  return data.draft;
}

// Create a routine straight from a plain-language description (Zazu's ROUTINE tool)
export async function createRoutineFromDescription(description) {
  const res = await fetch(`${PROXY_URL}/api/routines/create-from-description`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Routine creation failed ${res.status}`);
  return data;
}

export function fmtContext(ctx) {
  if (!ctx) return "";
  if (ctx >= 1000000) return `${Math.round((ctx / 1000000) * 10) / 10}M ctx`;
  return `${Math.round(ctx / 1000)}k ctx`;
}

// Sync label lookup over the cached catalog; falls back to the static lists
// before the catalog has loaded, then to the raw id.
export function catalogLabel(id) {
  const cached = catalogCache?.entries.find((e) => e.id === id);
  if (cached) return cached.label;
  const statics = [...ZAZU_FAST_MODELS, ...ZAZU_LOCAL_MODELS];
  const m = statics.find((x) => x.id === id);
  return m ? m.label : id;
}

export function modelDisplayName(modelId) {
  const m = MODELS.find((x) => x.id === modelId);
  return m ? m.label : modelId;
}

// ---------------------------------------------------------------------------
// Agent filesystem / knowledge endpoints (see server/index.js)
// ---------------------------------------------------------------------------
export async function fsList(dir) {
  const res = await fetch(`${PROXY_URL}/api/fs/list?path=${encodeURIComponent(dir)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `List failed ${res.status}`);
  return data;
}

export async function fsRead(file) {
  const res = await fetch(`${PROXY_URL}/api/fs/read?path=${encodeURIComponent(file)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Read failed ${res.status}`);
  return data;
}

export async function fsWrite(file, content, agent) {
  const res = await fetch(`${PROXY_URL}/api/fs/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: file, content, agent }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Write failed ${res.status}`);
  return data;
}

export async function bashShell(command, cwd, agent) {
  const res = await fetch(`${PROXY_URL}/api/bash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, cwd, agent }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Bash failed ${res.status}`);
  return data;
}

export async function webSearch(query) {
  const res = await fetch(`${PROXY_URL}/api/web/search?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Web search failed ${res.status}`);
  return data;
}

export async function webFetch(url) {
  const res = await fetch(`${PROXY_URL}/api/web/fetch?url=${encodeURIComponent(url)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Web fetch failed ${res.status}`);
  return data;
}

export async function calendarList({ from, to } = {}) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const res = await fetch(`${PROXY_URL}/api/calendar/events?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Calendar load failed ${res.status}`);
  return data.events || [];
}

export async function calendarCreate(event) {
  const res = await fetch(`${PROXY_URL}/api/calendar/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Event create failed ${res.status}`);
  return data.event;
}

export async function calendarUpdate(id, event) {
  const res = await fetch(`${PROXY_URL}/api/calendar/events/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Event update failed ${res.status}`);
  return data.event;
}

export async function calendarDelete(id) {
  const res = await fetch(`${PROXY_URL}/api/calendar/events/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Event delete failed ${res.status}`);
  return true;
}

export async function fetchImageModels() {
  const res = await fetch(`${PROXY_URL}/api/image/models`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Image model list failed ${res.status}`);
  return data;
}

export async function generateCloudImage({ modelId, prompt, width = 1024, height = 1024 }) {
  const res = await fetch(`${PROXY_URL}/api/image/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId, prompt, width, height }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Image generation failed ${res.status}`);
  return data;
}

export async function fetchSkills() {
  const res = await fetch(`${PROXY_URL}/api/skills`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Skills load failed ${res.status}`);
  return data;
}

// Skills are read on every message send (buildHistory) — cache them briefly so
// repeat sends don't re-fetch up to 8 SKILL.md files each time.
const skillCache = new Map(); // key -> { at, data }
const SKILL_CACHE_MS = 10 * 60 * 1000;

export async function readSkill(slug, scope = "installed", group = "") {
  const key = `${scope}:${group}:${slug}`;
  const hit = skillCache.get(key);
  if (hit && Date.now() - hit.at < SKILL_CACHE_MS) return hit.data;
  const route = scope === "library"
    ? `/api/skills/library/${encodeURIComponent(group)}/${encodeURIComponent(slug)}`
    : `/api/skills/installed/${encodeURIComponent(slug)}`;
  const res = await fetch(`${PROXY_URL}${route}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Skill read failed ${res.status}`);
  skillCache.set(key, { at: Date.now(), data });
  return data;
}

export async function installSkill(group, slug) {
  const res = await fetch(`${PROXY_URL}/api/skills/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group, slug }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Skill install failed ${res.status}`);
  skillCache.clear(); // a skill may have just been added/updated
  return data;
}

export async function fetchProjects() {
  const res = await fetch(`${PROXY_URL}/api/projects`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Projects load failed ${res.status}`);
  return data;
}

export async function fetchGitHubSecurityAudit() {
  const res = await fetch(`${PROXY_URL}/api/security/github-audit`, { cache: "no-store" });
  if (res.status === 404) {
    throw new Error("The running Agentic OS server is outdated. Restart server/index.js, then run the audit again.");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Security audit failed ${res.status}`);
  return data;
}

export async function fsSearch(q, dir = "Vault") {
  const res = await fetch(`${PROXY_URL}/api/fs/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(dir)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Search failed ${res.status}`);
  return data;
}

export function fsRawUrl(file) {
  return `${PROXY_URL}/api/fs/raw?path=${encodeURIComponent(file)}`;
}

export async function fetchOverview() {
  const res = await fetch(`${PROXY_URL}/api/overview`);
  if (!res.ok) throw new Error(`Overview failed ${res.status}`);
  return (await res.json()).overview;
}

export async function fetchMemory() {
  const res = await fetch(`${PROXY_URL}/api/memory`);
  if (!res.ok) return "";
  return (await res.json()).memory || "";
}

export async function learnNote(note) {
  const res = await fetch(`${PROXY_URL}/api/learn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  if (!res.ok) throw new Error(`Learn failed ${res.status}`);
  return true;
}

const MODELS = [
  { id: "openrouter/nvidia/nemotron-3.5-super-vl:free", label: "Nemotron 3.5 Super VL", provider: "openrouter", context: 1000000, vision: true },
  { id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B", provider: "openrouter", context: 1000000 },
  { id: "openrouter/nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning", provider: "openrouter", context: 1000000 },
  { id: "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", label: "Nemotron 3 Nano Omni 30B", provider: "openrouter", context: 256000, vision: true },
  { id: "openrouter/google/gemma-4-31b-it:free", label: "Gemma 4 31B", provider: "openrouter", context: 262144, vision: true },
  { id: "openrouter/google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B", provider: "openrouter", context: 262144, vision: true },
  { id: "openrouter/thinkingmachines/inkling-2-small:free", label: "Inkling 2 Small", provider: "openrouter", context: 1048576, vision: true },
  { id: "openrouter/dots-studio/dots-3-note-preview:free", label: "Dots 3 Note Preview", provider: "openrouter", context: 512000, vision: true },
  { id: "openrouter/baidu/ernie-5.5-flash-preview:free", label: "Ernie 5.5 Flash", provider: "openrouter", context: 1024000 },
  { id: "openrouter/cohere/north-mini-code:free", label: "North Mini Code", provider: "openrouter", context: 256000 },
  { id: "openrouter/liquid/lfm-3-1.7b:free", label: "LFM 3 1.7B", provider: "openrouter", context: 262144 },
  { id: "openrouter/recursive/flint-v1.0:free", label: "Flint v1.0", provider: "openrouter", context: 262144 },
  { id: "openrouter/openrouter/free", label: "OpenRouter Free (auto)", provider: "openrouter", context: 200000, vision: true },
  { id: "ollama/qwen3:8b", label: "Qwen3 8B (local Ollama)", provider: "ollama", context: 32768 },
  { id: "ollama/qwen3.5:4b", label: "Qwen3.5 4B (local Ollama)", provider: "ollama", context: 32768 },
  { id: "ollama/qwen3:0.6b", label: "Qwen3 0.6B (local Ollama)", provider: "ollama", context: 32768 },
  { id: "ollama/digitsflow/bonsai-8b:latest", label: "Bonsai 8B (local Ollama)", provider: "ollama", context: 32768 },
  { id: "opencode/big-pickle", label: "Big Pickle (opencode)", provider: "opencode" },
  { id: "opencode/beam-free", label: "Beam (opencode)", provider: "opencode" },
  { id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek v4.1 Flash (opencode)", provider: "opencode" },
  { id: "opencode/flint-40b-free", label: "Flint 40B (opencode)", provider: "opencode" },
  { id: "opencode/glm-5.3-flash-free", label: "GLM 5.3 Flash (opencode)", provider: "opencode" },
  { id: "opencode/iceman-free", label: "Iceman (opencode)", provider: "opencode" },
  { id: "opencode/inkling-2-small-free", label: "Inkling 2 Small (opencode)", provider: "opencode" },
  { id: "opencode/longcat-2.5-free", label: "LongCat 2.5 (opencode)", provider: "opencode" },
  { id: "opencode/mimo-v2.6-flash-free", label: "MiMo v2.6 Flash (opencode)", provider: "opencode" },
  { id: "opencode/minimax-m3.1-flash-free", label: "MiniMax M3.1 Flash (opencode)", provider: "opencode" },
  { id: "opencode/nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning (opencode)", provider: "opencode" },
  { id: "opencode/nemotron-3.5-super-vl-free", label: "Nemotron 3.5 Super VL (opencode)", provider: "opencode" },
  { id: "hermes/stepfun/step-3.7-flash:free", label: "Step 3.7 Flash (hermes)", provider: "hermes", context: 262144, vision: true },
  { id: "hermes/upstage/solar-mini4:free", label: "Solar Mini4 (hermes)", provider: "hermes", context: 524288 },
  { id: "hermes/meituan/longcat-2.5:free", label: "LongCat 2.5 (hermes)", provider: "hermes", context: 1048576, vision: true },
  { id: "hermes/xiaomi/mimo-v2.6-flash", label: "MiMo v2.6 Flash (hermes)", provider: "hermes", context: 1050000, vision: true, paid: true },
  { id: "hermes/openai/gpt-oss-20b", label: "GPT-OSS 20B (hermes)", provider: "hermes", context: 131072, paid: true },
  { id: "hermes/openai/gpt-6-luna", label: "GPT-6 Luna (hermes)", provider: "hermes", context: 1050000, vision: true, paid: true },
  { id: "hermes/anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5 (hermes)", provider: "hermes", context: 1000000, vision: true, paid: true },
];

export { MODELS };
