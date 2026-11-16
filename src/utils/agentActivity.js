/* ==========================================================================
   Agentic OS — Agent activity bus
   Tiny event channel so the Agents tab roster can show which agents are
   actually busy (streaming in Chat / the Zazu panel / running routines)
   instead of a hardcoded "idle" dot.
   ========================================================================== */

export const AGENT_ACTIVITY_EVENT = "agentic_os_agent_activity";

// busy=true when the agent starts a streaming turn/task, false when done.
// source: "chat" | "panel" | "specialist" — purely informational.
export function setAgentBusy(agentId, busy, source = "chat") {
  try {
    window.dispatchEvent(new CustomEvent(AGENT_ACTIVITY_EVENT, {
      detail: { agentId, busy: Boolean(busy), source },
    }));
  } catch { /* never break streaming over an event dispatch */ }
}
