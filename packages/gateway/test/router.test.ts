import { describe, expect, it } from "vitest";
import { NoCapacityError, UpstreamError } from "@x402-mesh/shared";
import { silentLogger } from "../src/logger.js";
import type { StreamSink } from "../src/ports.js";
import { HttpNodeRouter } from "../src/services/router.js";
import { makeConfig, makeNodeRecord, sseResponse, StubSelector } from "./helpers.js";

/**
 * Router behaviour under failure. Every case here is one the mesh will actually hit: a node
 * that dies mid-rotation, a node that hangs, a client that walks away.
 */

const CHAT_REQUEST = {
  model: "llama3.1:8b",
  messages: [{ role: "user" as const, content: "hello" }],
};

function collectingSink(): StreamSink & { chunks: string[]; began: string[]; ended: number } {
  const decoder = new TextDecoder();
  return {
    chunks: [],
    began: [],
    ended: 0,
    begin(contentType: string) {
      this.began.push(contentType);
    },
    write(chunk: Uint8Array) {
      this.chunks.push(decoder.decode(chunk));
    },
    end() {
      this.ended += 1;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpNodeRouter", () => {
  it("forwards to the selected node and returns the parsed body", async () => {
    const node = makeNodeRecord({}, { nodeId: "node-a", endpoint: "https://a.test" });
    const selector = new StubSelector([node]);
    const seen: Array<{ url: string; body: unknown }> = [];

    const router = new HttpNodeRouter({
      config: makeConfig(),
      selector,
      logger: silentLogger,
      fetchImpl: async (input, init) => {
        seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return jsonResponse({ id: "chatcmpl-1", object: "chat.completion" });
      },
    });

    const result = await router.route({
      requestId: "req-1",
      request: CHAT_REQUEST,
      signal: new AbortController().signal,
    });

    expect(result.node.registration.nodeId).toBe("node-a");
    expect(result.attempts).toBe(1);
    expect((result.body as { id: string }).id).toBe("chatcmpl-1");
    expect(seen[0]?.url).toBe("https://a.test/v1/chat/completions");
    expect(seen[0]?.body).toMatchObject({ model: "llama3.1:8b" });

    // Health accounting is exact and paired.
    expect(selector.began).toEqual(["node-a"]);
    expect(selector.ended).toEqual(["node-a"]);
    expect(selector.outcomes).toHaveLength(1);
    expect(selector.outcomes[0]?.outcome.success).toBe(true);
  });

  it("retries onto a different node and records both outcomes", async () => {
    const first = makeNodeRecord({}, { nodeId: "node-a", endpoint: "https://a.test" });
    const second = makeNodeRecord({}, { nodeId: "node-b", endpoint: "https://b.test" });
    const selector = new StubSelector([first, second]);

    const router = new HttpNodeRouter({
      config: makeConfig(),
      selector,
      logger: silentLogger,
      fetchImpl: async (input) =>
        String(input).startsWith("https://a.test")
          ? jsonResponse({ error: "overloaded" }, 503)
          : jsonResponse({ id: "chatcmpl-2", object: "chat.completion" }),
    });

    const result = await router.route({
      requestId: "req-2",
      request: CHAT_REQUEST,
      signal: new AbortController().signal,
    });

    expect(result.node.registration.nodeId).toBe("node-b");
    expect(result.attempts).toBe(2);

    // The second selection must exclude the node that just failed, or the retry is a no-op.
    expect(selector.selections[1]?.excludeNodeIds).toEqual(["node-a"]);

    expect(selector.began).toEqual(["node-a", "node-b"]);
    expect(selector.ended).toEqual(["node-a", "node-b"]);
    expect(selector.outcomes.map((o) => [o.nodeId, o.outcome.success])).toEqual([
      ["node-a", false],
      ["node-b", true],
    ]);
  });

  it("releases the in-flight slot even when the upstream throws", async () => {
    const node = makeNodeRecord({}, { nodeId: "node-a", endpoint: "https://a.test" });
    const selector = new StubSelector([node]);

    const router = new HttpNodeRouter({
      config: makeConfig(),
      selector,
      logger: silentLogger,
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    await expect(
      router.route({
        requestId: "req-3",
        request: CHAT_REQUEST,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(UpstreamError);

    // One node available, so the retry cannot find a second one; the slot must still be
    // released or the node silently loses capacity forever.
    expect(selector.began).toEqual(["node-a"]);
    expect(selector.ended).toEqual(["node-a"]);
    expect(selector.outcomes[0]?.outcome.success).toBe(false);
  });

  it("surfaces NoCapacityError when nothing can serve the model", async () => {
    const router = new HttpNodeRouter({
      config: makeConfig(),
      selector: new StubSelector([]),
      logger: silentLogger,
      fetchImpl: () => Promise.reject(new Error("should not be called")),
    });

    await expect(
      router.route({
        requestId: "req-4",
        request: CHAT_REQUEST,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("streams SSE chunks through and terminates with [DONE]", async () => {
    const node = makeNodeRecord({}, { nodeId: "node-a", endpoint: "https://a.test" });
    const sink = collectingSink();

    const router = new HttpNodeRouter({
      config: makeConfig(),
      selector: new StubSelector([node]),
      logger: silentLogger,
      fetchImpl: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
    });

    await router.route({
      requestId: "req-5",
      request: { ...CHAT_REQUEST, stream: true },
      signal: new AbortController().signal,
      sink,
    });

    expect(sink.began).toEqual(["text/event-stream"]);
    expect(sink.chunks.join("")).toContain('"content":"Hel"');
    expect(sink.chunks.join("")).toContain("data: [DONE]");
    // The upstream already sent [DONE]; it must not be duplicated.
    expect(sink.chunks.join("").match(/\[DONE\]/g)).toHaveLength(1);
    expect(sink.ended).toBe(1);
  });

  it("synthesises the [DONE] frame when the node omits it", async () => {
    const node = makeNodeRecord({}, { nodeId: "node-a", endpoint: "https://a.test" });
    const sink = collectingSink();

    const router = new HttpNodeRouter({
      config: makeConfig(),
      selector: new StubSelector([node]),
      logger: silentLogger,
      fetchImpl: async () => sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n']),
    });

    await router.route({
      requestId: "req-6",
      request: { ...CHAT_REQUEST, stream: true },
      signal: new AbortController().signal,
      sink,
    });

    // An OpenAI-compatible client blocks until it sees this frame; without it the caller
    // hangs until its own timeout.
    expect(sink.chunks.join("")).toContain("data: [DONE]");
    expect(sink.ended).toBe(1);
  });

  it("aborts the upstream fetch when the client disconnects", async () => {
    const node = makeNodeRecord({}, { nodeId: "node-a", endpoint: "https://a.test" });
    const selector = new StubSelector([node]);
    const controller = new AbortController();
    let upstreamAborted = false;

    const router = new HttpNodeRouter({
      config: makeConfig(),
      selector,
      logger: silentLogger,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          // A hung node: it never answers, so only the abort signal can end this.
          const signal = init?.signal;
          const abort = (): void => {
            upstreamAborted = true;
            reject(new Error("aborted"));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort);
        }),
    });

    const routed = router.route({
      requestId: "req-7",
      request: CHAT_REQUEST,
      signal: controller.signal,
    });
    // Abort once the upstream call is genuinely in flight, which is the real-world ordering.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("client disconnected"));

    await expect(routed).rejects.toBeInstanceOf(UpstreamError);
    expect(upstreamAborted).toBe(true);
    // No retry after a client disconnect: there is nobody left to serve.
    expect(selector.selections).toHaveLength(1);
    expect(selector.ended).toEqual(["node-a"]);
  });

  it("enforces the node request timeout", async () => {
    const node = makeNodeRecord({}, { nodeId: "node-a", endpoint: "https://a.test" });
    const selector = new StubSelector([node]);

    const router = new HttpNodeRouter({
      config: makeConfig({ nodeRequestTimeoutMs: 1_000 }),
      selector,
      logger: silentLogger,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("timed out")));
        }),
    });

    await expect(
      router.route({
        requestId: "req-8",
        request: CHAT_REQUEST,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(UpstreamError);

    expect(selector.ended).toEqual(["node-a"]);
  });

  it("does not retry once bytes have reached the client", async () => {
    const first = makeNodeRecord({}, { nodeId: "node-a", endpoint: "https://a.test" });
    const second = makeNodeRecord({}, { nodeId: "node-b", endpoint: "https://b.test" });
    const selector = new StubSelector([first, second]);
    const sink = collectingSink();

    const router = new HttpNodeRouter({
      config: makeConfig(),
      selector,
      logger: silentLogger,
      fetchImpl: async () => {
        // Opens the stream, emits a frame, then dies. Retrying now would splice two
        // different completions into one response.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"delta":"partial"}\n\n'));
            controller.error(new Error("node died mid-stream"));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    await expect(
      router.route({
        requestId: "req-9",
        request: { ...CHAT_REQUEST, stream: true },
        signal: new AbortController().signal,
        sink,
      }),
    ).rejects.toBeInstanceOf(UpstreamError);

    expect(selector.selections).toHaveLength(1);
    expect(sink.began).toHaveLength(1);
    expect(sink.ended).toBe(1);
  });

  it("rejects a node body that is not valid JSON", async () => {
    const node = makeNodeRecord({}, { nodeId: "node-a", endpoint: "https://a.test" });

    const router = new HttpNodeRouter({
      config: makeConfig(),
      selector: new StubSelector([node]),
      logger: silentLogger,
      fetchImpl: async () =>
        new Response("<html>gateway timeout</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    await expect(
      router.route({
        requestId: "req-10",
        request: CHAT_REQUEST,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});
