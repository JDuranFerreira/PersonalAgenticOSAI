// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConversationHistory from "../src/components/ConversationHistory.jsx";

afterEach(() => cleanup());

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

  it("allows a conversation title to be renamed inline", () => {
    const onRename = vi.fn();
    render(
      <ConversationHistory
        conversations={[{ id: "a", title: "Alpha", preview: "", messages: [] }]}
        activeId="a"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onRename={onRename}
        onNew={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Alpha" }));
    const input = screen.getByRole("textbox", { name: "Rename Alpha" });
    fireEvent.change(input, { target: { value: "Polish practice" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));

    expect(onRename).toHaveBeenCalledWith("a", "Polish practice");
  });
});
