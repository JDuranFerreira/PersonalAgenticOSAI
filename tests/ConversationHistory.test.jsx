// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConversationHistory from "../src/components/ConversationHistory.jsx";

describe("conversation history search", () => {
  it("matches words in saved messages as well as the title and preview", () => {
    const conversations = [
      { id: "a", title: "Alpha", preview: "", messages: [{ content: "Needle appears in this reply" }] },
      { id: "b", title: "Beta", preview: "unrelated", messages: [{ content: "nothing to see" }] },
    ];
    render(
      <ConversationHistory
        conversations={conversations}
        activeId="a"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onNew={vi.fn()}
        searchQuery="needle"
        onSearchChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
  });
});
