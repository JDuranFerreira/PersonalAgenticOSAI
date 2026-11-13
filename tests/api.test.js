import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubSecurityAudit, streamChat } from "../src/utils/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("chat request cancellation", () => {
  it("passes the caller's AbortSignal to the streaming fetch", async () => {
    const controller = new AbortController();
    let receivedSignal;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      receivedSignal = options.signal;
      return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    }));

    const iterator = streamChat({ messages: [], signal: controller.signal });
    await iterator.next();
    expect(receivedSignal).toBe(controller.signal);
  });

  it("ignores intermediate provider failures while the server tries its fallback chain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"type":"error","model":"first","error":"unavailable"}\n\n' +
      'data: {"type":"delta","content":"fallback reply"}\n\n' +
      "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    )));
    const chunks = [];
    for await (const chunk of streamChat({ messages: [{ role: "user", content: "Hi" }] })) chunks.push(chunk);
    expect(chunks).toEqual(["fallback reply"]);
  });

  it("surfaces terminal stream errors to the caller", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"type":"fatal","error":"all providers failed"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    )));
    await expect(async () => {
      for await (const _chunk of streamChat({ messages: [{ role: "user", content: "Hi" }] })) {}
    }).rejects.toThrow("all providers failed");
  });
});

describe("GitHub security audit API", () => {
  it("explains that the local backend needs restarting when the route is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Cannot GET", { status: 404 })));
    await expect(fetchGitHubSecurityAudit()).rejects.toThrow("running Agentic OS server is outdated");
  });
});
