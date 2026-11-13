/* ==========================================================================
   Agentic OS — Model Proxy Server
   Reads API keys from C:\AgenticOS\config\.env (read-only) and proxies
   chat requests to OpenRouter (cloud), Nous Research / Hermes (cloud),
   and Ollama (local) with SSE streaming.
 ========================================================================== */
import fs from "fs";
import fsp from "fs/promises";
import dns from "node:dns/promises";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "path";
import express from "express";
import cors from "cors";
import { auditGitHubSafety, isOriginAllowed, isPathWithinRoots, LOCAL_HOST } from "./security.js";

// Filesystem roots the agents may navigate (read-only except /api/learn)
const AIACCESS_ROOT = "C:\\AIAssistant\\AIAccess";const PROJECTS_ROOT = path.join(AIACCESS_ROOT, "Projects");
const PROJECT_ROOT = "C:\\AIAssistant"; // includes the AgenticOS code folder
const APP_ROOT = path.join(PROJECT_ROOT, "AgenticOS");
const REFERENCE_ROOT = "C:\\AgenticOS"; // reference-only config, never modified
const SKILL_LIBRARY_ROOT = "C:\\AIAccess\\Skills"; // read-only skill source library
const SKILL_INSTALL_ROOT = path.join(AIACCESS_ROOT, "Skills");
const MEMORY_FILE = "C:\\AIAssistant\\AIAccess\\Vault\\Notes\\zazu-memory.md";
const CALENDAR_FILE = "C:\\AIAssistant\\AIAccess\\Calendar\\events.json";

// Zazu's local Kokoro voice service (reference: C:\AgenticOS\voice\server.py)
// Proxied here because the browser can't call it cross-origin directly.
const VOICE_SERVICE = "http://127.0.0.1:8765";
const KOKORO_CONFIG = { engine: "kokoro", voice: "bm_george", speed: 1.15, max_spoken_chars: 600 };

const ENV_FILE = "C:\\AgenticOS\\config\\.env";
const OLLAMA_BASE = "http://localhost:11434";
// opencode Zen — OpenAI-compatible endpoint (router.yaml: opencode provider)
const OPENCODE_API_BASE = "https://opencode.ai/zen/v1";
// Nous Research Portal (Hermes) — OpenAI-compatible inference endpoint.
// The Portal requires a free-form `tags` array containing a "user=" entry.
const HERMES_API_BASE = "https://inference-api.nousresearch.com/v1";
const HERMES_USER_TAG = "user=agentic-os";
// Free-model sync state (written by POST /api/models/sync, merged on startup)
const FREE_MODELS_FILE = "C:\\AIAssistant\\AgenticOS\\server\\free-models.json";
const SERVER_STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// Load .env (read-only, never modify)
// ---------------------------------------------------------------------------
function loadEnv(file) {
  const env = {};
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      env[key] = val;
    }
  } catch (e) {
    console.warn("Could not read .env file:", e.message);
  }
  return env;
}

const env = loadEnv(ENV_FILE);
const OPENROUTER_KEY = env.OPENROUTER_API_KEY || "";
// router.yaml: key_default: public — what the opencode CLI sends when no key is set
const OPENCODE_KEY = env.OPENCODE_API_KEY || "public";
// Nous Research Portal (Hermes) — key format sk-nous-... (portal.nousresearch.com)
const HERMES_KEY = env.NOUS_API_KEY || env.HERMES_API_KEY || "";
// Cloudflare Workers AI (reference config/images.yaml): keys for image generation
const CLOUDFLARE_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID || "";
const CLOUDFLARE_API_TOKEN = env.CLOUDFLARE_API_TOKEN || "";

