// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Chat from "../src/components/Chat.jsx";

const streamChatMock = vi.fn();
vi.mock("../src/utils/api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchModels: vi.fn(async () => ({ models: {} })),
    streamChat: (...args) => streamChatMock(...args),
  };
});
vi.mock("../src/components/ResizeHandle.jsx", () => ({ default: () => null }));
vi.mock("../src/components/ModelSelector.jsx", () => ({ default: () => null }));

async function* reply(text) {
  yield text;
}

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  streamChatMock.mockReset();
  streamChatMock.mockImplementation(() => reply("Assistant reply"));
});
afterEach(() => cleanup());

describe("chat turn handling", () => {
  it("keeps the user message and renders the streamed response as an assistant message", async () => {
    const { container } = render(<Chat />);
    const input = await screen.findByPlaceholderText("Message the agent...");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(container.querySelector(".send-btn"));

    expect(await screen.findByText("Assistant reply")).toBeTruthy();
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(container.querySelectorAll(".message-wrapper.user")).toHaveLength(1);
    expect(container.querySelectorAll(".message-wrapper.agent")).toHaveLength(1);
  });

  it("persists both messages so a conversation can be resumed", async () => {
    const { container } = render(<Chat />);
    const input = await screen.findByPlaceholderText("Message the agent...");
    fireEvent.change(input, { target: { value: "Remember this" } });
    fireEvent.click(container.querySelector(".send-btn"));

    await screen.findByText("Assistant reply");
    await waitFor(() => {
      const conversations = JSON.parse(localStorage.getItem("agentic_os_conversations"));
      expect(conversations[0].messages.map((message) => message.role)).toEqual(["user", "agent"]);
    });
  });

  it("cancels the provider request when Stop is pressed", async () => {
    const { container } = render(<Chat />);
    let requestSignal;
    streamChatMock.mockImplementation(({ signal }) => {
      requestSignal = signal;
      return (async function* () {
        yield "Starting…";
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        throw new DOMException("Aborted", "AbortError");
      })();
    });
    const input = await screen.findByPlaceholderText("Message the agent...");
    fireEvent.change(input, { target: { value: "Cancel this" } });
    fireEvent.click(container.querySelector(".send-btn"));
    const stop = await screen.findByText("Stop");
    fireEvent.click(stop.closest("button"));
    expect(requestSignal.aborted).toBe(true);
  });

  it("sends image bytes as vision input without persisting the base64 preview", async () => {
    const { container } = render(<Chat />);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "tiny.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
    expect(await screen.findByText("tiny.png")).toBeTruthy();
    const input = screen.getByPlaceholderText("Message the agent...");
    fireEvent.change(input, { target: { value: "Describe this image" } });
    fireEvent.click(container.querySelector(".send-btn"));
    await screen.findByText("Assistant reply");

    const sentMessages = streamChatMock.mock.calls.at(-1)[0].messages;
    expect(JSON.stringify(sentMessages)).toContain("image_url");
    expect(JSON.stringify(JSON.parse(localStorage.getItem("agentic_os_conversations")))).not.toContain("data:image/");
  });

  it("supports dropped text files and includes their content in the model request", async () => {
    const { container } = render(<Chat />);
    const file = new File(["The launch date is Tuesday."], "brief.txt", { type: "text/plain" });
    const inputArea = container.querySelector(".input-area");
    fireEvent.drop(inputArea, { dataTransfer: { files: [file] } });
    expect(await screen.findByText("brief.txt")).toBeTruthy();

    const input = screen.getByPlaceholderText("Message the agent...");
    fireEvent.change(input, { target: { value: "Summarize the attachment" } });
    fireEvent.click(container.querySelector(".send-btn"));
    await screen.findByText("Assistant reply");

    const sentMessages = streamChatMock.mock.calls.at(-1)[0].messages;
    expect(JSON.stringify(sentMessages)).toContain("The launch date is Tuesday.");
  });
});
