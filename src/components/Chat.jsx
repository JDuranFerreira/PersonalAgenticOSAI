/* ==========================================================================
   Agentic OS — Chat
   Milestone 1: full chat interface with streaming, approvals, attachments,
   speech-to-text, text-to-speech, status indicator, searchable history.
   Now backed by real AI models (OpenRouter cloud + Ollama local) via the
   local model proxy server.
 ========================================================================== */
import { useState, useEffect, useRef, useCallback } from "react";
import { speak, stopTts, isTtsSupported, getVoices } from "../utils/tts";
import { startListening, stopListening, isSttSupported } from "../utils/stt";
import { streamChat, fetchModels } from "../utils/api";
import { prepareAttachment } from "../utils/attachments";
import Message from "./Message";
import MessageInput from "./MessageInput";
import StatusIndicator from "./StatusIndicator";
import ApprovalPrompt from "./ApprovalPrompt";
import ConversationHistory from "./ConversationHistory";
import ModelSelector from "./ModelSelector";
import ResizeHandle from "./ResizeHandle";
import { useResizableWidth } from "../utils/useResizableWidth";
import { Mic, MicOff, Speaker, VolumeOff, SquareStop, RefreshCw } from "lucide-react";

const STORAGE_KEY = "agentic_os_conversations";

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

export default function Chat() {
  // Resizable left sidebar (drag its right edge)
  const sidePanel = useResizableWidth({
    storageKey: "agentic_os_width_chat_sidebar",
    defaultValue: 252,
    min: 190,
    max: 420,
    side: "right",
  });
  // ---------- Model state ----------
  const [selectedModel, setSelectedModel] = useState("openrouter/nvidia/nemotron-3.5-super-vl:free");
  const [modelsLoaded, setModelsLoaded] = useState(false);

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
  const [ttsEnabled, setTtsEnabled] = useState(true);
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
  useEffect(() => {
    fetchModels()
      .then(() => setModelsLoaded(true))
      .catch((err) => {
        console.warn("Failed to load models from proxy:", err.message);
        setModelsLoaded(true);
      });
  }, []);

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
          setConversations(valid);
          setActiveId(valid[0].id);
          setMessages(valid[0].messages);
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
        messages: persistableMessages(messages),
        preview: messages[messages.length - 1]?.content?.slice(0, 60) || "",
      };
    }));
  }, [activeId, messages]);

  useEffect(() => {
    if (!conversations.length) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch (error) {
      console.warn("Conversation history could not be saved:", error.message);
    }
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
      setConversations([{ id: nid, title: "New conversation", preview: "", messages: [], createdAt: Date.now() }]);
      setActiveId(nid);
      setMessages([]);
    } else {
      setConversations(next);
      if (id === activeId) {
        setActiveId(next[0].id);
        setMessages(next[0].messages || []);
      }
    }
    setIsStreaming(false);
    setCurrentApproval(null);
    setStatus("idle");
  }

  function loadConversation(id) {
    cancelActiveRequest();
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    setActiveId(id);
    setMessages(conv.messages);
    setInputValue("");
    setIsStopped(false);
    setCurrentApproval(null);
    setStatus("idle");
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

  // ---------- Build message history for the AI ----------
  // `extra` carries messages that are not yet in state (setMessages is async,
  // so the closure's `messages` is stale right after addMessage()).
  function buildHistory(extra = []) {
    const hist = [];
    // System prompt: clean formatting + the [ACTION:] approval convention
    hist.push({
      role: "system",
      content:
        "You are the Agentic OS assistant, running inside a futuristic local chat interface. " +
        "Always reply in clean, well-structured Markdown: short paragraphs, headings when useful, " +
        "bullet lists, and fenced code blocks with a language tag for any code. Keep replies focused " +
        "and readable. This chat has no action-execution tools; never claim to have changed files, sent messages, or performed external work. " +
        "If you need consent before continuing, include a tag on its own line like [ACTION: short description] and wait. " +
        "Approval only permits a further conversation turn; it does not cause an action to run.",
    });
    for (const m of messages) {
      if (m.role === "user") {
        hist.push({ role: "user", content: m.modelContent || m.content });
      } else if (m.role === "agent") {
        hist.push({ role: "assistant", content: m.content });
      }
    }
    hist.push(...extra);
    return hist;
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
    addMessage("user", displayText, {
      attachments: attachments.map(({ name, type, size, previewUrl }) => ({ name, type, size, previewUrl })),
      modelContent,
    });
    const assistantMessage = addMessage("agent", "", { streaming: true });
    const controller = new AbortController();
    requestControllerRef.current = controller;
    let streamedContent = "";
    const history = buildHistory([{ role: "user", content: modelContent }]);

    // Stream the AI response
    try {
      const generator = streamChat({
        model: selectedModel,
        messages: history,
        temperature: 0.7,
        signal: controller.signal,
      });

      const rendered = await typeWriter(
        (content) => {
          streamedContent = content;
          updateMessage(assistantMessage.id, { content, streaming: true });
        },
        generator
      );

      // Check for action request
      const actionMatch = rendered.match(ACTION_RE);
      if (actionMatch) {
        const description = actionMatch[1].trim();
        setStatus("waiting");
        setIsStreaming(false);
        updateMessage(assistantMessage.id, {
          content: rendered.replace(ACTION_RE, "").trim() || "I need your approval to continue.",
          streaming: false,
        });
        setCurrentApproval({ description });
        return;
      }

      // No action — finalize
      updateMessage(assistantMessage.id, { streaming: false });
      setIsStreaming(false);
      setStatus("idle");

      // TTS read-aloud
      if (ttsEnabled && isTtsSupported()) {
        setStatus("speaking");
        const plain = rendered.replace(/```[\s\S]*?```/g, "").replace(/[*#`_~]/g, "").trim();
        ttsUtteranceRef.current = speak(plain, { rate: 1, voicePref: voice || undefined });
        ttsUtteranceRef.current.onend = () => setStatus((current) => current === "speaking" ? "idle" : current);
      }
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
      ? "The user approved continuing with the request. Remember: this chat has no action-execution tools. Do not claim that an external action was completed; explain what can actually be done next."
      : "The user rejected continuing with that request. Acknowledge the rejection and do not proceed with it.";
    const assistantMessage = addMessage("agent", "", { streaming: true });
    const controller = new AbortController();
    requestControllerRef.current = controller;
    try {
      const generator = streamChat({
        model: selectedModel,
        messages: [...buildHistory(), { role: "user", content: decision }],
        signal: controller.signal,
      });
      const rendered = await typeWriter(
        (content) => updateMessage(assistantMessage.id, { content, streaming: true }),
        generator,
      );
      updateMessage(assistantMessage.id, { streaming: false });
      setIsStreaming(false);
      setStatus("idle");
      if (approved && ttsEnabled && isTtsSupported()) speak(rendered, { rate: 1, voicePref: voice || undefined });
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
    }
  }

  // ---------- TTS ----------
  function toggleTts() {
    setTtsEnabled((prev) => {
      const next = !prev;
      if (!next) stopTts();
      return next;
    });
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
          <div style={{ marginBottom: 16 }}>
            {modelsLoaded ? (
              <ModelSelector value={selectedModel} onChange={setSelectedModel} />
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
        <StatusIndicator status={isListening ? "listening" : status} />

        <div className="chat-area" ref={messagesEndRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              <span className="empty-icon">&#128187;</span>
              <h2 style={{ color: "var(--text-muted)" }}>Ready. Send a message.</h2>
              <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
                Try asking for code, a file operation, or just say hello.
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
              Agent is typing…
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
