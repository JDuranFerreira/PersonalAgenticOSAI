// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createDelegationConversation, updateDelegationConversation } from "../src/utils/delegationConversations.js";

beforeEach(() => localStorage.clear());

describe("delegated task conversations", () => {
  it("creates a titled agent conversation and records progress without raw tool output", () => {
    const conversationId = createDelegationConversation({
      delegationId: "delegate-1",
      agentId: "coder",
      agentName: "Coder",
      model: "openrouter/example",
      task: "Inspect the input system migration and summarize remaining work",
    });

    expect(conversationId).toBeTruthy();
    expect(updateDelegationConversation({
      delegationId: "delegate-1",
      activity: "Reading Assets/Scripts/Input/InputService.cs",
    })).toBe(true);

    const [conversation] = JSON.parse(localStorage.getItem("agentic_os_conversations"));
    expect(conversation.title).toMatch(/^Coder: Inspect the input system/);
    expect(conversation.agentId).toBe("coder");
    expect(conversation.messages[1].content).toContain("Coder is working");
    expect(conversation.messages[1].thinking).toContain("Reading Assets/Scripts/Input/InputService.cs");

    updateDelegationConversation({
      delegationId: "delegate-1",
      status: "done",
      activity: "Task finished",
      result: "Migration review complete.",
    });
    const finished = JSON.parse(localStorage.getItem("agentic_os_conversations"))[0];
    expect(finished.messages[1].content).toBe("Migration review complete.");
    expect(finished.messages[1].streaming).toBe(false);
  });
});
