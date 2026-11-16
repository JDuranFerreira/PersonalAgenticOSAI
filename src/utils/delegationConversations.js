const CONVERSATIONS_KEY = "agentic_os_conversations";
export const CONVERSATIONS_UPDATED_EVENT = "agentic_os_conversations_updated";

function readConversations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONVERSATIONS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeConversations(conversations, conversationId, focus = false) {
  try {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
    window.dispatchEvent(new CustomEvent(CONVERSATIONS_UPDATED_EVENT, {
      detail: { conversationId, focus },
    }));
    return true;
  } catch {
    return false;
  }
}

export function createDelegationConversation({ delegationId, agentId, agentName, model, task }) {
  const now = Date.now();
  const compactTask = String(task || "Specialist task").replace(/\s+/g, " ").trim();
  const titleTask = compactTask.length > 42 ? `${compactTask.slice(0, 39)}…` : compactTask;
  const conversationId = crypto.randomUUID();
  const conversation = {
    id: conversationId,
    title: `${agentName}: ${titleTask}`,
    preview: `Delegated by Zazu · ${compactTask.slice(0, 60)}`,
    createdAt: now,
    updatedAt: now,
    agentId,
    model,
    delegationId,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        content: `Task from Zazu:\n${task}`,
        timestamp: now,
      },
      {
        id: crypto.randomUUID(),
        role: "agent",
        author: agentName,
        content: `${agentName} is starting the task…`,
        thinking: "**Progress**\n\n- Preparing the delegated task",
        streaming: true,
        timestamp: now,
      },
    ],
  };
  const conversations = readConversations();
  conversations.unshift(conversation);
  return writeConversations(conversations, conversationId, true) ? conversationId : null;
}

export function updateDelegationConversation({ delegationId, activity, status = "running", result }) {
  const conversations = readConversations();
  const index = conversations.findIndex((conversation) => conversation.delegationId === delegationId);
  if (index < 0) return false;

  const conversation = conversations[index];
  const messages = [...(conversation.messages || [])];
  const assistantIndex = messages.findLastIndex?.((message) => message.role === "agent")
    ?? messages.map((message) => message.role).lastIndexOf("agent");
  if (assistantIndex < 0) return false;

  const current = messages[assistantIndex];
  const progress = current.thinking || "**Progress**";
  const nextProgress = activity
    ? `${progress}\n- ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${activity}`
    : progress;
  const isFinished = status !== "running";
  messages[assistantIndex] = {
    ...current,
    content: isFinished
      ? (result || (status === "done" ? "Task completed." : status === "stopped" ? "Task stopped." : "Task failed."))
      : `${current.author || "Agent"} is working: ${activity || "continuing the task…"}`,
    thinking: nextProgress,
    streaming: !isFinished,
    timestamp: Date.now(),
  };

  conversations[index] = {
    ...conversation,
    messages,
    preview: messages[assistantIndex].content.slice(0, 100),
    updatedAt: Date.now(),
    delegationStatus: status,
  };
  return writeConversations(conversations, conversation.id, false);
}
