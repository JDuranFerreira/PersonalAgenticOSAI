/* ==========================================================================
   Agentic OS — Chat
   Milestone 1: full chat interface with streaming, approvals, attachments,
   speech-to-text, text-to-speech, status indicator, searchable history.
   Now backed by real AI models (OpenRouter cloud + Ollama local) via the
   local model proxy server.
 ========================================================================== */
import { useState, useEffect, useRef, useCallback } from "react";
import { speak, speakKokoro, stopTts, isTtsSupported, getVoices } from "../utils/tts";
import { startListening, stopListening, isSttSupported } from "../utils/stt";
import {
  streamChat, fetchModels, readSkill, fsList, fsRead, fsWrite, bashShell, webSearch, webFetch,
  fetchProjects, learnNote, calendarList, calendarCreate, createRoutineFromDescription,
  syncFreeModels, generateCloudImage, fsRawUrl, MODELS, fetchModelCatalog, onCatalogInvalidated,
  ragQuery,
} from "../utils/api";
import { prepareAttachment } from "../utils/attachments";
import Message from "./Message";
import MessageInput from "./MessageInput";
import StatusIndicator from "./StatusIndicator";
import ApprovalPrompt from "./ApprovalPrompt";
import ConversationHistory from "./ConversationHistory";
import ModelSelector from "./ModelSelector";
import { ZAZU, FUTURE_AGENTS, TOOL_RE, WRITE_RE, DELEGATE_RE, ZAZU_FAST_MODELS, ZAZU_LOCAL_MODELS } from "../agents/zazu";
import { loadAgentSettings, saveAgentSettings, SETTINGS_EVENT } from "../agents/settings";
import { CONVERSATIONS_UPDATED_EVENT } from "../utils/delegationConversations";
import { VAULT_OPEN_EVENT, VAULT_PENDING_KEY } from "../utils/vaultEvents";
import { setAgentBusy } from "../utils/agentActivity";
import ResizeHandle from "./ResizeHandle";
import { useResizableWidth } from "../utils/useResizableWidth";
import { Mic, MicOff, Speaker, VolumeOff, SquareStop, RefreshCw } from "lucide-react";

const STORAGE_KEY = "agentic_os_conversations";
const ACTIVE_AGENT_KEY = "agentic_os_chat_agent";
const CHAT_TOOL_LIMIT = 35;
const MAX_CHAT_TOOL_RESULT = 4000;
// Window the transcript sent to the model: unbounded history eventually
// breaks the provider's context limit and slows every turn.
const MAX_HISTORY_MESSAGES = 30;
const ZAZU_CHAT_TOOLS = ["LIST", "READ", "ASK", "LEARN", "RECALL", "NAVIGATE", "CALENDAR", "REMIND", "PROJECTS", "ROUTINE", "SYNC", "BASH"];
const CHAT_VALID_TABS = ["chat", "agents", "health", "routines", "vault", "calendar", "skills", "projects", "security"];
const NAVIGATE_EVENT = "agentic_os_navigate";

function validAgentId(id) {
  return id === "zazu" || FUTURE_AGENTS.some((agent) => agent.id === id);
}

function getSavedAgentId() {
  try {
    const id = localStorage.getItem(ACTIVE_AGENT_KEY);
    return validAgentId(id) ? id : "zazu";
  } catch {
    return "zazu";
  }
}

// Detect an action request in the agent's text: "[ACTION: description]"
const ACTION_RE = /\[ACTION:\s*([^\]]+)\]/i;

function composeModelContent(text, attachments) {
  const attachmentText = attachments
    .filter((attachment) => attachment.modelText)
    .map((attachment) => `\n\n[Attachment: ${attachment.name}]\n${attachment.modelText}`)
    .join("");
  const prompt = `${text || "Please inspect the attached file(s)."}${attachmentText}`;
  const images = attachments.map((attachment) => attachment.imagePart).filter(Boolean);
  return images.length ? [{ type: "text", text: prompt }, ...images] : prompt;
}

function persistableMessages(messages) {
  return messages.map((message) => {
    const { modelContent, attachments, ...plainMessage } = message;
    const durableModelContent = typeof modelContent === "string"
      ? modelContent
      : Array.isArray(modelContent)
        ? modelContent.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
        : undefined;
    return {
      ...plainMessage,
      ...(durableModelContent ? { modelContent: durableModelContent } : {}),
      attachments: attachments?.map(({ name, type, size }) => ({ name, type, size })),
    };
  });
}