// ---------------------------------------------------------------------------
// Available models (from C:\AgenticOS\config\models.lock.yaml, read-only)
// ---------------------------------------------------------------------------
const MODELS = {
  openrouter: [
    { id: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron 3.5 Super VL", context: 1000000, vision: true },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B", context: 1000000 },
    { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning", context: 1000000 },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", label: "Nemotron 3 Nano Omni 30B", context: 256000, vision: true },
    { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B", context: 262144, vision: true },
    { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B", context: 262144, vision: true },
    { id: "thinkingmachines/inkling-2-small:free", label: "Inkling 2 Small", context: 1048576, vision: true },
    { id: "dots-studio/dots-3-note-preview:free", label: "Dots 3 Note Preview", context: 512000, vision: true },
    { id: "baidu/ernie-5.5-flash-preview:free", label: "Ernie 5.5 Flash", context: 1024000 },
    { id: "cohere/north-mini-code:free", label: "North Mini Code", context: 256000 },
    { id: "liquid/lfm-3-1.7b:free", label: "LFM 3 1.7B", context: 262144 },
    { id: "liquid/lfm-2.5-2.6b:free", label: "LFM 2.5 2.6B", context: 65536 },
    { id: "recursive/flint-v1.0:free", label: "Flint v1.0", context: 262144 },
    { id: "openrouter/free", label: "OpenRouter Free (auto)", context: 200000, vision: true },
  ],
  ollama: [
    { id: "qwen3:8b", label: "Qwen3 8B (local)", context: 32768 },
    { id: "qwen3.5:4b", label: "Qwen3.5 4B (local)", context: 32768 },
    { id: "qwen3:0.6b", label: "Qwen3 0.6B (local)", context: 32768 },
    { id: "digitsflow/bonsai-8b:latest", label: "Bonsai 8B (local)", context: 32768 },
  ],
  opencode: [
    { id: "big-pickle", label: "Big Pickle", provider: "opencode" },
    { id: "beam-free", label: "Beam", provider: "opencode" },
    { id: "deepseek-v4.1-flash-free", label: "DeepSeek v4.1 Flash", provider: "opencode" },
    { id: "flint-40b-free", label: "Flint 40B", provider: "opencode" },
    { id: "glm-5.3-flash-free", label: "GLM 5.3 Flash", provider: "opencode" },
    { id: "iceman-free", label: "Iceman", provider: "opencode" },
    { id: "inkling-2-small-free", label: "Inkling 2 Small", provider: "opencode" },
    { id: "longcat-2.5-free", label: "LongCat 2.5", provider: "opencode" },
    { id: "mimo-v2.6-flash-free", label: "MiMo v2.6 Flash", provider: "opencode" },
    { id: "minimax-m3.1-flash-free", label: "MiniMax M3.1 Flash", provider: "opencode" },
    { id: "nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning", provider: "opencode" },
    { id: "nemotron-3.5-super-vl-free", label: "Nemotron 3.5 Super VL", provider: "opencode" },
  ],
  hermes: [
    // Nous Portal free-tier models (":free", $0/token)
    { id: "stepfun/step-3.7-flash:free", label: "Step 3.7 Flash", context: 262144, vision: true },
    { id: "upstage/solar-mini4:free", label: "Solar Mini4", context: 524288 },
    { id: "meituan/longcat-2.5:free", label: "LongCat 2.5", context: 1048576, vision: true },
    // Paid catalog models (subscription tier, bill per token)
    { id: "xiaomi/mimo-v2.6-flash", label: "MiMo v2.6 Flash", context: 1050000, vision: true, paid: true },
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", context: 131072, paid: true },
    { id: "openai/gpt-6-luna", label: "GPT-6 Luna", context: 1050000, vision: true, paid: true },
    { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", context: 1000000, vision: true, paid: true },
  ],
};

// ---------------------------------------------------------------------------
// Fallback chains: ordered lists of models to try in sequence
// These are used by the server-side fallback mechanism
// ---------------------------------------------------------------------------
const FALLBACK_CHAINS = {
  // Default chain for Zazu (orchestrator) - tries cloud first, then local
  default: [
    // OpenRouter free models (cloud)
    "openrouter/baidu/ernie-5.5-flash-preview:free",
    "openrouter/google/gemma-4-26b-a4b-it:free",
    "openrouter/nvidia/nemotron-3.5-lightning:free",
    "openrouter/thinkingmachines/inkling-2-small:free",
    "openrouter/cohere/north-mini-code:free",
    "openrouter/liquid/lfm-2.5-2.6b:free",
    // OpenCode free models (cloud) - only if OPENCODE_API_KEY is set
    "opencode/glm-5.3-flash-free",
    "opencode/deepseek-v4.1-flash-free",
    "opencode/minimax-m3.1-flash-free",
    "opencode/mimo-v2.6-flash-free",
    "opencode/nemotron-3.5-lightning-free",
    // Hermes (Nous Portal) free models - only if NOUS_API_KEY is set
    "hermes/stepfun/step-3.7-flash:free",
    "hermes/upstage/solar-mini4:free",
    "hermes/meituan/longcat-2.5:free",
    // Local Ollama models (last resort - never rate limited)
    "ollama/qwen3:8b",
    "ollama/qwen3.5:4b",
    "ollama/digitsflow/bonsai-8b:latest",
    "ollama/qwen3:0.6b",
  ],
  // Chain for coding tasks
  coder: [
    "openrouter/cohere/north-mini-code:free",
    "openrouter/baidu/ernie-5.5-flash-preview:free",
    "openrouter/google/gemma-4-26b-a4b-it:free",
    "opencode/glm-5.3-flash-free",
    "opencode/deepseek-v4.1-flash-free",
    "hermes/stepfun/step-3.7-flash:free",
    "ollama/qwen3:8b",
    "ollama/digitsflow/bonsai-8b:latest",
  ],
  // Chain for research tasks (long context preferred)
  researcher: [
    "openrouter/baidu/ernie-5.5-flash-preview:free",
    "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    "openrouter/thinkingmachines/inkling-2-small:free",
    "opencode/nemotron-3.5-super-vl-free",
    "hermes/meituan/longcat-2.5:free",
    "ollama/qwen3:8b",
  ],
  // Chain for vision tasks
  vision: [
    "openrouter/nvidia/nemotron-3.5-super-vl:free",
    "openrouter/google/gemma-4-31b-it:free",
    "openrouter/thinkingmachines/inkling-2-small:free",
    "openrouter/dots-studio/dots-3-note-preview:free",
    "opencode/nemotron-3.5-super-vl-free",
  ],
  // Local-only chain (for offline/air-gapped)
  local: [
    "ollama/qwen3:8b",
    "ollama/qwen3.5:4b",
    "ollama/digitsflow/bonsai-8b:latest",
    "ollama/qwen3:0.6b",
  ],
};

// ---------------------------------------------------------------------------
// Free-model sync: fetch live model lists from each cloud provider, keep only
// free chat models, and diff them against the configured catalog. Paid models
// and fixed entries are preserved; synced results persist to FREE_MODELS_FILE
// so they survive server restarts.
// ---------------------------------------------------------------------------
function isChatModelId(id) {
  return !/embed|whisper|tts|audio|vision-embed|:batch/i.test(id) && !id.startsWith("~");
}

function liveLabel(name, fallbackId) {
  const label = String(name || "").replace(/^[^:]{1,40}:\s*/, "").trim();
  return label || fallbackId;
}

async function fetchOpenRouterFree() {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter models list failed ${res.status}`);
  const data = await res.json();
  return (data.data || [])
    .filter((m) => m.id.endsWith(":free"))
    .map((m) => ({
      id: m.id,
      label: liveLabel(m.name, m.id),
      context: m.context_length || 0,
      vision: (m.architecture?.input_modalities || []).includes("image"),
    }));
}

async function fetchOpencodeFree() {
  const res = await fetch(`${OPENCODE_API_BASE}/models`, {
    headers: { Authorization: `Bearer ${OPENCODE_KEY}` },
  });
  if (!res.ok) throw new Error(`opencode models list failed ${res.status}`);
  const data = await res.json();
  return (data.data || [])
    .filter((m) => isChatModelId(m.id))
    .map((m) => ({
      id: m.id,
      label: liveLabel(m.name, m.id),
      context: m.limit?.context || 0,
      vision: /image/i.test(m.modalities?.input || ""),
    }));
}

async function fetchHermesFree() {
  const res = await fetch(`${HERMES_API_BASE}/models`, {
    headers: { Authorization: `Bearer ${HERMES_KEY}` },
  });
  if (!res.ok) throw new Error(`Hermes models list failed ${res.status}`);
  const data = await res.json();
  return (data.data || [])
    .filter((m) => isChatModelId(m.id))
    .filter((m) =>
      m.id.endsWith(":free") ||
      (parseFloat(m.pricing?.prompt) === 0 && parseFloat(m.pricing?.completion) === 0))
    .map((m) => ({
      id: m.id,
      label: liveLabel(m.name, m.id),
      context: m.context_length || 0,
      vision: (m.architecture?.input_modalities || []).includes("image"),
    }));
}

// Entries managed by sync per provider; everything else is hand-curated.
// openrouter: the auto-router pseudo model is kept. hermes: paid models kept.
function managedEntry(entry, provider) {
  if (provider === "openrouter") return entry.id !== "openrouter/free";
  if (provider === "hermes") return !entry.paid;
  return true; // opencode + any other provider: fully managed
}

function mergeProviderModels(provider, current, synced) {
  const keep = current.filter((m) => !managedEntry(m, provider));
  const byId = new Map(current.map((m) => [m.id, m]));
  const merged = synced.map((m) => {
    const existing = byId.get(m.id);
    // Preserve hand-set labels/contexts for known ids, take live data otherwise
    return existing ? { ...m, label: existing.label, context: existing.context || m.context, vision: existing.vision || m.vision } : m;
  });
  const known = new Set(merged.map((m) => m.id));
  for (const k of keep) if (!known.has(k.id)) merged.push(k);
  return merged;
}

function loadFreeModelState() {
  try {
    return JSON.parse(fs.readFileSync(FREE_MODELS_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveFreeModelState(state) {
  try {
    fs.writeFileSync(FREE_MODELS_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn("Could not save free-model sync state:", e.message);
  }
}

// On startup, re-apply the last successful sync so restarted servers keep
// serving the synced catalog until the next sync.
(function mergeSyncedModels() {
  const state = loadFreeModelState();
  if (!state?.providers) return;
  for (const [provider, entries] of Object.entries(state.providers)) {
    if (!MODELS[provider] || !Array.isArray(entries)) continue;
    MODELS[provider] = mergeProviderModels(provider, MODELS[provider], entries);
  }
})();

// ---------------------------------------------------------------------------
// Per-model usage tracking ("what are the models working on")
// ---------------------------------------------------------------------------
const modelUsage = new Map(); // full model id -> { requests, errors, lastUsed, lastError, lastErrorAt }

function noteModelUse(modelId) {
  const u = modelUsage.get(modelId) || { requests: 0, errors: 0 };
  u.requests += 1;
  u.lastUsed = Date.now();
  modelUsage.set(modelId, u);
}

function noteModelError(modelId, message) {
  const u = modelUsage.get(modelId) || { requests: 0, errors: 0 };
  u.errors += 1;
  u.lastError = String(message || "").slice(0, 300);
  u.lastErrorAt = Date.now();
  modelUsage.set(modelId, u);
}

// Helper: get fallback chain by name, with optional custom chain override
function getFallbackChain(chainName, customChain = null) {  if (customChain && Array.isArray(customChain) && customChain.length > 0) {
    return customChain;
  }
  return FALLBACK_CHAINS[chainName] || FALLBACK_CHAINS.default;
}

// Helper: filter chain to only include models whose providers are available
function filterAvailableModels(chain) {
  return chain.filter((modelId) => {
    const provider = modelId.startsWith("ollama/") ? "ollama"
      : modelId.startsWith("opencode/") ? "opencode"
      : modelId.startsWith("hermes/") ? "hermes"
      : "openrouter";

    // Skip opencode if no API key configured
    if (provider === "opencode" && !OPENCODE_KEY) return false;
    // Skip openrouter if no API key configured
    if (provider === "openrouter" && !OPENROUTER_KEY) return false;
    // Skip hermes (Nous Portal) if no API key configured
    if (provider === "hermes" && !HERMES_KEY) return false;
    // Ollama is always available (local)
    return true;
  });
}

// Helper: check if model is rate-limited (uses existing cache)
function isModelRateLimited(modelId) {
  return isModelLimited(modelId);
}

// ---------------------------------------------------------------------------
// Model rate-limit cache: when a provider returns 429/usage-limit, skip it
// instantly for a cooldown window instead of re-dialing it every request.
// ---------------------------------------------------------------------------
const LIMIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const modelLimitCache = new Map(); // model id -> limited-until timestamp

function isModelLimited(modelId) {
  const until = modelLimitCache.get(modelId);
  if (!until) return false;
  if (until <= Date.now()) {
    modelLimitCache.delete(modelId);
    return false;
  }
  return true;
}

function markModelLimited(modelId) {
  modelLimitCache.set(modelId, Date.now() + LIMIT_COOLDOWN_MS);
}

function markModelHealthy(modelId) {
  modelLimitCache.delete(modelId);
}

function isRateLimitError(message) {
  return /429|usage limit|rate.?limit|quota/i.test(String(message));
}

// Express app
const app = express();
app.use(cors({ origin: (origin, callback) => callback(null, isOriginAllowed(origin)) }));
app.use((req, res, next) => {
  if (!isOriginAllowed(req.get("origin"))) return res.status(403).json({ error: "Origin not allowed" });
  next();
});
app.use(express.json({ limit: "16mb" }));

// Local-only pre-publish audit. Results omit all matched source text and values.
app.get("/api/security/github-audit", (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(auditGitHubSafety(APP_ROOT));
  } catch {
    res.status(500).json({ error: "The local project security audit could not be completed." });
  }
});

// List available models
app.get("/api/models", (_req, res) => {
  res.json({ models: MODELS, provider: { openrouter: Boolean(OPENROUTER_KEY), ollama: true, opencode: true, hermes: Boolean(HERMES_KEY) } });
});

// Model health for the fallback chain (which models are on cooldown)
app.get("/api/chat/health", (_req, res) => {
  const limited = [];
  for (const [modelId, until] of modelLimitCache) {
    if (until > Date.now()) limited.push(modelId);
    else modelLimitCache.delete(modelId);
  }
  res.json({ limited, cooldownMs: LIMIT_COOLDOWN_MS });
});

// Health tab: full model inventory + provider status + usage activity
app.get("/api/health", (_req, res) => {
  const now = Date.now();
  const models = {};
  for (const [provider, list] of Object.entries(MODELS)) {
    models[provider] = list.map((m) => {
      const fullId = `${provider}/${m.id}`;
      const usage = modelUsage.get(fullId) || null;
      const cooldownUntil = modelLimitCache.get(fullId) || 0;
      return {
        ...m,
        cooldownUntil: cooldownUntil > now ? cooldownUntil : null,
        usage: usage ? {
          requests: usage.requests,
          errors: usage.errors,
          lastUsed: usage.lastUsed || null,
          lastError: usage.lastError || null,
          lastErrorAt: usage.lastErrorAt || null,
        } : null,
      };
    });
  }
  const activity = [...modelUsage.entries()]
    .map(([modelId, u]) => ({ model: modelId, ...u }))
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  const syncState = loadFreeModelState();
  res.json({
    providers: {
      openrouter: Boolean(OPENROUTER_KEY),
      ollama: true,
      opencode: Boolean(OPENCODE_KEY),
      hermes: Boolean(HERMES_KEY),
    },
    models,
    activity,
    cooldowns: [...modelLimitCache.entries()]
      .filter(([, until]) => until > now)
      .map(([modelId, until]) => ({ model: modelId, until })),
    lastSync: syncState?.lastSync || null,
    startedAt: SERVER_STARTED_AT,
  });
});

// Sync the free-model catalog against the live provider model lists.
// Applies diffs in memory, trims fallback chains, and persists the result.
const FREE_SYNC_SOURCES = {
  openrouter: fetchOpenRouterFree,
  opencode: fetchOpencodeFree,
  hermes: fetchHermesFree,
};

app.post("/api/models/sync", async (_req, res) => {
  const results = {};
  const state = { lastSync: new Date().toISOString(), providers: {} };

  for (const [provider, fetcher] of Object.entries(FREE_SYNC_SOURCES)) {
    try {
      const live = await fetcher();
      const current = MODELS[provider] || [];
      const managed = current.filter((m) => managedEntry(m, provider));
      const managedIds = new Set(managed.map((m) => m.id));
      const liveIds = new Set(live.map((m) => m.id));

      const added = live.filter((m) => !managedIds.has(m.id)).map((m) => m.id);
      const removed = managed.filter((m) => !liveIds.has(m.id)).map((m) => m.id);

      MODELS[provider] = mergeProviderModels(provider, current, live);
      state.providers[provider] = live;

      // Trim removed models out of the fallback chains so chains stay valid
      const removedFull = new Set(removed.map((id) => `${provider}/${id}`));
      for (const chain of Object.values(FALLBACK_CHAINS)) {
        for (let i = chain.length - 1; i >= 0; i--) {
          if (removedFull.has(chain[i])) chain.splice(i, 1);
        }
      }

      results[provider] = { ok: true, total: live.length, added, removed };
    } catch (err) {
      results[provider] = { ok: false, error: err.message };
    }
  }

  saveFreeModelState(state);
  res.json({ ok: true, lastSync: state.lastSync, providers: results });
});

function isValidChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100) return false;
  return messages.every((message) => {
    if (!message || !["system", "user", "assistant"].includes(message.role)) return false;
    if (typeof message.content === "string") return message.content.length <= 250_000;
    if (!Array.isArray(message.content) || message.content.length > 32) return false;
    return message.content.every((part) => {
      if (part?.type === "text") return typeof part.text === "string" && part.text.length <= 250_000;
      const url = part?.type === "image_url" ? part.image_url?.url : "";
      return typeof url === "string" && url.length <= 12 * 1024 * 1024 && /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(url);
    });
  });
}

// Chat completion with SSE streaming — supports server-side fallback chains
// Request body: { model, messages, stream, temperature, max_tokens, fallbackChain?, customChain? }
// - model: primary model to try first (optional if fallbackChain/customChain provided)
// - fallbackChain: name of predefined chain ("default", "coder", "researcher", "vision", "local")
// - customChain: array of model IDs to try in order (overrides fallbackChain)
app.post("/api/chat", async (req, res) => {
  const {
    model,
    messages,
    stream = true,
    temperature = 0.7,
    max_tokens,
    fallbackChain = "default",
    customChain = null,
    localModel,
  } = req.body || {};

  if (!isValidChatMessages(messages)) {
    return res.status(400).json({ error: "messages must contain 1–100 valid chat messages" });
  }
  if (model !== undefined && (typeof model !== "string" || model.length > 200)) {
    return res.status(400).json({ error: "model must be a string under 200 characters" });
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    return res.status(400).json({ error: "temperature must be between 0 and 2" });
  }
  if (max_tokens !== undefined && (!Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > 65536)) {
    return res.status(400).json({ error: "max_tokens must be an integer between 1 and 65536" });
  }

  // Build the fallback chain
  let chain = getFallbackChain(fallbackChain, customChain);
  
  // If a primary model is specified, put it at the front of the chain
  if (model) {
    chain = [model, ...chain.filter((m) => m !== model)];
  }

  // Honor each agent's configured local last-resort model without losing the
  // cloud fallback chain. If localModel is explicitly empty, remove local tries.
  if (localModel !== undefined) {
    chain = chain.filter((id) => !id.startsWith("ollama/"));
    if (localModel) chain.push(localModel);
  }
  
  // Filter to only available providers
  chain = filterAvailableModels(chain);
  
  if (chain.length === 0) {
    return res.status(503).json({ error: "No available models (check API keys)" });
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.locals.streamedContent = false;
  const clientController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) clientController.abort(new Error("Client disconnected"));
  });

  // Send initial event indicating fallback chain being used
  res.write(`data: ${JSON.stringify({ type: "fallback_chain", chain: chain.slice(0, 5) })}\n\n`);

  // Try each model in the chain
  let lastError = null;
  for (const modelId of chain) {
    // Skip models that are rate-limited (in cooldown)
    if (isModelRateLimited(modelId)) {
      res.write(`data: ${JSON.stringify({ type: "skip", model: modelId, reason: "rate_limited" })}\n\n`);
      continue;
    }

    const provider = modelId.startsWith("ollama/") ? "ollama"
      : modelId.startsWith("opencode/") ? "opencode"
      : modelId.startsWith("hermes/") ? "hermes"
      : "openrouter";
    const cleanModelId = modelId.replace(/^(ollama|opencode|openrouter|hermes)\//, "");

    try {
      // Attempt to proxy to this model
      if (provider === "ollama") {
        await proxyOllama(res, cleanModelId, messages, stream, temperature, max_tokens, clientController.signal);
      } else if (provider === "opencode") {
        await proxyOpencode(res, cleanModelId, messages, stream, temperature, max_tokens, clientController.signal);
      } else if (provider === "hermes") {
        await proxyHermes(res, cleanModelId, messages, stream, temperature, max_tokens, clientController.signal);
      } else {
        await proxyOpenRouter(res, cleanModelId, messages, stream, temperature, max_tokens, clientController.signal);
      }
      
      // Success - mark model healthy and track usage
      markModelHealthy(modelId);
      noteModelUse(modelId);
      return;
    } catch (err) {
      if (clientController.signal.aborted || res.destroyed || res.writableEnded) return;
      lastError = err;
      console.error(`Model ${modelId} failed:`, err.message);
      noteModelError(modelId, err.message);

      // Do not splice a different provider's reply after content was emitted.
      if (res.locals.streamedContent) {
        res.write(`data: ${JSON.stringify({ type: "fatal", model: modelId, error: err.message })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // If rate limited, add to cooldown cache
      if (isRateLimitError(err.message)) {
        markModelLimited(modelId);
        res.write(`data: ${JSON.stringify({ type: "rate_limited", model: modelId })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: "error", model: modelId, error: err.message })}\n\n`);
      }
      
      // Continue to next model in chain
      continue;
    }
  }

  // All models in chain failed
  const failure = `All models in fallback chain failed. Last error: ${lastError?.message || "Unknown error"}`;
  if (!res.headersSent) {
    res.status(502).json({ error: failure });
  } else if (!res.destroyed && !res.writableEnded) {
    res.write(`data: ${JSON.stringify({ type: "fatal", error: failure })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

async function proxyHermes(res, modelId, messages, stream, temperature, maxTokens, clientSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(`${HERMES_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HERMES_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        stream: true,
        temperature,
        max_tokens: maxTokens,
        // Nous Portal rejects requests without a "user=" tag
        tags: [HERMES_USER_TAG],
      }),
      signal: clientSignal ? AbortSignal.any([controller.signal, clientSignal]) : controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Hermes ${response.status}: ${errText}`);
    }

    // OpenAI-compatible SSE format, same as OpenRouter/opencode
    await relayOpenAiSse(res, response);
  } finally {
    clearTimeout(timeout);
  }
}

async function proxyOpencode(res, modelId, messages, stream, temperature, maxTokens, clientSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(`${OPENCODE_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENCODE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        stream: true,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: clientSignal ? AbortSignal.any([controller.signal, clientSignal]) : controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`opencode ${response.status}: ${errText}`);
    }

    // Same OpenAI-compatible SSE format as OpenRouter
    await relayOpenAiSse(res, response);
  } finally {
    clearTimeout(timeout);
  }
}

async function relayOpenAiSse(res, response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content || "";
        if (content) {
          res.locals.streamedContent = true;
          res.write(`data: ${JSON.stringify({ type: "delta", content })}\n\n`);
        }
      } catch {
        // ignore unparseable lines
      }
    }
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

