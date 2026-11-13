// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Message from "../src/components/Message.jsx";
import { renderMarkdown } from "../src/utils/markdown.js";

describe("message rendering", () => {
  it("renders fenced code as a highlighted, copyable code block", () => {
    const { container } = render(<Message role="agent" content={'Example:\n```js\nconst answer = 42;\n```'} />);
    expect(container.querySelector(".code-block-wrap")).toBeTruthy();
    expect(container.querySelector("code").textContent).toContain("const answer = 42;");
  });

  it("sanitizes executable HTML in Markdown", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"><script>alert(2)</script>safe');
    expect(html).not.toMatch(/<script|onerror=/i);
    expect(html).toContain("safe");
  });

  it("allows process details to be expanded and collapsed accessibly", () => {
    const { container } = render(<Message role="agent" content="Brief" thinking="Tool log" />);
    const toggle = screen.getByRole("button", { name: /agent process/i });
    expect(container.querySelector(".thinking-content").classList.contains("collapsed")).toBe(true);
    fireEvent.click(toggle);
    expect(container.querySelector(".thinking-content").classList.contains("collapsed")).toBe(false);
  });
});