function titleFromMessage(text) {
  const compact = String(text || "New conversation").replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 45)}…` : compact || "New conversation";
}

// Plain text of a message's model-facing content (a multipart array when
// images are attached) — safe for RAG queries and history rebuilds.
function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
  return "";
}

// Compact transcript entry for the collapsible working log
function compactTurn(text) {
  const t = stripToolTags(text);
  return t.length > 400 ? `${t.slice(0, 400)}…` : t;
}

// Remove tool tags from displayed text; tool results live in the working log.
function stripToolTags(text) {
  return String(text || "").replace(WRITE_RE, "").replace(TOOL_RE, "").trim();
}

export default function Chat() {
  // Resizable left sidebar (drag its right edge)
  const sidePanel = useResizableWidth({
    storageKey: "agentic_os_width_chat_sidebar",
    defaultValue: 252,
    min: 190,
    max: 420,
    side: "right",
  });
  const [selectedAgentId, setSelectedAgentId] = useState(getSavedAgentId);
  const [agentSettings, setAgentSettings] = useState(() => loadAgentSettings(getSavedAgentId()));
  // ---------- Model state ----------
  const [selectedModel, setSelectedModel] = useState(() => loadAgentSettings(getSavedAgentId()).model);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelList, setModelList] = useState(MODELS);

  // ---------- Conversation / history state ----------
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  // ---------- Active message state ----------
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [status, setStatus] = useState("idle");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStopped, setIsStopped] = useState(false);
  const [currentApproval, setCurrentApproval] = useState(null);
  const [ttsEnabled, setTtsEnabled] = useState(() => Boolean(loadAgentSettings(getSavedAgentId()).voice));
  const [voice, setVoice] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [voiceError, setVoiceError] = useState(null);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState(null);
  const [isPreparingAttachments, setIsPreparingAttachments] = useState(false);

  // ---------- Refs for controllable streaming ----------
  const streamRef = useRef({ active: false, stopped: false, paused: false, resume: null });
  const requestControllerRef = useRef(null);
  const ttsUtteranceRef = useRef(null);
  const recognitionRef = useRef(null);
  const messagesEndRef = useRef(null);
  const autoScrollRef = useRef(true);
  const activeIdRef = useRef(null);

  useEffect(() => {
    if (!isTtsSupported()) return undefined;
    const updateVoice = () => {
      const available = getVoices();
      if (!voice && available.length) setVoice(available[0].name);
    };
    updateVoice();
    window.speechSynthesis.onvoiceschanged = updateVoice;
    return () => {
      if (window.speechSynthesis.onvoiceschanged === updateVoice) window.speechSynthesis.onvoiceschanged = null;
    };
  }, [voice]);

  // ---------- Load available models from proxy ----------
  // Stores the actual catalog (synced free models included) for the dropdown,
  // and re-fetches whenever syncFreeModels() invalidates it.
  useEffect(() => {
    let alive = true;
    const load = () => fetchModelCatalog()
      .then((catalog) => {
        if (!alive) return;
        setModelList(catalog.entries.length ? catalog.entries : MODELS);
        setModelsLoaded(true);
      })
      .catch((err) => {
        console.warn("Failed to load models from proxy:", err.message);
        setModelsLoaded(true);
      });
    load();
    const off = onCatalogInvalidated(load);
    return () => { alive = false; off(); };
  }, []);

  // ---------- Model fallback ----------
  // If the selected model is no longer in the catalog (e.g. a sync removed a
  // free model), switch to the best still-available model instead of leaving
  // a dead entry that would fail every request.
  useEffect(() => {
    if (!modelList.length || modelList.some((m) => m.id === selectedModel)) return;
    const preferences = [
      agentSettings.fallbackModel,
      ...ZAZU_FAST_MODELS.map((m) => m.id),
      ...ZAZU_LOCAL_MODELS.map((m) => m.id),
    ].filter(Boolean);
    const fallback =
      preferences.map((id) => modelList.find((m) => m.id === id)).find(Boolean) || modelList[0];
    if (!fallback) return;
    setSelectedModel(fallback.id);
    setAgentSettings((prev) => {
      const next = { ...prev, model: fallback.id };
      saveAgentSettings(selectedAgentId, next);
      return next;
    });
  }, [modelList, selectedModel, agentSettings.fallbackModel, selectedAgentId]);

  useEffect(() => {
    const syncDelegatedConversation = (event) => {
      let stored = [];
      try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return; }
      if (!Array.isArray(stored)) return;
      setConversations(stored);
      const updated = stored.find((conversation) => conversation.id === event.detail?.conversationId);
      if (!updated) return;
      if (event.detail?.focus) {
        // Set the ref synchronously so progress events that arrive before the
        // next render still land in the right conversation.
        activeIdRef.current = updated.id;
        const agentId = validAgentId(updated.agentId) ? updated.agentId : "zazu";
        const settings = loadAgentSettings(agentId);
        setActiveId(updated.id);
        setMessages(updated.messages || []);
        setSelectedAgentId(agentId);
        setAgentSettings(settings);
        setSelectedModel(updated.model || settings.model);
        setTtsEnabled(Boolean(settings.voice));
        localStorage.setItem(ACTIVE_AGENT_KEY, agentId);
      } else if (updated.id === activeIdRef.current) {
        setMessages(updated.messages || []);
      }
    };
    window.addEventListener(CONVERSATIONS_UPDATED_EVENT, syncDelegatedConversation);
    return () => window.removeEventListener(CONVERSATIONS_UPDATED_EVENT, syncDelegatedConversation);
  }, []);

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  useEffect(() => {
    const reloadSettings = (event) => {
      if (event.detail?.agentId && event.detail.agentId !== selectedAgentId) return;
      const next = loadAgentSettings(selectedAgentId);
      setAgentSettings(next);
      setSelectedModel(next.model);
      setTtsEnabled(Boolean(next.voice));
      if (!next.voice) stopTts();
    };
    window.addEventListener(SETTINGS_EVENT, reloadSettings);
    return () => window.removeEventListener(SETTINGS_EVENT, reloadSettings);
  }, [selectedAgentId]);

  // ---------- Load history from localStorage (once) ----------
  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        const valid = Array.isArray(data) ? data.filter((conversation) =>
          conversation && typeof conversation.id === "string" && Array.isArray(conversation.messages)
        ) : [];
        if (valid.length) {
          const normalized = valid.map((conversation) => {
            if (!["New conversation", "Welcome"].includes(conversation.title)) return conversation;
            const firstUserMessage = conversation.messages.find((message) => message.role === "user")?.content;
            return firstUserMessage ? { ...conversation, title: titleFromMessage(firstUserMessage) } : conversation;
          });
          setConversations(normalized);
          setActiveId(normalized[0].id);
          setMessages(normalized[0].messages);
          const agentId = validAgentId(normalized[0].agentId) ? normalized[0].agentId : getSavedAgentId();
          const settings = loadAgentSettings(agentId);
          setSelectedAgentId(agentId);
          setAgentSettings(settings);
          setSelectedModel(normalized[0].model || settings.model);
          setTtsEnabled(Boolean(settings.voice));
          localStorage.setItem(ACTIVE_AGENT_KEY, agentId);
          return;
        }
      }
      const id = createConversation("Welcome");
      setActiveId(id);
    } catch (error) {
      console.warn("Failed to load history:", error);
      const id = createConversation("Welcome");
      setActiveId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the active transcript in the conversation record, then persist a
  // metadata-only form so image/PDF payloads never fill localStorage.
  useEffect(() => {
    if (!activeId) return;
    setConversations((prev) => prev.map((conversation) => {
      if (conversation.id !== activeId) return conversation;
      return {
        ...conversation,
        agentId: selectedAgentId,
        model: selectedModel,
        messages: persistableMessages(messages),
        preview: messages[messages.length - 1]?.content?.slice(0, 60) || "",
      };
    }));
  }, [activeId, messages, selectedAgentId, selectedModel]);

  // Persist to localStorage debounced: updateMessage fires per streamed chunk,
  // and stringifying the whole conversation list per chunk caused jank and
  // quota pressure on long histories.
  useEffect(() => {
    if (!conversations.length) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
      } catch (error) {
        console.warn("Conversation history could not be saved:", error.message);
      }
    }, 800);
    return () => clearTimeout(t);
  }, [conversations]);

  // ---------- Scroll to bottom ----------
  const scrollToBottom = useCallback(() => {
    if (autoScrollRef.current) {
      const el = messagesEndRef.current;
      if (el) el.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, []);

  useEffect(() => {
    if (isStreaming) scrollToBottom();
  }, [isStreaming, messages.length, scrollToBottom]);

  // ---------- Conversation helpers ----------
  function createConversation(title) {
    const id = crypto.randomUUID();
    const conv = {
      id,
      title,
      preview: "",
      agentId: selectedAgentId,
      model: selectedModel,
      messages: [],
      createdAt: Date.now(),
    };
    setConversations((prev) => [conv, ...prev]);
    return id;
  }

  function handleDeleteConversation(id) {
    cancelActiveRequest();
    const next = conversations.filter((c) => c.id !== id);
    if (next.length === 0) {
      // Keep at least one conversation
      const nid = crypto.randomUUID();
      setConversations([{ id: nid, title: "New conversation", preview: "", messages: [], agentId: selectedAgentId, model: selectedModel, createdAt: Date.now() }]);
      setActiveId(nid);
      setMessages([]);
    } else {
      setConversations(next);
      if (id === activeId) {
        const replacement = next[0];
        const agentId = validAgentId(replacement.agentId) ? replacement.agentId : selectedAgentId;
        const settings = loadAgentSettings(agentId);
        setActiveId(replacement.id);
        setMessages(replacement.messages || []);
        setSelectedAgentId(agentId);
        setAgentSettings(settings);
        setSelectedModel(replacement.model || settings.model);
        setTtsEnabled(Boolean(settings.voice));
      }
    }
    setIsStreaming(false);
    setCurrentApproval(null);
    setStatus("idle");
  }

  function handleRenameConversation(id, title) {
    const trimmed = String(title || "").trim();
    if (!trimmed) return;
    setConversations((prev) => prev.map((conversation) => conversation.id === id ? { ...conversation, title: trimmed } : conversation));
  }

  function loadConversation(id) {
    cancelActiveRequest();
    stopTts();
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    setActiveId(id);
    setMessages(conv.messages);
    const agentId = validAgentId(conv.agentId) ? conv.agentId : selectedAgentId;
    const settings = loadAgentSettings(agentId);
    setSelectedAgentId(agentId);
    setAgentSettings(settings);
    setSelectedModel(conv.model || settings.model);
    setTtsEnabled(Boolean(settings.voice));
    localStorage.setItem(ACTIVE_AGENT_KEY, agentId);
    setInputValue("");
    setIsStopped(false);
    setCurrentApproval(null);
    setStatus("idle");
  }

  function handleAgentChange(agentId) {
    if (!validAgentId(agentId) || isStreaming || currentApproval) return;
    const settings = loadAgentSettings(agentId);
    setSelectedAgentId(agentId);
    setAgentSettings(settings);
    setSelectedModel(settings.model);
    setTtsEnabled(Boolean(settings.voice));
    stopTts();
    localStorage.setItem(ACTIVE_AGENT_KEY, agentId);
  }

  function handleModelChange(model) {
    setSelectedModel(model);
    const next = { ...agentSettings, model };
    setAgentSettings(next);
    saveAgentSettings(selectedAgentId, next);
  }

  function addMessage(role, content, { thinking, codeBlocks, attachments, modelContent, streaming = false } = {}) {
    const id = crypto.randomUUID();
    const msg = {
      id,
      role,
      content,
      thinking,
      codeBlocks,
      attachments,
      modelContent,
      streaming,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
    return msg;
  }

  function updateMessage(id, updates) {
    setMessages((prev) => prev.map((message) => message.id === id ? { ...message, ...updates } : message));
  }

  // ---------- Streaming core (real AI via proxy) ----------
  async function typeWriter(setter, generator, { onChunk } = {}) {
    const ref = streamRef.current;
    ref.active = true;
    ref.stopped = false;
    let rendered = "";
    try {
      for await (const chunk of generator) {
        if (ref.stopped) break;
        while (ref.paused && !ref.stopped) await new Promise((resolve) => (ref.resume = resolve));
        if (ref.stopped) break;
        rendered += chunk;
        setter(rendered);
        if (onChunk) onChunk(rendered);
      }
      return rendered;
    } finally {
      ref.active = false;
      ref.resume = null;
    }
  }

  function cancelActiveRequest() {
    streamRef.current.stopped = true;
    streamRef.current.resume?.();
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
  }

  function stopStreaming() {
    cancelActiveRequest();
    setIsStopped(true);
    setIsStreaming(false);
    setStatus("stopped");
    setCurrentApproval(null);
    stopTts();
  }

  // ---------- Chat tool execution ----------
  // The selected agent's declared tools run here, scoped exactly as they are
  // in the task panel. Skills and chat never expand a profile's permissions.
  function describeChatTool(tool, arg) {
    if (tool === "LIST") return `Listed ${arg.trim()}`;
    if (tool === "READ") return `Read ${arg.trim()}`;
    if (tool === "ASK") return `Asked: ${arg.trim()}`;
    if (tool === "LEARN") return `Learned: ${arg.trim()}`;
    if (tool === "RECALL") return `Vault recall: ${arg.trim()}`;
    if (tool === "NAVIGATE") return `Navigated to ${arg.trim()} tab`;
    if (tool === "ROUTINE") return `Creating routine: ${arg.trim()}`;
    if (tool === "SYNC") return "Syncing free models";
    if (tool === "WRITE") return `Saved ${arg.trim()}`;
    if (tool === "BASH") return `Ran shell command: ${arg.trim()}`;
    if (tool === "SEARCH") return `Web search: ${arg.trim()}`;
    if (tool === "FETCH") return `Fetched ${arg.trim()}`;
    if (tool === "IMAGE") return "Generated image";
    if (tool === "CALENDAR") return "Checked upcoming calendar";
    if (tool === "PROJECTS") return "Scanned project summaries";
    if (tool === "REMIND") return `Created reminder: ${arg.split("|")[1]?.trim() || arg.trim()}`;
    return `${tool} ${arg}`;
  }

  async function runChatTool(tool, arg, payload = "") {
    const allowed = selectedAgentId === "zazu"
      ? ZAZU_CHAT_TOOLS
      : (FUTURE_AGENTS.find((agent) => agent.id === selectedAgentId)?.tools || []);
    if (!allowed.includes(tool)) {
      return `TOOL ERROR: ${agentSettings.name} is not allowed to use ${tool}. Available tools: ${allowed.join(", ") || "none"}`;
    }
    try {
      if (tool === "LIST") {
        const { path: full, entries } = await fsList(arg);
        const lines = entries
          .slice(0, 200)
          .map((e) => (e.type === "dir" ? `[dir]  ${e.name}/` : `[file] ${e.name}${e.size ? ` (${(e.size / 1024).toFixed(1)} KB)` : ""}`));
        return `${full}\n${entries.length} entr${entries.length === 1 ? "y" : "ies"}\n\n${lines.join("\n")}`;
      }
      if (tool === "READ") {
        const { path: full, content, truncated } = await fsRead(arg);
        return `${full}${truncated ? " (truncated)" : ""}\n\n${content}`;
      }
      if (tool === "ASK") {
        return `Your question was shown to the user in the chat: "${arg.trim()}". End your reply now and wait for the user's next message.`;
      }
      if (tool === "LEARN") {
        await learnNote(arg.trim());
        return `Saved to memory: ${arg.trim()}`;
      }
      if (tool === "RECALL") {
        const hits = await ragQuery(arg.trim(), 5);
        if (!hits.length) return "RECALL: no matching Vault knowledge found.";
        return hits
          .map((h) => `— Vault/${h.path} · ${h.heading}\n${h.text.slice(0, 900)}`)
          .join("\n\n");
      }
      if (tool === "NAVIGATE") {
        const [tabPart, ...rest] = arg.trim().split(":");
        const targetTab = tabPart.trim().toLowerCase();
        if (!CHAT_VALID_TABS.includes(targetTab)) {
          return `Invalid tab: ${targetTab}. Valid tabs: ${CHAT_VALID_TABS.join(", ")}`;
        }
        const filePath = rest.join(":").trim();
        if (targetTab === "vault" && filePath) {
          sessionStorage.setItem(VAULT_PENDING_KEY, filePath);
          window.dispatchEvent(new CustomEvent(VAULT_OPEN_EVENT, { detail: { path: filePath } }));
        }
        window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { tab: targetTab } }));
        return filePath ? `Opened ${filePath} in the Vault` : `Navigated to ${targetTab} tab`;
      }
      if (tool === "ROUTINE") {
        const d = await createRoutineFromDescription(arg.trim());
        return d.summary || `Created routine "${d.routine?.name || ""}"`;
      }
      if (tool === "SYNC") {
        const r = await syncFreeModels();
        return Object.entries(r.providers || {})
          .map(([p, v]) => v.ok ? `${p}: ${v.total} free models (+${v.added.length} added, -${v.removed.length} removed)` : `${p}: SYNC FAILED — ${v.error}`)
          .join("\n");
      }
      if (tool === "WRITE") {
        if (!payload.trim()) return "TOOL ERROR: WRITE requires full file contents followed by [[/WRITE]]";
        const saved = await fsWrite(arg.trim(), payload, selectedAgentId);
        return `Saved ${saved.bytes} bytes to ${saved.path}`;
      }
      if (tool === "BASH") {
        const result = await bashShell(arg.trim(), undefined, selectedAgentId);
        const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        const tail = out.length > 3000 ? `\n…(output truncated at 3000 chars)` : "";
        const status = result.exitCode ? ` (exit code ${result.exitCode})` : "";
        return `Ran \`${arg.trim()}${result.cwd ? ` in ${result.cwd}` : ""}\`${status}\n\n${out}${tail}`;
      }
      if (tool === "SEARCH") {
        const { results } = await webSearch(arg.trim());
        if (!results.length) return `No web results found for: ${arg.trim()}`;
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      }
      if (tool === "FETCH") {
        const page = await webFetch(arg.trim());
        return `${page.title}\n${page.url}\n\n${page.content}`;
      }
      if (tool === "IMAGE") {
        const image = await generateCloudImage({
          modelId: loadAgentSettings("artist").imageModel || "flux-2-klein-9b",
          prompt: arg.trim(),
          width: 1024,
          height: 1024,
        });
        return `Image generated successfully with ${image.model}. Saved to ${image.path}.\n\n![Generated artwork](${fsRawUrl(image.path)})`;
      }
      if (tool === "CALENDAR") {
        const now = Date.now();
        const events = await calendarList({ from: new Date(now).toISOString(), to: new Date(now + 90 * 86400000).toISOString() });
        if (!events.length) return "There are no upcoming calendar events in the next 90 days.";
        return events.slice(0, 50).map((event) =>
          `- ${new Date(event.startAt).toLocaleString()} — ${event.title}${event.description ? ` (${event.description})` : ""}`
        ).join("\n");
      }
      if (tool === "PROJECTS") {
        const projects = await fetchProjects();
        if (!projects.length) return "The AIAccess/Projects folder is empty. Add project folders there; the Projects tab detects them when refreshed.";
        return projects.map((project) => {
          const commit = project.lastCommit
            ? `${project.lastCommit.shortHash} · ${project.lastCommit.subject} · ${new Date(project.lastCommit.date).toLocaleDateString()}`
            : "No Git commit found";
          return `- ${project.name} — version ${project.version}; ${project.bugMarkers} TODO/FIXME/BUG markers; last commit ${commit}`;
        }).join("\n");
      }
      if (tool === "REMIND") {
        const [whenRaw, titleRaw, ...descriptionParts] = arg.split("|");
        const when = Date.parse((whenRaw || "").trim());
        const title = (titleRaw || "").trim();
        if (!Number.isFinite(when) || !title) return "TOOL ERROR: Use [[REMIND: ISO-8601 date-time with timezone | title | optional details]]";
        const event = await calendarCreate({
          title,
          description: descriptionParts.join("|").trim(),
          startAt: new Date(when).toISOString(),
          remindAt: new Date(when).toISOString(),
          source: "zazu",
        });
        return `Reminder created: ${event.title} at ${new Date(event.startAt).toLocaleString()}`;
      }
      return "(unknown tool)";
    } catch (err) {
      return `TOOL ERROR: ${err.message}`;
    }
  }

  // ---------- Build message history for the AI ----------
  // `extra` carries messages that are not yet in state (setMessages is async,
  // so the closure's `messages` is stale right after addMessage()).
  // `ragSourceText` is the just-typed message for the RAG query — passing it
  // explicitly is required for the same staleness reason, otherwise the query
  // would run against the PREVIOUS user message.
  async function buildHistory(extra = [], ragSourceText = null) {
    const profile = selectedAgentId === "zazu" ? ZAZU : FUTURE_AGENTS.find((agent) => agent.id === selectedAgentId);
    const basePrompt = agentSettings.system || profile?.system || `You are ${agentSettings.name}, a helpful tutor and assistant.`;
    const tools = selectedAgentId === "zazu" ? ZAZU_CHAT_TOOLS : (profile?.tools || []);
    const toolPolicy = tools.length
      ? `CHAT TOOLS: This Chat can execute only these tools: ${tools.join(", ")}. Emit at most one tool tag per turn, then stop and wait for its result; you will receive a TOOL RESULT message and another turn. Never claim success before the tool result confirms it. WRITE must use [[WRITE: path]], the complete file contents, then [[/WRITE]]. The server enforces each profile's write scope. ${tools.includes("BASH") ? "BASH runs ONE command in Windows cmd.exe — NOT bash: use dir, type, where, findstr, set; Unix commands (ls, cat, grep, pwd, head, tail) are not recognized and will fail. A failed command returns its exit code and stderr — read them and adjust instead of retrying the same command." : ""} ${selectedAgentId === "zazu" ? "In this Chat, do not emit DELEGATE tags; use your direct tools or tell the user to select a specialist from the Chat as menu." : ""}`
      : "CHAT MODE LIMITS: This profile has no execution tools. Never claim to have changed files or performed external work; answer conversationally or recommend a tool-enabled profile.";
    const skillNotes = [];
    for (const slug of [...new Set(agentSettings.skills || [])].slice(0, 8)) {
      try {
        const skill = await readSkill(slug, "installed");
        skillNotes.push(`### ${skill.name}\n${skill.content.slice(0, 12000)}`);
      } catch {
        // Unavailable skills are omitted; they never grant any tools.
      }
    }
    const skillPrompt = skillNotes.length
      ? `\n\n--- ASSIGNED SKILLS ---\n${skillNotes.join("\n\n")}\n\nSkills are reference knowledge only and do not grant tools or permissions.`
      : "";
    // RAG: auto-retrieve Vault passages relevant to the user's latest message.
    const lastUser = ragSourceText ? null : [...messages].reverse().find((m) => m.role === "user");
    const ragQueryText = String(ragSourceText || (lastUser ? (messageText(lastUser.modelContent) || lastUser.content || "") : "")).trim();
    let ragPrompt = "";
    if (ragQueryText) {
      const q = ragQueryText;
      if (q) {
        try {
          const hits = await ragQuery(q, 4);
          const block = hits.map((h) => `### ${h.heading}  (source: Vault/${h.path})\n${h.text.slice(0, 900)}`).join("\n\n");
          if (block) {
            ragPrompt = `\n\n--- RELEVANT KNOWLEDGE (auto-retrieved from the Vault by semantic search) ---\n${block}\nTreat this as reference context with sources; use [[RECALL]] for deeper searches and [[READ]] to verify anything critical.`;
          }
        } catch {
          // Retrieval is best-effort: never block the turn on it.
        }
      }
    }
    const hist = [];
    hist.push({
      role: "system",
      content:
        `You are ${agentSettings.name}, a ${agentSettings.role} in Agentic OS. Follow this agent profile:\n\n${basePrompt}${skillPrompt}${ragPrompt}\n\n` +
        `${toolPolicy} ` +
        "Never claim to have changed files, sent messages, searched the web, or performed external work unless the relevant tool returned success. " +
        "You are running inside a futuristic local chat interface. " +
        "Always reply in clean, well-structured Markdown: short paragraphs, headings when useful, " +
        "bullet lists, and fenced code blocks with a language tag for any code. Keep replies focused and readable. " +
        "If you need consent before continuing, include a tag on its own line like [ACTION: short description] and wait. " +
        "Approval continues the turn with your scoped tools available; it does not bypass their permission limits.",
    });
    const recent = messages
      .filter((m) => m.role === "user" || m.role === "agent")
      .slice(-MAX_HISTORY_MESSAGES);
    for (const m of recent) {
      if (m.role === "user") {
        hist.push({ role: "user", content: messageText(m.modelContent) || m.content });
      } else if (m.role === "agent") {
        hist.push({ role: "assistant", content: m.content });
      }
    }
    hist.push(...extra);
    return hist;
  }

  // ---------- Tool execution loop ----------
  // Runs scoped tool tags the agent emits, feeding each result back until the
  // agent replies without tools or the in-chat step budget runs out. Tools are
  // the selected agent's own; skills never add permissions.
  async function executeToolTurns({ assistantMessage, initialContent, history, controller, onStreamed }) {
    let content = initialContent;
    const toolSteps = [];
    const toolTurns = []; // compact transcript of intermediate model turns
    const toolHistory = [...history];
    // Repetition guards: free models sometimes parrot the same turn (and the
    // same failing tool call) forever — detect it and break the loop.
    let lastTurnSig = "";
    let turnRepeats = 0;
    let lastToolSig = "";
    const workingLog = () =>
      `**Working**\n\n${toolSteps.map((s) => `- ${s}`).join("\n")}` +
      (toolTurns.length ? `\n\n**Turn transcript**\n\n${toolTurns.join("\n\n")}` : "");

    for (let iteration = 0; iteration < CHAT_TOOL_LIMIT; iteration++) {
      // --- repetition guard: identical consecutive turn = stuck model ---
      const turnSig = content.replace(/\s+/g, " ").trim().toLowerCase();
      if (turnSig === lastTurnSig) {
        turnRepeats++;
      } else {
        turnRepeats = 0;
        lastTurnSig = turnSig;
      }
      if (turnRepeats >= 2) {
        // Parroting a third time: force one final answer with tools forbidden
        // instead of burning the rest of the step budget on the same response.
        toolHistory.push({ role: "assistant", content });
        content = await typeWriter(
          (stepContent) => {
            onStreamed?.(stepContent);
            updateMessage(assistantMessage.id, { content: stripToolTags(stepContent), thinking: workingLog(), streaming: true });
          },
          streamChat({
            model: selectedModel,
            messages: [...toolHistory, { role: "user", content: "STOP: you have repeated the same response without progress. Give your final answer NOW based on what you already have. Do not emit any tool tags." }],
            temperature: 0.3,
            signal: controller.signal,
          }),
        );
        break;
      }
      if (turnRepeats === 1) {
        // Same response twice in a row: skip re-running the tools and tell the
        // model to change course instead of parroting a third time.
        toolHistory.push({ role: "assistant", content });
        toolHistory.push({ role: "user", content: "You just produced the exact same response again. Repeating it will not change the result. Try a different approach, or give your final answer without tool tags now." });
        content = await typeWriter(
          (stepContent) => {
            onStreamed?.(stepContent);
            updateMessage(assistantMessage.id, { content: stripToolTags(stepContent), thinking: workingLog(), streaming: true });
          },
          streamChat({
            model: selectedModel,
            messages: toolHistory,
            temperature: 0.4,
            signal: controller.signal,
          }),
        );
        continue;
      }

      // Delegation is a task-panel feature; Chat declines it cleanly.
      if (content.includes("[DELEGATE:") && !TOOL_RE.test(content)) {
        const cleaned = content.replace(DELEGATE_RE, "").trim();
        content = `${cleaned}\n\nDelegation runs from the Zazu task panel. Pick a specialist there, or select them in the "Chat as" menu to handle it here directly.`;
        break;
      }

      const toolMatch = content.match(TOOL_RE);
      if (!toolMatch) break;

      const writeMatch = content.match(WRITE_RE);
      const [, tool, arg] = toolMatch;
      const toolSig = `${tool}:${arg.replace(/\s+/g, " ").trim().toLowerCase()}`;
      const label = describeChatTool(tool, arg);
      toolSteps.push(label);
      toolTurns.push(compactTurn(content));
      setStatus("working");
      updateMessage(assistantMessage.id, {
        content: stripToolTags(content),
        thinking: workingLog(),
        streaming: true,
      });

      const result = await runChatTool(tool, arg, writeMatch?.[2] || "");
      const repeatWarn = toolSig === lastToolSig
        ? "\n\nNOTE: this is the exact same tool call as last turn. If it failed before, repeating it will not change the result — try a different approach, or give your final answer without tool tags now."
        : "";
      lastToolSig = toolSig;
      toolHistory.push({ role: "assistant", content });
      toolHistory.push({
        role: "user",
        content: `TOOL RESULT (${tool}) — context for you only, do not repeat it verbatim:\n${result.slice(0, MAX_CHAT_TOOL_RESULT)}${repeatWarn}\n\nContinue: use this result, call another tool, or give your final answer without tool tags.`,
      });

      const nextGenerator = streamChat({
        model: selectedModel,
        messages: toolHistory,
        temperature: 0.4,
        signal: controller.signal,
      });
      content = await typeWriter(
        (stepContent) => {
          onStreamed?.(stepContent);
          updateMessage(assistantMessage.id, {
            content: stripToolTags(stepContent),
            thinking: workingLog(),
            streaming: true,
          });
        },
        nextGenerator
      );
    }

    if (TOOL_RE.test(content)) {
      // Step budget reached while the agent still wanted tools: say so.
      content = `${stripToolTags(content)}\n\n_(I reached the in-chat tool-step limit before finishing. Narrow the request or send a follow-up message to continue.)_`;
    }
    return { content, toolSteps, workingLog: workingLog() };
  }

  // ---------- Send user message ----------
  async function handleSend() {
    const text = inputValue.trim();
    const attachments = pendingAttachments;
    if ((!text && !attachments.length) || isStreaming || currentApproval) return;

    setInputValue("");
    setPendingAttachments([]);
    setAttachmentError(null);
    setIsStopped(false);
    setStatus("thinking");
    setIsStreaming(true);

    const labels = attachments.map((attachment) => attachment.name).join(", ");
    const displayText = text || `Please inspect the attached file${attachments.length === 1 ? "" : "s"}: ${labels}`;
    const modelContent = composeModelContent(text, attachments);
    setConversations((prev) => prev.map((conversation) => (
      conversation.id === activeId && ["New conversation", "Welcome"].includes(conversation.title)
        ? { ...conversation, title: titleFromMessage(displayText) }
        : conversation
    )));
    addMessage("user", displayText, {
      attachments: attachments.map(({ name, type, size, previewUrl }) => ({ name, type, size, previewUrl })),
      modelContent,
    });
    const assistantMessage = addMessage("agent", "", { streaming: true, author: agentSettings.name });
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setAgentBusy(selectedAgentId, true, "chat");
    let streamedContent = "";
    // The RAG query must use the message just typed — `messages` state is
    // stale right now (addMessage above hasn't re-rendered yet).
    const ragSource = typeof modelContent === "string" ? modelContent : (modelContent[0]?.text || displayText);
    const history = await buildHistory([{ role: "user", content: modelContent }], ragSource);

    // Stream the AI response
    try {
      const generator = streamChat({
        model: selectedModel,
        messages: history,
        temperature: 0.6,
        signal: controller.signal,
      });

      const rendered = await typeWriter(
        (content) => {
          streamedContent = content;
          updateMessage(assistantMessage.id, { content, streaming: true });
        },
        generator
      );

      // ---------- Tool loop ----------
      // If the agent's reply carries a tool tag, execute it with the agent's
      // scoped tools and give the model the result for its next turn.
      const { content, toolSteps, workingLog } = await executeToolTurns({
        assistantMessage,
        initialContent: rendered,
        history,
        controller,
        onStreamed: (text) => { streamedContent = text; },
      });

      // Check for action request
      const actionMatch = content.match(ACTION_RE);
      if (actionMatch) {
        const description = actionMatch[1].trim();
        setStatus("waiting");
        setIsStreaming(false);
        updateMessage(assistantMessage.id, {
          content: content.replace(ACTION_RE, "").trim() || "I need your approval to continue.",
          streaming: false,
        });
        setCurrentApproval({ description });
        return;
      }

      // No action — finalize
      updateMessage(assistantMessage.id, {
        content: stripToolTags(content),
        thinking: toolSteps.length ? workingLog : undefined,
        streaming: false,
      });
      setIsStreaming(false);
      setStatus("idle");

      // TTS read-aloud
      if (ttsEnabled) await speakAgentText(stripToolTags(content));
    } catch (err) {
      if (controller.signal.aborted || err.name === "AbortError") {
        updateMessage(assistantMessage.id, { streaming: false });
      } else {
        console.error("Stream error:", err);
        const content = streamedContent
          ? `${streamedContent}\n\n[Stream ended: ${err.message}]`
          : `Error: ${err.message}`;
        updateMessage(assistantMessage.id, { content, streaming: false });
        setStatus("idle");
      }
      setIsStreaming(false);
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      setAgentBusy(selectedAgentId, false, "chat");
    }
  }

  // ---------- Approval handling ----------
  function handleApprove() {
    if (!currentApproval) return;
    setCurrentApproval(null);
    void continueAfterDecision(true);
  }

  function handleReject() {
    if (!currentApproval) return;
    setCurrentApproval(null);
    void continueAfterDecision(false);
  }

  async function continueAfterDecision(approved) {
    setStatus("working");
    setIsStreaming(true);
    const decision = approved
      ? "The user approved continuing with the request. Use your available tool tags for any needed actions; each result will come back as a TOOL RESULT message. Never claim an action succeeded before its tool result confirms it."
      : "The user rejected continuing with that request. Acknowledge the rejection and do not proceed with it.";
    const assistantMessage = addMessage("agent", "", { streaming: true, author: agentSettings.name });
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setAgentBusy(selectedAgentId, true, "chat");
    try {
      const history = await buildHistory();
      const generator = streamChat({
        model: selectedModel,
        messages: [...history, { role: "user", content: decision }],
        temperature: 0.6,
        signal: controller.signal,
      });
      const rendered = await typeWriter(
        (content) => updateMessage(assistantMessage.id, { content, streaming: true }),
        generator,
      );
      const { content, toolSteps, workingLog } = await executeToolTurns({
        assistantMessage,
        initialContent: rendered,
        history: [...history, { role: "user", content: decision }],
        controller,
      });
      updateMessage(assistantMessage.id, {
        content: stripToolTags(content),
        thinking: toolSteps.length ? workingLog : undefined,
        streaming: false,
      });
      setIsStreaming(false);
      setStatus("idle");
      if (approved && ttsEnabled) await speakAgentText(stripToolTags(content));
    } catch (error) {
      if (!controller.signal.aborted && error.name !== "AbortError") {
        updateMessage(assistantMessage.id, { content: `Error: ${error.message}`, streaming: false });
        setStatus("idle");
      } else {
        updateMessage(assistantMessage.id, { streaming: false });
      }
      setIsStreaming(false);
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      setAgentBusy(selectedAgentId, false, "chat");
    }
  }

  // ---------- TTS ----------
  function toggleTts() {
    const next = !ttsEnabled;
    setTtsEnabled(next);
    const updated = { ...agentSettings, voice: next };
    setAgentSettings(updated);
    saveAgentSettings(selectedAgentId, updated);
    if (!next) stopTts();
  }

  async function speakAgentText(text) {
    const plain = String(text).replace(/```[\s\S]*?```/g, "").replace(/[*#`_~]/g, "").trim();
    if (!plain) return;
    setStatus("speaking");
    const finish = () => setStatus((current) => current === "speaking" ? "idle" : current);
    if ((agentSettings.ttsEngine || "kokoro") === "kokoro") {
      try {
        ttsUtteranceRef.current = await speakKokoro(plain.slice(0, 600), { onend: finish });
        return;
      } catch {
        // Fall back to the selected browser voice when the local voice service is down.
      }
    }
    if (isTtsSupported()) {
      const utterance = speak(plain.slice(0, 600), { rate: 1.15, voicePref: agentSettings.ttsVoice || voice || undefined });
      ttsUtteranceRef.current = utterance;
      if (utterance) utterance.onend = finish;
      else finish();
    } else {
      finish();
    }
  }

  // ---------- STT ----------
  function toggleListening() {
    if (isListening) {
      stopListening(recognitionRef.current);
      recognitionRef.current = null;
      setIsListening(false);
      setStatus("idle");
      return;
    }
    if (!isSttSupported()) {
      setVoiceError("Speech recognition not supported in this browser.");
      return;
    }
    setStatus("listening");
    setIsListening(true);
    recognitionRef.current = startListening({
      onResult: (text, isFinal) => {
        setInputValue(text);
        if (isFinal) {
          setIsListening(false);
          setStatus("idle");
          recognitionRef.current = null;
        }
      },
      onEnd: () => {
        setIsListening(false);
        setStatus("idle");
        recognitionRef.current = null;
      },
      onError: (err) => {
        setVoiceError(`Speech error: ${err}`);
        setIsListening(false);
        setStatus("idle");
      },
    });
  }

  // ---------- Input handlers ----------
  const handleInputChange = (value) => setInputValue(value);

  // ---------- Attachments ----------
  const handleAttach = async (files) => {
    const incoming = Array.from(files || []);
    if (!incoming.length) return;
    setAttachmentError(null);
    const currentBytes = pendingAttachments.reduce((sum, attachment) => sum + attachment.size, 0);
    const addedBytes = incoming.reduce((sum, file) => sum + file.size, 0);
    if (pendingAttachments.length + incoming.length > 5) {
      setAttachmentError("Attach up to 5 files per message.");
      return;
    }
    if (currentBytes + addedBytes > 8 * 1024 * 1024) {
      setAttachmentError("Combined attachments must be 8 MB or smaller.");
      return;
    }
    setIsPreparingAttachments(true);
    try {
      const prepared = await Promise.all(incoming.map(prepareAttachment));
      setPendingAttachments((current) => [
        ...current,
        ...prepared.map((attachment) => ({ ...attachment, id: crypto.randomUUID() })),
      ]);
    } catch (error) {
      setAttachmentError(error.message || "Could not prepare the attachment.");
    } finally {
      setIsPreparingAttachments(false);
    }
  };

  const removePendingAttachment = (id) => {
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  // ---------- New conversation ----------
  function handleNewConversation() {
    cancelActiveRequest();
    setIsStopped(false);
    setCurrentApproval(null);
    setIsStreaming(false);
    setStatus("idle");
    setMessages([]);
    const id = createConversation("New conversation");
    setActiveId(id);
  }

  return (
    <>
      <aside className="sidebar" style={{ width: sidePanel.width }}>
        <div className="sidebar-header">
          <div className="brand">
            <div className="brand-dot" />
            <h1>Agentic OS</h1>
          </div>
        </div>

        <div className="sidebar-body">
          <section className="chat-agent-control">
            <label htmlFor="chat-agent-select">Chat as</label>
            <select
              id="chat-agent-select"
              className="chat-agent-select"
              value={selectedAgentId}
              onChange={(e) => handleAgentChange(e.target.value)}
              disabled={isStreaming || !!currentApproval}
            >
              <option value="zazu">Zazu · Orchestrator</option>
              {FUTURE_AGENTS.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}
            </select>
            <p className="chat-agent-description">{agentSettings.description}</p>
            <span className="chat-agent-mode">
              {selectedAgentId === "zazu" || (FUTURE_AGENTS.find((agent) => agent.id === selectedAgentId)?.tools?.length || 0) > 0
                ? "Scoped tools run here with this profile's permissions"
                : "Conversation-only profile"}
            </span>
          </section>
          <div className="chat-model-control">
            <div className="sidebar-section-title">Model for {agentSettings.name}</div>
            {modelsLoaded ? (
              <ModelSelector value={selectedModel} onChange={handleModelChange} disabled={isStreaming || !!currentApproval} models={modelList} />
            ) : (
              <div style={{ padding: "10px 14px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                Loading models…
              </div>
            )}
          </div>
          <ConversationHistory
            conversations={conversations}
            activeId={activeId}
            onSelect={loadConversation}
            onDelete={handleDeleteConversation}
            onRename={handleRenameConversation}
            onNew={handleNewConversation}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
          />
        </div>

        <div className="sidebar-footer">
          <button
            className="btn btn-outline"
            onClick={toggleTts}
            title="Toggle text-to-speech"
          >
            {ttsEnabled ? <Speaker size={13} /> : <VolumeOff size={13} />} TTS
          </button>
          <button
            className="btn btn-outline"
            onClick={toggleListening}
            disabled={!isSttSupported()}
            title={isSttSupported() ? "Dictation" : "Speech not supported"}
          >
            {isListening ? <MicOff size={13} fill="#ff00ff" /> : <Mic size={13} />} STT
          </button>
          <button className="btn btn-outline" onClick={handleNewConversation}>
            <RefreshCw size={13} /> New chat
          </button>
        </div>
      </aside>

      <ResizeHandle side="right" onDragStart={sidePanel.startDrag} onReset={sidePanel.reset} />

      <div className="main">
        <div className="chat-mobile-agent-bar">
          <select
            className="chat-agent-select"
            aria-label="Choose chat agent"
            value={selectedAgentId}
            onChange={(e) => handleAgentChange(e.target.value)}
            disabled={isStreaming || !!currentApproval}
          >
            <option value="zazu">Zazu · Orchestrator</option>
            {FUTURE_AGENTS.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}
          </select>
          {modelsLoaded && <ModelSelector value={selectedModel} onChange={handleModelChange} disabled={isStreaming || !!currentApproval} models={modelList} />}
        </div>
        <StatusIndicator status={isListening ? "listening" : status} />

        <div className="chat-area" ref={messagesEndRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              <span className="empty-icon">&#128187;</span>
              <h2 style={{ color: "var(--text-muted)" }}>{selectedAgentId === "tutor" ? "Ready to learn together." : `Chat with ${agentSettings.name}.`}</h2>
              <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
                {selectedAgentId === "tutor"
                  ? "Ask for a Polish lesson, coding help, or a guided explanation of another subject."
                  : selectedAgentId === "zazu"
                    ? "Ask anything here — Zazu's scoped tools run right in this chat."
                    : `${agentSettings.description} This profile's scoped tools run right in this chat.`}
              </p>
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} {...m} />
          ))}
        </div>

        {currentApproval && (
          <ApprovalPrompt
            description={currentApproval.description}
            onApprove={handleApprove}
            onReject={handleReject}
            loading={isStreaming}
          />
        )}

        <MessageInput
          value={inputValue}
          onChange={handleInputChange}
          onSend={handleSend}
          onAttach={handleAttach}
          sending={isStreaming || !!currentApproval || isPreparingAttachments}
          listening={isListening}
          onToggleListening={toggleListening}
          attachments={pendingAttachments}
          onRemoveAttachment={removePendingAttachment}
          attachmentError={attachmentError}
        />

        {!currentApproval && isStreaming && !isStopped && (
          <div style={{ margin: "0 40px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--cyan)", fontSize: "0.78rem" }}>
              <span style={{ display: "inline-block", width: 7, height: 7, background: "var(--cyan)", borderRadius: "50%", animation: "pulse-neon 1.5s infinite" }} />
              {agentSettings.name} is typing…
            </div>
            <button className="btn btn-stop" onClick={stopStreaming} title="Stop the agent">
              <SquareStop size={12} /> Stop
            </button>
          </div>
        )}

        {isStopped && !currentApproval && (
          <div style={{ margin: "0 40px 12px", display: "flex", alignItems: "center", gap: 8, color: "var(--red)", fontSize: "0.78rem" }}>
            <SquareStop size={12} fill="var(--red)" />
            <span>Stopped by user</span>
          </div>
        )}

        {voiceError && (
          <div style={{ margin: "10px 40px", color: "var(--red)", fontSize: "0.8rem", background: "rgba(255,42,42,0.1)", border: "1px solid var(--red)", padding: "8px 12px", borderRadius: 6 }}>
            {voiceError}
          </div>
        )}
      </div>
    </>
  );
}