async function proxyOpenRouter(res, modelId, messages, stream, temperature, maxTokens, clientSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5174",
        "X-Title": "Agentic OS",
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        stream: true,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: clientSignal ? AbortSignal.any([controller.signal, clientSignal]) : controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${errText}`);
    }

    await relayOpenAiSse(res, response);
  } finally {
    clearTimeout(timeout);
  }
}

function toOllamaMessages(messages) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const text = [];
    const images = [];
    for (const part of message.content) {
      if (part?.type === "text" && typeof part.text === "string") text.push(part.text);
      const imageUrl = part?.image_url?.url;
      const match = typeof imageUrl === "string" && imageUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
      if (match) images.push(match[1]);
    }
    return {
      role: message.role,
      content: text.join("\n") || (images.length ? "Describe the attached image(s)." : ""),
      ...(images.length ? { images } : {}),
    };
  });
}

async function proxyOllama(res, modelId, messages, stream, temperature, maxTokens, clientSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: toOllamaMessages(messages),
        stream: true,
        options: { temperature, num_predict: maxTokens },
      }),
      signal: clientSignal ? AbortSignal.any([controller.signal, clientSignal]) : controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama ${response.status}: ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          const content = parsed.message?.content || "";
          if (content) {
            res.locals.streamedContent = true;
            res.write(`data: ${JSON.stringify({ type: "delta", content })}\n\n`);
          }
          if (parsed.done) {
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        } catch {
          // ignore unparseable lines
        }
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Filesystem access for agents (read-only navigation of OS + vault)
// ---------------------------------------------------------------------------
function isAllowedPath(full) {
  return isPathWithinRoots(full, [AIACCESS_ROOT, PROJECT_ROOT, REFERENCE_ROOT]);
}

// Resolve a user/agent-supplied path safely. Relative paths try AIAccess
// first, then the AIAssistant project root.
function resolveSafe(rel) {
  if (!rel) return null;
  const clean = String(rel).replace(/["'`]/g, "").trim();
  if (!clean) return null;
  if (path.isAbsolute(clean)) {
    const full = path.normalize(clean);
    return isAllowedPath(full) ? full : null;
  }
  for (const base of [AIACCESS_ROOT, PROJECT_ROOT]) {
    const full = path.resolve(base, clean);
    if (isAllowedPath(full) && fs.existsSync(full)) return full;
  }
  const fallback = path.resolve(AIACCESS_ROOT, clean);
  return isAllowedPath(fallback) ? fallback : null;
}

app.get("/api/fs/list", async (req, res) => {
  const full = resolveSafe(req.query.path || "");
  if (!full) return res.status(400).json({ error: "Path not allowed" });
  try {
    const stat = await fsp.stat(full);
    if (!stat.isDirectory()) {
      return res.json({ path: full, entries: [{ name: path.basename(full), type: "file", size: stat.size }] });
    }
    const dirents = await fsp.readdir(full, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d) => {
        let size = 0;
        let modified = 0;
        try {
          const s = await fsp.stat(path.join(full, d.name));
          size = d.isFile() ? s.size : 0;
          modified = s.mtimeMs;
        } catch { /* unreadable entry */ }
        return {
          name: d.name,
          type: d.isDirectory() ? "dir" : "file",
          size,
          modified,
        };
      })
    );
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    res.json({ path: full, entries });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Recursive search across a folder: matches file names and (for text files) content.
// Returns file paths relative to AIAccess plus a short snippet.
const SEARCH_SKIP = new Set(["node_modules", ".git"]);
app.get("/api/fs/search", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const root = resolveSafe(req.query.path || "Vault");
  if (!q) return res.json({ results: [] });
  if (!root) return res.status(400).json({ error: "Path not allowed" });

  const results = [];
  const TEXT_EXT = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".js", ".jsx", ".ts", ".css", ".html"]);

  async function walk(dir, depth) {
    if (depth > 6 || results.length >= 200) return;
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (results.length >= 200) return;
      if (SEARCH_SKIP.has(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name.toLowerCase().includes(q)) {
          results.push({ name: d.name, path: path.relative(AIACCESS_ROOT, full).replaceAll("\\", "/"), type: "dir", snippet: "" });
        }
        await walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(d.name).toLowerCase();
      const nameHit = d.name.toLowerCase().includes(q);
      let snippet = "";
      if (TEXT_EXT.has(ext)) {
        try {
          const text = await fsp.readFile(full, "utf8");
          const idx = text.toLowerCase().indexOf(q);
          if (idx !== -1) {
            const start = Math.max(0, idx - 60);
            snippet = text.slice(start, idx + q.length + 80).replace(/\s+/g, " ").trim();
          }
        } catch { /* unreadable */ }
      }
      if (nameHit || snippet) {
        results.push({
          name: d.name,
          path: path.relative(AIACCESS_ROOT, full).replaceAll("\\", "/"),
          type: "file",
          snippet,
        });
      }
    }
  }

  await walk(root, 0);
  res.json({ results });
});

// Raw file bytes (used for image thumbnails in the Vault)
app.get("/api/fs/raw", (req, res) => {
  const full = resolveSafe(req.query.path || "");
  if (!full) return res.status(400).json({ error: "Path not allowed" });
  res.sendFile(full, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: err.message });
  });
});

const MAX_READ = 60 * 1024; // 60 KB cap per read

app.get("/api/fs/read", async (req, res) => {
  const full = resolveSafe(req.query.path || "");
  if (!full) return res.status(400).json({ error: "Path not allowed" });
  try {
    const stat = await fsp.stat(full);
    if (stat.isDirectory()) return res.status(400).json({ error: "Path is a directory — use /api/fs/list" });
    let content = await fsp.readFile(full, "utf8");
    let truncated = false;
    if (content.length > MAX_READ) {
      content = content.slice(0, MAX_READ);
      truncated = true;
    }
    res.json({ path: full, content, truncated, size: stat.size });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Scoped specialist writes. Coder may write source/project files; Scriber and
// Scout may write only their designated Vault collections.
const WRITE_LIMIT = 1024 * 1024;
function resolveWriteTarget(input) {
  const clean = String(input || "").replace(/["'`]/g, "").trim().replaceAll("/", path.sep);
  if (!clean) return null;
  if (path.isAbsolute(clean)) return path.resolve(clean);
  if (/^AgenticOS([\\/]|$)/i.test(clean)) return path.resolve(PROJECT_ROOT, clean);
  if (/^(Vault|Projects|Skills)([\\/]|$)/i.test(clean)) return path.resolve(AIACCESS_ROOT, clean);
  return null;
}
function pathInside(file, root) {
  const f = path.resolve(file).toLowerCase();
  const r = path.resolve(root).toLowerCase();
  return f === r || f.startsWith(r + path.sep.toLowerCase());
}
function canAgentWrite(agent, file) {
  const codeRoot = path.join(PROJECT_ROOT, "AgenticOS");
  const projectsRoot = path.join(AIACCESS_ROOT, "Projects");
  const vaultRoot = path.join(AIACCESS_ROOT, "Vault");
  const vaultCollection = path.relative(vaultRoot, file).split(path.sep)[0]?.toLowerCase();
  const blocked = file.toLowerCase().split(path.sep).some((part) => ["node_modules", ".git", "dist"].includes(part));
  if (blocked) return false;
  if (agent === "coder") return pathInside(file, codeRoot) || pathInside(file, projectsRoot);
  if (agent === "scriber") return pathInside(file, vaultRoot) && ["notes", "reports", "logs", "learning"].includes(vaultCollection);
  if (agent === "scout") return pathInside(file, vaultRoot) && ["learning", "reports", "search"].includes(vaultCollection);
  return false;
}

app.post("/api/fs/write", async (req, res) => {
  const { path: requested, content, agent } = req.body || {};
  if (typeof content !== "string") return res.status(400).json({ error: "content must be text" });
  if (Buffer.byteLength(content, "utf8") > WRITE_LIMIT) return res.status(413).json({ error: "Write limit is 1 MB per file" });
  const target = resolveWriteTarget(requested);
  if (!target || !isAllowedPath(target) || !canAgentWrite(String(agent || "").toLowerCase(), target)) {
    return res.status(403).json({ error: `Agent ${agent || "unknown"} cannot write to that path` });
  }
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, "utf8");
    res.json({ ok: true, path: target, bytes: Buffer.byteLength(content, "utf8") });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function isPublicIp(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
  }
  if (net.isIP(address) === 6) {
    const ip = address.toLowerCase();
    return ip === "::1" ? false : !(ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:") || ip === "::");
  }
  return false;
}

async function validatePublicUrl(raw) {
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Only http(s) URLs are supported");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("Local URLs are not allowed");
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((item) => !isPublicIp(item.address))) throw new Error("URL must resolve to a public address");
  return url;
}

function stripHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?\s*>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

app.get("/api/web/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.json({ results: [] });
  try {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", query.slice(0, 300));
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AgenticOS/1.0)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Search provider returned ${response.status}`);
    const html = (await response.text()).slice(0, 2_000_000);
    const results = [];
    for (const block of html.split(/result__body/).slice(1)) {
      const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!link) continue;
      let href = link[1].replaceAll("&amp;", "&");
      try {
        const linkUrl = new URL(href, "https://duckduckgo.com");
        href = linkUrl.searchParams.get("uddg") || linkUrl.href;
      } catch { continue; }
      const title = stripHtml(link[2]);
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/[^>]+>/i);
      results.push({ title, url: href, snippet: snippetMatch ? stripHtml(snippetMatch[1]) : "" });
      if (results.length >= 8) break;
    }
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: `Web search failed: ${err.message}` });
  }
});

app.get("/api/web/fetch", async (req, res) => {
  try {
    const url = await validatePublicUrl(String(req.query.url || ""));
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AgenticOS/1.0)", Accept: "text/html,text/plain,application/xhtml+xml" },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Page returned ${response.status}`);
    const type = response.headers.get("content-type") || "";
    if (!/text\/(html|plain)|application\/(xhtml\+xml|json)/i.test(type)) throw new Error(`Unsupported content type: ${type}`);
    const html = (await response.text()).slice(0, 1_000_000);
    const title = stripHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || url.hostname);
    res.json({ url: url.href, title, content: stripHtml(html).slice(0, 24000) });
  } catch (err) {
    res.status(400).json({ error: `Web fetch failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Projects dashboard — read-only metadata; never runs project build commands.
// The issue count is a heuristic count of TODO/FIXME/BUG source markers.
// ---------------------------------------------------------------------------
const execFileAsync = promisify(execFile);
const PROJECT_SKIP_DIRS = new Set([".git", "node_modules", "library", "temp", "obj", "bin", "build", "builds", "dist", ".next", ".venv", "venv", "__pycache__", "target"]);
const PROJECT_TEXT_EXTS = new Set([".cs", ".js", ".jsx", ".ts", ".tsx", ".py", ".dart", ".java", ".go", ".rs", ".cpp", ".h", ".hpp", ".md", ".gd", ".lua", ".php", ".rb", ".swift"]);

async function readProjectVersion(dir) {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(dir, "package.json"), "utf8"));
    if (pkg.version) return String(pkg.version);
  } catch { /* try other ecosystems */ }
  for (const filename of ["pyproject.toml", "Cargo.toml", "pubspec.yaml"]) {
    try {
      const text = await fsp.readFile(path.join(dir, filename), "utf8");
      const version = text.match(/^version\s*=\s*["']([^"']+)["']|^version:\s*([^\s#]+)/m);
      if (version) return version[1] || version[2];
    } catch { /* absent */ }
  }
  for (const filename of ["VERSION", "version.txt"]) {
    try {
      const value = (await fsp.readFile(path.join(dir, filename), "utf8")).trim().split(/\r?\n/)[0];
      if (value) return value.slice(0, 80);
    } catch { /* absent */ }
  }
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const projectFile = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csproj"));
    if (projectFile) {
      const text = await fsp.readFile(path.join(dir, projectFile.name), "utf8");
      const version = text.match(/<(?:Version|AssemblyVersion|VersionPrefix)>([^<]+)<\//i);
      if (version) return version[1].trim();
    }
  } catch { /* absent */ }
  return "Not specified";
}

async function readProjectDescription(dir) {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(dir, "package.json"), "utf8"));
    if (pkg.description) return String(pkg.description).slice(0, 240);
  } catch { /* try README */ }
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const readme = entries.find((entry) => entry.isFile() && /^readme(?:\..+)?$/i.test(entry.name));
    if (!readme) return "";
    const text = await fsp.readFile(path.join(dir, readme.name), "utf8");
    const summary = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#") && !line.startsWith("!"));
    return (summary || "").replace(/[*_`]/g, "").slice(0, 240);
  } catch { return ""; }
}

async function readGitInfo(dir) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "log", "-1", "--format=%H%x1f%s%x1f%aI%x1f%an"], {
      timeout: 5000, windowsHide: true, maxBuffer: 128 * 1024,
    });
    const [hash, subject, date, author] = stdout.trim().split("\x1f");
    if (!hash) return null;
    return { hash, shortHash: hash.slice(0, 8), subject, date, author };
  } catch { return null; }
}

async function scanProjectMarkers(root) {
  const counts = {};
  const findings = [];
  const budget = { files: 0, chars: 0 };
  const pattern = /(?:\/\/|#|\/\*|\*|<!--)[^\n]*?\b(TODO|FIXME|BUG)\b/i;

  async function walk(dir, depth) {
    if (depth > 8 || budget.files >= 3500 || budget.chars >= 12 * 1024 * 1024) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget.files >= 3500 || budget.chars >= 12 * 1024 * 1024) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || PROJECT_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      const ext = path.extname(entry.name).toLowerCase();
      if (!PROJECT_TEXT_EXTS.has(ext)) continue;
      budget.files++;
      try {
        const stat = await fsp.stat(full);
        if (stat.size > 512 * 1024) continue;
        const content = await fsp.readFile(full, "utf8");
        budget.chars += content.length;
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          const match = line.match(pattern);
          if (!match) continue;
          const kind = match[1].toUpperCase();
          counts[kind] = (counts[kind] || 0) + 1;
          if (findings.length < 60) findings.push({ kind, file: path.relative(root, full).replaceAll("\\", "/"), line: index + 1, text: line.trim().slice(0, 240) });
        }
      } catch { /* unreadable file */ }
    }
  }
  await walk(root, 0);
  return { counts, findings, scannedFiles: budget.files, truncated: budget.files >= 3500 || budget.chars >= 12 * 1024 * 1024 };
}

async function getProjectSummary(entry) {
  const dir = path.join(PROJECTS_ROOT, entry.name);
  const [stat, version, description, lastCommit, markers] = await Promise.all([
    fsp.stat(dir).catch(() => ({ mtimeMs: 0 })),
    readProjectVersion(dir), readProjectDescription(dir), readGitInfo(dir), scanProjectMarkers(dir),
  ]);
  return {
    slug: entry.name,
    name: entry.name.replace(/[-_]+/g, " "),
    path: `Projects/${entry.name}`,
    description,
    version,
    lastCommit,
    bugMarkers: Object.values(markers.counts).reduce((sum, count) => sum + count, 0),
    markerCounts: markers.counts,
    markerFindings: markers.findings,
    scannedFiles: markers.scannedFiles,
    scanTruncated: markers.truncated,
    modified: stat.mtimeMs,
  };
}

app.get("/api/projects", async (_req, res) => {
  try {
    await fsp.mkdir(PROJECTS_ROOT, { recursive: true });
    const entries = await fsp.readdir(PROJECTS_ROOT, { withFileTypes: true });
    const projects = await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("." )).map(getProjectSummary));
    projects.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
    res.json({ projects, scannedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Skills library: source is read-only; installs are copied into AIAccess/Skills
// and never execute bundled scripts automatically.
// ---------------------------------------------------------------------------
const SKILL_GROUPS = new Set(["installed", "custom"]);
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const MAX_SKILL_FILE = 2 * 1024 * 1024;
const MAX_SKILL_COPY = 20 * 1024 * 1024;

function skillSummary(markdown, fallbackName) {
  const frontmatter = (markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/m) || [])[1] || "";
  const name = (frontmatter.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || fallbackName;
  const description = (frontmatter.match(/^description:\s*(.+)$/m) || [])[1]?.trim()
    || (markdown.match(/^#\s+(.+)$/m) || [])[1]?.trim()
    || "No description provided";
  return { name, description: description.replace(/^['"]|['"]$/g, "").slice(0, 300) };
}

async function listSkillsUnder(root, group) {
  let dirs = [];
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const found = [];
  for (const entry of dirs) {
    if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name)) continue;
    const skillFile = path.join(root, entry.name, "SKILL.md");
    try {
      const stat = await fsp.lstat(skillFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_FILE) continue;
      const markdown = await fsp.readFile(skillFile, "utf8");
      found.push({ slug: entry.name, group, ...skillSummary(markdown, entry.name), bytes: stat.size });
    } catch { /* not a valid installable skill */ }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

app.get("/api/skills", async (_req, res) => {
  try {
    const [installed, libraryInstalled, custom] = await Promise.all([
      listSkillsUnder(SKILL_INSTALL_ROOT, "project"),
      listSkillsUnder(path.join(SKILL_LIBRARY_ROOT, "installed"), "installed"),
      listSkillsUnder(path.join(SKILL_LIBRARY_ROOT, "custom"), "custom"),
    ]);
    const installedNames = new Set(installed.map((skill) => skill.slug.toLowerCase()));
    const available = [...libraryInstalled, ...custom].filter((skill) => !installedNames.has(skill.slug.toLowerCase()));
    res.json({ installed, available });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sendSkillMarkdown(res, base, name, group) {
  if (!name || !SKILL_NAME_RE.test(name)) return res.status(400).json({ error: "Invalid skill path" });
  const skillDir = path.resolve(base, name);
  if (!pathInside(skillDir, base)) return res.status(400).json({ error: "Invalid skill path" });
  try {
    const skillFile = path.join(skillDir, "SKILL.md");
    const stat = await fsp.lstat(skillFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return res.status(400).json({ error: "Skill instructions must be a regular file" });
    if (stat.size > MAX_SKILL_FILE) return res.status(413).json({ error: "Skill instructions exceed the read limit" });
    const content = await fsp.readFile(skillFile, "utf8");
    res.json({ slug: name, group, ...skillSummary(content, name), content });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
}

app.get("/api/skills/installed/:slug", (req, res) => sendSkillMarkdown(res, SKILL_INSTALL_ROOT, req.params.slug, "project"));
app.get("/api/skills/library/:group/:slug", (req, res) => {
  const { group, slug } = req.params;
  if (!SKILL_GROUPS.has(group)) return res.status(400).json({ error: "Invalid skill source" });
  return sendSkillMarkdown(res, path.join(SKILL_LIBRARY_ROOT, group), slug, group);
});

async function copySkillTree(source, target, budget) {
  const entries = await fsp.readdir(source, { withFileTypes: true });
  await fsp.mkdir(target, { recursive: true });
  for (const entry of entries) {
    if ([".git", "node_modules", "__pycache__"].includes(entry.name.toLowerCase())) continue;
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await copySkillTree(src, dst, budget);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fsp.stat(src);
    budget.bytes += stat.size;
    budget.files++;
    if (budget.bytes > MAX_SKILL_COPY || budget.files > 300) throw new Error("Skill package exceeds safe install limits");
    await fsp.copyFile(src, dst);
  }
}

app.post("/api/skills/install", async (req, res) => {
  const { group, slug } = req.body || {};
  if (!SKILL_GROUPS.has(group) || !SKILL_NAME_RE.test(String(slug || ""))) {
    return res.status(400).json({ error: "Choose a valid skill from the library" });
  }
  const source = path.resolve(SKILL_LIBRARY_ROOT, group, slug);
  const target = path.resolve(SKILL_INSTALL_ROOT, slug);
  if (!pathInside(source, path.join(SKILL_LIBRARY_ROOT, group)) || !pathInside(target, SKILL_INSTALL_ROOT)) {
    return res.status(400).json({ error: "Invalid skill path" });
  }
  let createdTarget = false;
  try {
    const sourceStat = await fsp.lstat(path.join(source, "SKILL.md"));
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return res.status(400).json({ error: "Skill has no safe SKILL.md instructions" });
    try {
      await fsp.access(target);
      return res.status(409).json({ error: "Skill is already installed in this project" });
    } catch { /* target is new */ }
    await fsp.mkdir(SKILL_INSTALL_ROOT, { recursive: true });
    await fsp.mkdir(target, { recursive: false });
    createdTarget = true;
    const budget = { bytes: 0, files: 0 };
    await copySkillTree(source, target, budget);
    res.status(201).json({ ok: true, slug, files: budget.files, bytes: budget.bytes });
  } catch (err) {
    if (createdTarget) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// OS overview: folder layout + agent roster from the reference configs
// ---------------------------------------------------------------------------
function formatDirListing(dir, depth, maxDepth) {
  try {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    const lines = [];
    for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const pad = "  ".repeat(depth);
      if (d.isDirectory()) {
        lines.push(`${pad}[dir] ${d.name}/`);
        if (depth < maxDepth) lines.push(...formatDirListing(path.join(dir, d.name), depth + 1, maxDepth));
      } else {
        lines.push(`${pad}${d.name}`);
      }
    }
    return lines;
  } catch {
    return ["  (unreadable)"];
  }
}

function readAgentRoster() {
  // Read from the Vault/Notes/agents.md file which contains the current agent roster
  const agentsFile = path.join(AIACCESS_ROOT, "Vault", "Notes", "agents.md");
  try {
    if (fs.existsSync(agentsFile)) {
      return fs.readFileSync(agentsFile, "utf8");
    }
    // Fallback to reference config if Vault file doesn't exist
    const agentsDir = path.join(REFERENCE_ROOT, "config", "agents");
    return fs
      .readdirSync(agentsDir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => {
        const text = fs.readFileSync(path.join(agentsDir, f), "utf8");
        const name = (text.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
        const desc = (text.match(/^description:\s*(.+)$/m) || [])[1]?.trim();
        return `- ${name || f.replace(".yaml", "")}: ${desc || "(specialist agent)"}`;
      })
      .join("\n");
  } catch {
    return "(roster unavailable)";
  }
}

app.get("/api/overview", (_req, res) => {
  const vault = path.join(AIACCESS_ROOT, "Vault");
  const overview = [
    "=== AGENTIC OS KNOWLEDGE (auto-loaded each session) ===",
    "",
    "LAYOUT:",
    "C:\\AIAssistant — project root",
    "C:\\AIAssistant\\AgenticOS — the OS source code (React chat UI in src/, model proxy in server/index.js, agent definitions in src/agents/)",
    "C:\\AIAssistant\\AIAccess — agent-readable content and projects: Vault/, Calendar/events.json, Skills/, Projects/",
    "",
    "VAULT CONTENTS:",
    ...formatDirListing(vault, 0, 2),
    "",
    "SKILLS:",
    ...formatDirListing(path.join(AIACCESS_ROOT, "Skills"), 0, 2),
    "",
    "PROJECTS:",
    ...formatDirListing(path.join(AIACCESS_ROOT, "Projects"), 0, 2),
    "The Projects tab scans each direct project folder for declared version metadata, the latest Git commit, and TODO/FIXME/BUG markers. Marker counts are heuristic indicators, not confirmed bugs.",
    "",
    "CALENDAR:",
    "Events are stored persistently in AIAccess/Calendar/events.json and accessed through the Calendar UI or Zazu's CALENDAR/REMIND tools.",
    "",
    "UI TABS (the user's interface; you can switch tabs with [[NAVIGATE: tab]]):",
    "- chat — conversation with you and the specialists.",
    "- agents — agent roster, per-agent model/skill configuration.",
    "- health — model health dashboard: every model Agentic OS can reach (OpenRouter, opencode Zen, Hermes/Nous Portal, Ollama), provider key status, rate-limit cooldowns, live usage activity, and a \"Sync free models\" button that re-fetches each provider's free-model catalog. If the user asks which models exist, which are free vs paid, or why a model failed, point them here or summarize it.",
    "- routines — scheduled tasks you execute automatically in the background (with or without browser open). Each routine has a name, a self-contained prompt, a schedule (daily or monthly on a chosen day, with any set of hours), an agent (you or a specialist), and an enable toggle. You run routines with your full tool loop and can delegate to specialists; every run is briefed and logged to Vault/Logs/Routines. When the user asks for a recurring task in chat (\"every morning do X\", \"monthly on the 1st do Y\"), CREATE it directly with the [[ROUTINE: description]] tool — do not just point them at the tab. The user can also add or edit routines by hand on that tab, or use its \"Ask Zazu\" button to have a draft opened in the editor for review.",
    "- vault — the Vault document store (Notes, Reports, Logs, Learning, Images).",
    "- calendar — calendar and reminders.",
    "- skills — skill library: browse C:\\AIAccess skills and assign installed skills to agents. Skills are instruction packs (e.g. web-search, pdf, code-review) that are loaded into an assigned agent's prompt to make it better at that kind of work — they are knowledge, not extra tools. Scout ships with the web-search skill by default; you can suggest the user assign more skills on the Skills tab when a task matches one (e.g. \"there's a pdf skill that would help here\").",
    "The Skills tab shows two groups: the read-only library at C:\\AIAccess\\Skills and what is installed into this project (C:\\AIAssistant\\AIAccess\\Skills). Installing a skill copies it into the project; assigning it to an agent makes that agent use it. The web-search skill teaches efficient web searching (good queries, picking primary sources/JSON APIs, saving results into the Vault) — recommend it for any research-heavy task.",
    "- projects — project dashboard with versions, git commits, and TODO/FIXME/BUG markers.",
    "",
    "SPECIALIST AGENT ROSTER (for delegation planning):",
    readAgentRoster(),
  ].join("\n");
  res.json({ overview });
});

// ---------------------------------------------------------------------------
// Memory (learning): Zazu persists durable facts to the vault and reloads them
// ---------------------------------------------------------------------------
app.get("/api/memory", (_req, res) => {
  try {
    res.json({ memory: fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, "utf8") : "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/learn", (req, res) => {
  const { note } = req.body || {};
  if (!note || !String(note).trim()) return res.status(400).json({ error: "note is required" });
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    const entry = `- [${new Date().toISOString().slice(0, 16).replace("T", " ")}] ${String(note).trim()}\n`;
    fs.appendFileSync(MEMORY_FILE, entry, "utf8");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Calendar events (persisted as user content under AIAccess/Calendar)
// ---------------------------------------------------------------------------
async function readCalendarEvents() {
  try {
    const parsed = JSON.parse(await fsp.readFile(CALENDAR_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function saveCalendarEvents(events) {
  await fsp.mkdir(path.dirname(CALENDAR_FILE), { recursive: true });
  const temporary = `${CALENDAR_FILE}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(events, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, CALENDAR_FILE);
}

app.get("/api/calendar/events", async (req, res) => {
  try {
    let events = await readCalendarEvents();
    const from = Date.parse(req.query.from || "");
    const to = Date.parse(req.query.to || "");
    if (Number.isFinite(from)) events = events.filter((e) => Date.parse(e.endAt || e.startAt) >= from);
    if (Number.isFinite(to)) events = events.filter((e) => Date.parse(e.startAt) <= to);
    events.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/calendar/events", async (req, res) => {
  const { title, description = "", startAt, endAt = "", remindAt = "", allDay = false, source = "calendar" } = req.body || {};
  const cleanTitle = String(title || "").trim();
  const start = Date.parse(startAt || "");
  const end = endAt ? Date.parse(endAt) : NaN;
  const reminder = remindAt ? Date.parse(remindAt) : NaN;
  if (!cleanTitle) return res.status(400).json({ error: "Event title is required" });
  if (!Number.isFinite(start)) return res.status(400).json({ error: "A valid start time is required" });
  if (endAt && (!Number.isFinite(end) || end < start)) return res.status(400).json({ error: "End time must be after the start time" });
  if (remindAt && !Number.isFinite(reminder)) return res.status(400).json({ error: "Reminder time is invalid" });
  try {
    const events = await readCalendarEvents();
    const event = {
      id: randomUUID(),
      title: cleanTitle.slice(0, 200),
      description: String(description).slice(0, 4000),
      startAt: new Date(start).toISOString(),
      endAt: Number.isFinite(end) ? new Date(end).toISOString() : "",
      remindAt: Number.isFinite(reminder) ? new Date(reminder).toISOString() : "",
      allDay: Boolean(allDay),
      source: String(source).slice(0, 40),
      createdAt: new Date().toISOString(),
    };
    events.push(event);
    await saveCalendarEvents(events);
    res.status(201).json({ event });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/calendar/events/:id", async (req, res) => {
  const { title, description = "", startAt, endAt = "", remindAt = "", allDay = false } = req.body || {};
  const cleanTitle = String(title || "").trim();
  const start = Date.parse(startAt || "");
  const end = endAt ? Date.parse(endAt) : NaN;
  const reminder = remindAt ? Date.parse(remindAt) : NaN;
  if (!cleanTitle || !Number.isFinite(start)) return res.status(400).json({ error: "A title and valid start time are required" });
  if (endAt && (!Number.isFinite(end) || end < start)) return res.status(400).json({ error: "End time must be after the start time" });
  if (remindAt && !Number.isFinite(reminder)) return res.status(400).json({ error: "Reminder time is invalid" });
  try {
    const events = await readCalendarEvents();
    const index = events.findIndex((e) => e.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: "Event not found" });
    events[index] = {
      ...events[index],
      title: cleanTitle.slice(0, 200),
      description: String(description).slice(0, 4000),
      startAt: new Date(start).toISOString(),
      endAt: Number.isFinite(end) ? new Date(end).toISOString() : "",
      remindAt: Number.isFinite(reminder) ? new Date(reminder).toISOString() : "",
      allDay: Boolean(allDay),
      updatedAt: new Date().toISOString(),
    };
    await saveCalendarEvents(events);
    res.json({ event: events[index] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/calendar/events/:id", async (req, res) => {
  try {
    const events = await readCalendarEvents();
    const next = events.filter((e) => e.id !== req.params.id);
    if (next.length === events.length) return res.status(404).json({ error: "Event not found" });
    await saveCalendarEvents(next);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Zazu's voice: proxy to the local Kokoro service (browser can't call it
// cross-origin). Defaults come from the reference config/voice.yaml:
// engine kokoro, voice bm_george, speed 1.15, max 600 spoken chars.
// ---------------------------------------------------------------------------
async function voiceService(path, opts = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${VOICE_SERVICE}${path}`, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/voice/health", async (_req, res) => {
  try {
    const r = await voiceService("/health");
    const data = await r.json();
    res.json({ ok: Boolean(data.ok), engine: KOKORO_CONFIG.engine, voice: KOKORO_CONFIG.voice, speed: KOKORO_CONFIG.speed, service: data });
  } catch {
    res.json({ ok: false, engine: KOKORO_CONFIG.engine, voice: KOKORO_CONFIG.voice, speed: KOKORO_CONFIG.speed, reason: "voice service not running on port 8765" });
  }
});

app.post("/api/voice/synthesize", async (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "text is required" });
  // Same trim rule as the reference voice config
  const trimmed = String(text).slice(0, KOKORO_CONFIG.max_spoken_chars);
  try {
    const r = await voiceService("/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed }),
    }, 60000);
    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ error: `voice service ${r.status}: ${errText.slice(0, 200)}` });
    }
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-cache");
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    res.status(502).json({ error: `voice service unreachable: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Cloudflare Workers AI text-to-image models. API calls use account credentials
// loaded only by the local proxy; generated files are written to Vault/Images.
// ---------------------------------------------------------------------------
const IMAGE_MODELS = [
  {
    id: "flux-2-klein-4b",
    label: "FLUX.2 Klein 4B",
    provider: "cloudflare",
    model: "@cf/black-forest-labs/flux-2-klein-4b",
    note: "fast generation · Cloudflare Workers AI usage applies",
    multipart: true,
    timeout_s: 180,
  },
  {
    id: "flux-2-klein-9b",
    label: "FLUX.2 Klein 9B",
    provider: "cloudflare",
    model: "@cf/black-forest-labs/flux-2-klein-9b",
    note: "quality + speed · Cloudflare Workers AI usage applies",
    multipart: true,
    timeout_s: 180,
  },
  {
    id: "cloudflare/flux-2-dev",
    label: "FLUX.2 Dev",
    provider: "cloudflare",
    model: "@cf/black-forest-labs/flux-2-dev",
    note: "high detail · Cloudflare Workers AI usage applies",
    multipart: true,
    timeout_s: 240,
  },
  {
    id: "flux-1-schnell",
    label: "FLUX.1 Schnell",
    provider: "cloudflare",
    model: "@cf/black-forest-labs/flux-1-schnell",
    note: "fast classic model · Cloudflare Workers AI usage applies",
    multipart: false,
    timeout_s: 120,
  },
  {
    id: "stable-diffusion-xl-lightning",
    label: "Stable Diffusion XL Lightning",
    provider: "cloudflare",
    model: "@cf/bytedance/stable-diffusion-xl-lightning",
    note: "fast SDXL generation · Cloudflare Workers AI usage applies",
    multipart: false,
    timeout_s: 120,
  },
  {
    id: "stable-diffusion-xl-base-1.0",
    label: "Stable Diffusion XL Base",
    provider: "cloudflare",
    model: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    note: "general-purpose SDXL · Cloudflare Workers AI usage applies",
    multipart: false,
    timeout_s: 180,
  },
  {
    id: "dreamshaper-8-lcm",
    label: "DreamShaper 8 LCM",
    provider: "cloudflare",
    model: "@cf/lykon/dreamshaper-8-lcm",
    note: "stylized and photorealistic · Cloudflare Workers AI usage applies",
    multipart: false,
    timeout_s: 120,
  },
  {
    id: "lucid-origin",
    label: "Lucid Origin",
    provider: "cloudflare",
    model: "@cf/leonardo/lucid-origin",
    note: "strong prompt adherence · Cloudflare Workers AI usage applies",
    multipart: false,
    timeout_s: 180,
  },
  {
    id: "phoenix-1.0",
    label: "Phoenix 1.0",
    provider: "cloudflare",
    model: "@cf/leonardo/phoenix-1.0",
    note: "detailed creative images · Cloudflare Workers AI usage applies",
    multipart: false,
    timeout_s: 180,
  },
];

app.get("/api/image/models", (_req, res) => {
  const configured = Boolean(CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN);
  res.json({
    models: IMAGE_MODELS.map((m) => ({ ...m, available: configured })),
    configured,
    keys: { CLOUDFLARE_ACCOUNT_ID: Boolean(CLOUDFLARE_ACCOUNT_ID), CLOUDFLARE_API_TOKEN: Boolean(CLOUDFLARE_API_TOKEN) },
    source: "Cloudflare Workers AI",
  });
});

app.post("/api/image/generate", async (req, res) => {
  const { modelId, prompt, width = 1024, height = 1024 } = req.body || {};
  const model = IMAGE_MODELS.find((item) => item.id === modelId);
  const cleanPrompt = String(prompt || "").trim();
  const w = Number(width);
  const h = Number(height);
  if (!model) return res.status(400).json({ error: "Choose a supported Cloudflare image model" });
  if (!cleanPrompt) return res.status(400).json({ error: "Image prompt is required" });
  if (cleanPrompt.length > 4000) return res.status(400).json({ error: "Prompt must be 4000 characters or less" });
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 256 || h < 256 || w > 1920 || h > 1920) {
    return res.status(400).json({ error: "Image dimensions must be integers between 256 and 1920 pixels" });
  }
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    return res.status(503).json({ error: "Cloudflare Workers AI is not configured. Check the project server's Cloudflare credentials." });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), model.timeout_s * 1000);
  try {
    // Model IDs are allow-listed constants. Preserve their slash separators:
    // Cloudflare's REST route is /ai/run/@cf/provider/model (not one encoded path segment).
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(CLOUDFLARE_ACCOUNT_ID)}/ai/run/${model.model}`;
    const headers = { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` };
    let body;
    if (model.multipart) {
      body = new FormData();
      body.set("prompt", cleanPrompt);
      body.set("width", String(w));
      body.set("height", String(h));
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ prompt: cleanPrompt, width: w, height: h });
    }

    const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!response.ok) {
      const message = (await response.text()).slice(0, 1200);
      console.error(`Cloudflare image model ${model.id} returned HTTP ${response.status}: ${message}`);
      throw new Error(`Cloudflare ${response.status}: ${message}`);
    }

    const contentType = response.headers.get("content-type") || "";
    let imageBuffer;
    let imageType = contentType;
    if (contentType.startsWith("image/")) {
      imageBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      const data = await response.json();
      const encoded = data?.result?.image || data?.image || data?.result?.output;
      if (typeof encoded !== "string") throw new Error(data?.errors?.[0]?.message || "Cloudflare returned no image data");
      const base64 = encoded.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
      imageBuffer = Buffer.from(base64, "base64");
      imageType = "image/png";
    }
    if (!imageBuffer?.length || imageBuffer.length > 30 * 1024 * 1024) throw new Error("Generated image is empty or exceeds 30 MB");

    const extension = /jpe?g/i.test(imageType) ? "jpg" : /webp/i.test(imageType) ? "webp" : "png";
    const filename = `artist-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
    const relativePath = `Vault/Images/${filename}`;
    const output = path.join(AIACCESS_ROOT, "Vault", "Images", filename);
    await fsp.mkdir(path.dirname(output), { recursive: true });
    await fsp.writeFile(output, imageBuffer);
    res.json({ ok: true, modelId: model.id, model: model.label, path: relativePath, bytes: imageBuffer.length });
  } catch (err) {
    console.error(`Cloudflare image generation failed for ${model.id}:`, err.message);
    res.status(502).json({ error: `Image generation failed: ${err.message}` });
  } finally {
    clearTimeout(timer);
  }
});

const PORT = process.env.PORT || 5175;

// ---------------------------------------------------------------------------
// Routines: scheduled tasks Zazu runs (or delegates) automatically.
// Stored in AIAccess/Routines/routines.json; run logs go to Vault/Logs/Routines.
// ---------------------------------------------------------------------------
import { ZAZU, FUTURE_AGENTS, TOOL_RE, WRITE_RE, DELEGATE_RE, DETAILS_RE } from "../src/agents/zazu.js";

const ROUTINES_FILE = path.join(AIACCESS_ROOT, "Routines", "routines.json");
const ROUTINE_LOGS_DIR = path.join(AIACCESS_ROOT, "Vault", "Logs", "Routines");
const SELF_BASE = `http://127.0.0.1:${PORT}`;
const ROUTINE_MAX_STEPS = 8;

function loadRoutines() {
  try {
    const data = JSON.parse(fs.readFileSync(ROUTINES_FILE, "utf8"));
    return { routines: Array.isArray(data.routines) ? data.routines : [], runs: Array.isArray(data.runs) ? data.runs : [] };
  } catch {
    return { routines: [], runs: [] };
  }
}

function saveRoutines(data) {
  fs.mkdirSync(path.dirname(ROUTINES_FILE), { recursive: true });
  fs.writeFileSync(ROUTINES_FILE, JSON.stringify(data, null, 2));
}

// Next due timestamp for a schedule: { type: "daily"|"monthly", hours: [0-23], minute, dayOfMonth }
function computeNextRun(schedule, from = Date.now()) {
  const hours = (Array.isArray(schedule.hours) && schedule.hours.length ? schedule.hours : [9])
    .map((h) => Math.min(Math.max(Math.round(h), 0), 23))
    .sort((a, b) => a - b);
  const minute = Number.isFinite(schedule.minute) ? Math.min(Math.max(Math.round(schedule.minute), 0), 59) : 0;
  const start = new Date(from);
  for (let day = 0; day < 62; day++) {
    const base = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day);
    if (schedule.type === "monthly") {
      const dom = Math.min(Math.max(Math.round(schedule.dayOfMonth || 1), 1), 28);
      if (base.getDate() !== dom) continue;
    }
    for (const h of hours) {
      const t = new Date(base);
      t.setHours(h, minute, 0, 0);
      if (t.getTime() > from) return t.getTime();
    }
  }
  return from + 86400000;
}

function describeSchedule(s) {
  const hours = (Array.isArray(s.hours) && s.hours.length ? s.hours : [9]).map((h) => `${String(h).padStart(2, "0")}:${String(Number.isFinite(s.minute) ? Math.round(s.minute) : 0).padStart(2, "0")}`);
  const when = hours.join(", ");
  return s.type === "monthly" ? `Monthly on the ${s.dayOfMonth || 1}th at ${when}` : `Daily at ${when}`;
}

// One model turn through this server's own /api/chat (SSE), text accumulated
async function routineChat(messages, { model = null, fallbackChain = "default" } = {}, signal) {
  const res = await fetch(`${SELF_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(model ? { model } : {}), messages, stream: true, fallbackChain, max_tokens: 1600 }),
    signal,
  });
  if (!res.ok) throw new Error(`chat failed ${res.status}`);
  const text = await res.text();
  let out = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const p = JSON.parse(payload);
      if (p.type === "delta" && p.content) out += p.content;
    } catch { /* ignore */ }
  }
  return out.trim();
}

// Execute one agent tool tag against this server's own API
async function runRoutineTool(tool, arg, writeBody = "", agent = "zazu") {
  const a = String(arg || "").trim();
  try {
    switch (tool.toUpperCase()) {
      case "LIST": {
        const d = await (await fetch(`${SELF_BASE}/api/fs/list?path=${encodeURIComponent(a)}`)).json();
        if (d.error) return `LIST ERROR: ${d.error}`;
        return d.entries.map((e) => `${e.type === "dir" ? "[dir] " : ""}${e.name}`).join("\n").slice(0, 3000) || "(empty)";
      }
      case "READ": {
        const d = await (await fetch(`${SELF_BASE}/api/fs/read?path=${encodeURIComponent(a)}`)).json();
        if (d.error) return `READ ERROR: ${d.error}`;
        return (d.content || "").slice(0, 8000) + (d.truncated ? "\n…(truncated)" : "");
      }
      case "WRITE": {
        const r = await fetch(`${SELF_BASE}/api/fs/write`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: a, content: writeBody, agent }),
        });
        const d = await r.json();
        return d.ok ? `Wrote ${d.path} (${d.bytes} bytes)` : `WRITE ERROR: ${d.error || r.status}`;
      }
      case "SYNC": {
        const r = await fetch(`${SELF_BASE}/api/models/sync`, { method: "POST" });
        const d = await r.json();
        if (!d.ok) return `SYNC ERROR: ${d.error || r.status}`;
        return Object.entries(d.providers || {})
          .map(([p, v]) => v.ok ? `${p}: ${v.total} free models (+${v.added.length} added, -${v.removed.length} removed)` : `${p}: SYNC FAILED — ${v.error}`)
          .join("\n");
      }
      case "LEARN": {
        await fetch(`${SELF_BASE}/api/learn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: a }) });
        return `Learned: ${a}`;
      }
      case "SEARCH": {
        const d = await (await fetch(`${SELF_BASE}/api/web/search?q=${encodeURIComponent(a)}`)).json();
        if (d.error) return `SEARCH ERROR: ${d.error}`;
        return JSON.stringify(d.results, null, 1).slice(0, 4000);
      }
      case "FETCH": {
        const d = await (await fetch(`${SELF_BASE}/api/web/fetch?url=${encodeURIComponent(a)}`)).json();
        if (d.error) return `FETCH ERROR: ${d.error}`;
        return `${d.title || a}\n${(d.content || "").slice(0, 6000)}`;
      }
      case "CALENDAR": {
        const d = await (await fetch(`${SELF_BASE}/api/calendar/events`)).json();
        return JSON.stringify(d.events, null, 1).slice(0, 3000);
      }
      case "PROJECTS": {
        const d = await (await fetch(`${SELF_BASE}/api/projects`)).json();
        return JSON.stringify(d.projects, null, 1).slice(0, 4000);
      }
      case "ASK":
        return "AUTOMATED RUN: no user is available to answer. Proceed with your best judgment and state any assumptions in the briefing.";
      case "NAVIGATE":
        return "AUTOMATED RUN: the UI cannot switch tabs. Continue.";
      case "ROUTINE": {
        const r = await fetch(`${SELF_BASE}/api/routines/create-from-description`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description: a }),
        });
        const d = await r.json();
        return d.ok ? d.summary : `ROUTINE ERROR: ${d.error || r.status}`;
      }
      case "IMAGE":
        return "AUTOMATED RUN: image generation is not available in routine runs. Describe what you would have generated in the briefing instead.";
      default:
        return `TOOL ERROR: unknown tool ${tool}`;
    }
  } catch (err) {
    return `TOOL ERROR: ${err.message}`;
  }
}

// Mini agent loop mirroring the browser's Zazu panel: one tool/delegation tag
// per turn, result fed back, until a turn with no tags or the step budget.
async function routineAgentLoop(agentId, task, extraSystem = "", signal) {
  const profile = agentId === "zazu"
    ? { ...ZAZU, status: "ready", tools: ["LIST", "READ", "WRITE", "LEARN", "SEARCH", "FETCH", "CALENDAR", "PROJECTS", "ROUTINE", "SYNC"] }
    : FUTURE_AGENTS.find((a) => a.id === agentId) || { ...ZAZU };
  let system = profile.system || "You are a helpful agent.";
  if (agentId !== "zazu") {
    system += profile.status === "ready"
      ? `\n\nYour available tool names are: ${(profile.tools || []).join(", ")}. Use only these tools. Emit only that single tag (WRITE uses [[WRITE: path]], complete contents, [[/WRITE]]). Keep the final response concise and state clearly what was completed.`
      : "\n\nThis profile is chat-only. Give advice or a draft only.";
  }
  system += `\n\nAUTOMATED SCHEDULED RUN: no user is watching. Do not use [[ASK]]; decide and proceed. Skip [[NAVIGATE]]. Finish with your normal briefing format ("**Brief:**" first).`;
  if (extraSystem) system += "\n\n" + extraSystem;

  let memory = "";
  try { memory = fs.readFileSync(MEMORY_FILE, "utf8"); } catch { /* none */ }
  if (agentId === "zazu" && memory) system += "\n\n--- MEMORY (facts you learned) ---\n" + memory.slice(0, 6000);
  system += loadAgentSkillsForRun(agentId);
  system += `\n\nCURRENT LOCAL DATE/TIME: ${new Date().toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`;

  let history = [
    { role: "system", content: system },
    { role: "user", content: task },
  ];
  let lastTurn = "";
  for (let step = 0; step < ROUTINE_MAX_STEPS; step++) {
    const turn = await routineChat(history, {}, signal);
    lastTurn = turn;
    if (!turn) break;

    // Delegation: run the specialist's own loop, then feed the result back
    const delegation = agentId === "zazu" ? [...turn.matchAll(DELEGATE_RE)][0] : null;
    if (delegation) {
      const requested = delegation[1].trim();
      const delegateTask = delegation[2].trim();
      const specialist = FUTURE_AGENTS.find((a) =>
        a.id.toLowerCase() === requested.toLowerCase() || a.name.toLowerCase() === requested.toLowerCase());
      let result;
      if (specialist && specialist.status === "ready") {
        try {
          result = await routineAgentLoop(specialist.id, delegateTask, "", signal);
        } catch (err) {
          result = `DELEGATION FAILED: ${err.message}`;
        }
      } else {
        result = `${requested} is not executable in automated runs.`;
      }
      history = [
        ...history,
        { role: "assistant", content: turn },
        { role: "user", content: `SPECIALIST RESULT (${requested}):\n${String(result).slice(0, 6000)}\n\nContinue: run the next single tool tag, or deliver your final briefing.` },
      ];
      continue;
    }

    const writeMatch = turn.match(WRITE_RE);
    const toolMatch = turn.match(TOOL_RE);
    if (!toolMatch) break; // final briefing

    const result = await runRoutineTool(toolMatch[1], toolMatch[2], writeMatch?.[2] || "", agentId);
    history = [
      ...history,
      { role: "assistant", content: turn },
      { role: "user", content: `TOOL RESULT (${toolMatch[1]}: ${toolMatch[2].trim()}):\n${result.slice(0, 6000)}\n\nContinue. Either run the next single tool tag, or deliver one concise final briefing.` },
    ];
  }
  // Strip agent tags from the final text for storage
  return (lastTurn || "").replace(DELEGATE_RE, "").replace(WRITE_RE, "").replace(TOOL_RE, "").split(DETAILS_RE)[0].trim();
}

// Skills assigned to an agent for background runs. The browser keeps
// assignments in localStorage; the server falls back to sensible defaults
// (Scout ships with web-search). Reads SKILL.md from the installed library.
const SERVER_SKILL_DEFAULTS = { scout: ["web-search"] };

function loadAgentSkillsForRun(agentId, budget = 20000) {
  const slugs = SERVER_SKILL_DEFAULTS[agentId] || [];
  const loaded = [];
  for (const slug of slugs) {
    if (budget <= 0) break;
    try {
      const file = path.join(SKILL_INSTALL_ROOT, slug, "SKILL.md");
      const text = fs.readFileSync(file, "utf8").slice(0, Math.min(10000, budget));
      budget -= text.length;
      loaded.push(`### Skill: ${slug}\n(Tool names in this OS: [[SEARCH: query]] = web_search, [[FETCH: url]] = web_fetch.)\n${text}`);
    } catch { /* skill missing — skip */ }
  }
  return loaded.length ? "\n\n--- SKILLS ---\n" + loaded.join("\n\n") : "";
}

const runningRoutines = new Set();

async function executeRoutine(routine, trigger = "schedule") {
  if (runningRoutines.has(routine.id)) return;
  runningRoutines.add(routine.id);
  const startedAt = new Date().toISOString();
  const run = { id: randomUUID(), routineId: routine.id, name: routine.name, trigger, startedAt, status: "running", model: null };
  const data = loadRoutines();
  data.runs.unshift(run);
  data.runs = data.runs.slice(0, 200);
  saveRoutines(data);

  try {
    const output = await routineAgentLoop(
      routine.agent || "zazu",
      `Scheduled routine "${routine.name}" (trigger: ${trigger}).\n\n${routine.prompt}`,
    );
    run.status = "ok";
    run.output = output.slice(0, 20000);
    // Persist a readable log into the Vault so agents and the Vault tab can read it
    try {
      fs.mkdirSync(ROUTINE_LOGS_DIR, { recursive: true });
      const stamp = startedAt.replace(/[:.]/g, "-").slice(0, 19);
      const safeName = String(routine.name).replace(/[^\w-]+/g, "_").slice(0, 40) || "routine";
      const logPath = path.join(ROUTINE_LOGS_DIR, `${stamp}_${safeName}.md`);
      fs.writeFileSync(logPath, `# Routine: ${routine.name}\n\n- Run: ${startedAt} (${trigger})\n- Schedule: ${describeSchedule(routine.schedule || {})}\n\n${output}\n`);
      run.logFile = logPath;
    } catch { /* log write is best-effort */ }
  } catch (err) {
    run.status = "error";
    run.error = String(err.message || err).slice(0, 500);
  } finally {
    run.finishedAt = new Date().toISOString();
    runningRoutines.delete(routine.id);
    const d2 = loadRoutines();
    const routine2 = d2.routines.find((r) => r.id === routine.id);
    if (routine2) { routine2.lastRun = run.finishedAt; routine2.lastStatus = run.status; }
    const idx = d2.runs.findIndex((r) => r.id === run.id);
    if (idx !== -1) d2.runs[idx] = run; else d2.runs.unshift(run);
    d2.runs = d2.runs.slice(0, 200);
    saveRoutines(d2);
  }
}

// Scheduler tick: run every enabled routine whose nextRunAt has passed
function tickRoutines() {
  const data = loadRoutines();
  let changed = false;
  for (const routine of data.routines) {
    if (!routine.enabled) continue;
    if (!Number.isFinite(routine.nextRunAt)) {
      routine.nextRunAt = computeNextRun(routine.schedule || {});
      changed = true;
      continue;
    }
    if (routine.nextRunAt <= Date.now() && !runningRoutines.has(routine.id)) {
      routine.nextRunAt = computeNextRun(routine.schedule || {});
      changed = true;
      executeRoutine(routine, "schedule").catch((err) => console.error(`Routine ${routine.name} failed:`, err.message));
    }
  }
  if (changed) saveRoutines(data);
}

// Endpoints ---------------------------------------------------------------
app.get("/api/routines", (_req, res) => {
  const data = loadRoutines();
  res.json({
    routines: data.routines,
    runs: data.runs.slice(0, 40),
    running: [...runningRoutines],
    serverNow: Date.now(),
  });
});

// Build a routine draft from a plain-language description (one model call)
async function buildRoutineDraft(description) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const system = `You translate the user's plain-language description into ONE JSON routine object. Respond with ONLY a fenced json code block containing:
{"name": "short name", "prompt": "the exact instruction Zazu should execute on each run (self-contained, includes what to produce and where to save results)", "schedule": {"type": "daily"|"monthly", "hours": [0-23...], "minute": 0-59, "dayOfMonth": 1-28}, "agent": "zazu"|"coder"|"scriber"|"scout"|"artist"}
Rules: hours are 24h server-local time (timezone: ${tz}). "monthly" requires dayOfMonth; "daily" ignores it. The prompt must be a complete standalone instruction — assume Zazu starts fresh with no conversation context. If the time is ambiguous, pick the most sensible default. No commentary outside the json block.
Write permissions: only Coder (AgenticOS code, Projects) and Scriber (Vault/Notes, Reports, Logs, Learning) and Scout (Vault/Learning, Reports, Search) may save files. Zazu itself CANNOT write files — so if the routine must save a report or note into the Vault, the prompt must instruct Zazu to delegate the save with [DELEGATE: Scriber — save the following report to <path>: <content guidance>]. Keep the JSON valid.`;
  const reply = await routineChat([
    { role: "system", content: system },
    { role: "user", content: description },
  ]);
  const match = reply.match(/```json\s*([\s\S]*?)```/i) || reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Zazu did not return a routine. Try describing it differently.");
  const spec = JSON.parse(match[1].replace(/^```json\s*|```\s*$/g, ""));
  return {
    name: String(spec.name || "New routine").trim().slice(0, 80),
    prompt: String(spec.prompt || description).trim(),
    schedule: {
      type: spec.schedule?.type === "monthly" ? "monthly" : "daily",
      hours: Array.isArray(spec.schedule?.hours) ? spec.schedule.hours : [9],
      minute: Number.isFinite(spec.schedule?.minute) ? spec.schedule.minute : 0,
      dayOfMonth: spec.schedule?.dayOfMonth || 1,
    },
    agent: FUTURE_AGENTS.some((a) => a.id === spec.agent) ? spec.agent : "zazu",
    enabled: true,
  };
}

// Validate + insert a routine record (shared by the API and Zazu's ROUTINE tool)
function createRoutineRecord(spec) {
  const { name, prompt, schedule, agent, enabled = true } = spec || {};
  if (!String(name || "").trim()) throw new Error("Name is required");
  if (!String(prompt || "").trim()) throw new Error("Prompt is required");
  const type = schedule?.type === "monthly" ? "monthly" : "daily";
  if (type === "daily" && (!Array.isArray(schedule?.hours) || schedule.hours.length === 0)) {
    throw new Error("Pick at least one hour");
  }
  const routine = {
    id: randomUUID(),
    name: String(name).trim().slice(0, 80),
    prompt: String(prompt).trim(),
    schedule: {
      type,
      hours: (schedule.hours || [9]).map((h) => Math.min(Math.max(Math.round(Number(h) || 0), 0), 23)),
      minute: Number.isFinite(schedule?.minute) ? Math.min(Math.max(Math.round(schedule.minute), 0), 59) : 0,
      dayOfMonth: Math.min(Math.max(Math.round(Number(schedule?.dayOfMonth) || 1), 1), 28),
    },
    agent: FUTURE_AGENTS.some((a) => a.id === agent) ? agent : "zazu",
    enabled: Boolean(enabled),
    createdAt: new Date().toISOString(),
    lastRun: null,
    lastStatus: null,
    nextRunAt: computeNextRun({ type, hours: schedule?.hours, minute: schedule?.minute, dayOfMonth: schedule?.dayOfMonth }),
  };
  const data = loadRoutines();
  data.routines.push(routine);
  saveRoutines(data);
  return routine;
}

app.post("/api/routines", (req, res) => {
  try {
    const routine = createRoutineRecord(req.body || {});
    res.json({ ok: true, routine });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/routines/:id", (req, res) => {
  const data = loadRoutines();
  const routine = data.routines.find((r) => r.id === req.params.id);
  if (!routine) return res.status(404).json({ error: "Routine not found" });
  const b = req.body || {};
  if (typeof b.enabled === "boolean") routine.enabled = b.enabled;
  if (typeof b.name === "string" && b.name.trim()) routine.name = b.name.trim().slice(0, 80);
  if (typeof b.prompt === "string" && b.prompt.trim()) routine.prompt = b.prompt.trim();
  if (b.agent && FUTURE_AGENTS.some((a) => a.id === b.agent)) routine.agent = b.agent;
  if (b.schedule && typeof b.schedule === "object") {
    const s = { ...routine.schedule, ...b.schedule };
    s.type = s.type === "monthly" ? "monthly" : "daily";
    s.hours = Array.isArray(s.hours) ? s.hours.map((h) => Math.min(Math.max(Math.round(Number(h) || 0), 0), 23)) : [9];
    routine.schedule = s;
  }
  routine.nextRunAt = computeNextRun(routine.schedule);
  saveRoutines(data);
  res.json({ ok: true, routine });
});

app.delete("/api/routines/:id", (req, res) => {
  const data = loadRoutines();
  const before = data.routines.length;
  data.routines = data.routines.filter((r) => r.id !== req.params.id);
  if (data.routines.length === before) return res.status(404).json({ error: "Routine not found" });
  data.runs = data.runs.filter((r) => r.routineId !== req.params.id);
  saveRoutines(data);
  res.json({ ok: true });
});

app.post("/api/routines/:id/run", (req, res) => {
  const data = loadRoutines();
  const routine = data.routines.find((r) => r.id === req.params.id);
  if (!routine) return res.status(404).json({ error: "Routine not found" });
  if (runningRoutines.has(routine.id)) return res.status(409).json({ error: "Routine is already running" });
  executeRoutine(routine, "manual").catch((err) => console.error(`Routine ${routine.name} failed:`, err.message));
  res.json({ ok: true, started: true });
});

// Zazu builds a routine from a plain-language description
app.post("/api/routines/assist", async (req, res) => {
  const description = String(req.body?.description || "").trim();
  if (!description) return res.status(400).json({ error: "Describe the routine first" });
  try {
    res.json({ ok: true, draft: await buildRoutineDraft(description) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Create a routine straight from a plain-language description (Zazu's ROUTINE tool)
app.post("/api/routines/create-from-description", async (req, res) => {
  const description = String(req.body?.description || "").trim();
  if (!description) return res.status(400).json({ error: "Describe the routine first" });
  try {
    const draft = await buildRoutineDraft(description);
    const routine = createRoutineRecord(draft);
    const summary = `Created routine "${routine.name}" — ${describeSchedule(routine.schedule)}, agent: ${routine.agent}, first run ${new Date(routine.nextRunAt).toLocaleString()}`;
    res.json({ ok: true, routine, summary });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Scheduler: tick every 20 seconds, also on startup
setInterval(tickRoutines, 20000);
setTimeout(tickRoutines, 3000);

const server = app.listen(PORT, LOCAL_HOST, () => {
  console.log(`Model proxy server on http://${LOCAL_HOST}:${PORT}`);
  console.log(`OpenRouter configured: ${Boolean(OPENROUTER_KEY)}`);
});

export { server };
