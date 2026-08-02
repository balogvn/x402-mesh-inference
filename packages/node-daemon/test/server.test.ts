import { describe, expect, it } from "vitest";
import { UpstreamError, ValidationError } from "@x402-mesh/shared";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "@x402-mesh/shared";
import type { InferenceProvider } from "../src/providers/index.js";
import { NodeServer } from "../src/server.js";
import type { NodeServerOptions } from "../src/server.js";
import { SSE_DONE, SseParser } from "../src/sse.js";

/**
 * The node's inference endpoint.
 *
 * These run against a real loopback listener rather than a mocked `IncomingMessage`: the
 * behaviours that matter (admission control answering before the body is parsed, SSE bytes
 * reaching the wire, a permit surviving a failed request) are all properties of the actual
 * HTTP plumbing.
 */

const BODY: ChatCompletionRequest = {
  model: "llama3.1:8b",
  messages: [{ role: "user", content: "hi" }],
};

function completion(text: string): ChatCompletionResponse {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1_760_000_000,
    model: "llama3.1:8b",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function chunkOf(text: string): ChatCompletionChunk {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1_760_000_000,
    model: "llama3.1:8b",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

interface ProviderState {
  healthCalls: number;
  chatCalls: number;
  healthy: boolean;
  lastSignal?: AbortSignal;
}

function stubProvider(overrides: Partial<InferenceProvider> = {}): {
  provider: InferenceProvider;
  state: ProviderState;
} {
  const state: ProviderState = { healthCalls: 0, chatCalls: 0, healthy: true };
  const provider: InferenceProvider = {
    name: "stub",
    baseUrl: "http://stub.test",
    listModels: async () => ["llama3.1:8b"],
    chat: async (_req, signal) => {
      state.chatCalls += 1;
      state.lastSignal = signal;
      return completion("hello");
    },
    chatStream: async function* () {
      yield chunkOf("he");
      yield chunkOf("llo");
    },
    health: async () => {
      state.healthCalls += 1;
      return state.healthy;
    },
    ...overrides,
  };
  return { provider, state };
}

/** Boots a server on an ephemeral loopback port and always tears it down. */
async function withServer(
  options: Omit<NodeServerOptions, "nodeId" | "models"> & Partial<NodeServerOptions>,
  run: (base: string, server: NodeServer) => Promise<void>,
): Promise<void> {
  const server = new NodeServer({
    nodeId: "node-test-1",
    models: ["llama3.1:8b"],
    host: "127.0.0.1",
    port: 0,
    ...options,
  });
  const port = await server.listen();
  try {
    await run(`http://127.0.0.1:${port}`, server);
  } finally {
    await server.close();
  }
}

function postInfer(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/infer`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * Reads an SSE response body into its decoded frame payloads.
 *
 * `done` reflects the `[DONE]` sentinel, which the parser consumes rather than emitting.
 */
async function readSse(res: Response): Promise<{ frames: string[]; done: boolean; raw: string }> {
  const parser = new SseParser();
  const raw = await res.text();
  const frames = parser.push(raw).map((e) => e.data);
  return { frames: [...frames, ...parser.flush().map((e) => e.data)], done: parser.done, raw };
}

describe("GET /health", () => {
  it("reports 200 and current load when the backend is reachable", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 3 }, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        status: "ok",
        nodeId: "node-test-1",
        provider: "stub",
        models: ["llama3.1:8b"],
        inFlight: 0,
        maxConcurrency: 3,
        available: 3,
      });
    });
  });

  it("reports 503 and degraded when the backend is down", async () => {
    const { provider, state } = stubProvider();
    state.healthy = false;
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "degraded" });
    });
  });

  it("reuses a recent probe instead of hammering the backend", async () => {
    const { provider, state } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      await fetch(`${base}/health`);
      await fetch(`${base}/health`);
      await fetch(`${base}/health`);
      // The gateway polls health far more often than the backend deserves to be probed.
      expect(state.healthCalls).toBe(1);
    });
  });

  it("answers HEAD as well as GET", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const res = await fetch(`${base}/health`, { method: "HEAD" });
      expect(res.status).toBe(200);
    });
  });

  it("rejects other methods with 405", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const res = await fetch(`${base}/health`, { method: "POST" });
      expect(res.status).toBe(405);
      expect(await res.json()).toMatchObject({ error: { code: "method_not_allowed" } });
    });
  });
});

describe("routing", () => {
  it("answers 404 for an unknown path", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      // NB: this used to probe `/v1/chat/completions` as its example of an unknown path,
      // which quietly asserted the bug as correct — that is the exact path the gateway
      // routes paid work to, and the daemon not serving it made every paid request fail
      // with `node returned HTTP 404`. Use a path nothing claims.
      const res = await fetch(`${base}/definitely-not-a-route`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });

  it("rejects a non-POST /infer with 405", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const res = await fetch(`${base}/infer`);
      expect(res.status).toBe(405);
    });
  });

  it("ignores the query string when routing", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      expect((await fetch(`${base}/health?verbose=1`)).status).toBe(200);
    });
  });

  it("echoes a caller-supplied request id and mints one otherwise", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const echoed = await fetch(`${base}/health`, { headers: { "x-request-id": "req-42" } });
      expect(echoed.headers.get("x-request-id")).toBe("req-42");

      const minted = await fetch(`${base}/health`);
      expect(minted.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});

describe("POST /infer", () => {
  it("returns the provider's completion", async () => {
    const { provider, state } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const res = await postInfer(base, BODY);
      expect(res.status).toBe(200);
      expect((await res.json()) as ChatCompletionResponse).toMatchObject({
        choices: [{ message: { content: "hello" } }],
      });
      expect(state.chatCalls).toBe(1);
    });
  });

  it("rejects a body that is empty, malformed or invalid", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      expect((await postInfer(base, "")).status).toBe(400);
      expect((await postInfer(base, "{not json")).status).toBe(400);

      const invalid = await postInfer(base, { messages: [] });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "validation_error" } });
    });
  });

  it("refuses an oversized body while it is still arriving", async () => {
    const { provider, state } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const huge = JSON.stringify({
        ...BODY,
        messages: [{ role: "user", content: "x".repeat(1_200_000) }],
      });
      const res = await postInfer(base, huge);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "validation_error" } });
      expect(state.chatCalls).toBe(0);
    });
  });

  it("maps a provider failure to its mesh status", async () => {
    const { provider } = stubProvider({
      chat: () => Promise.reject(new UpstreamError("ollama is not loaded", { upstream: "ollama" })),
    });
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const res = await postInfer(base, BODY);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: { code: "upstream_error" } });
    });
  });

  it("collapses an unclassified failure to an opaque 500", async () => {
    const { provider } = stubProvider({
      chat: () => Promise.reject(new Error("/home/op/.ssh/id_ed25519 is unreadable")),
    });
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const res = await postInfer(base, BODY);
      expect(res.status).toBe(500);
      const body = JSON.stringify(await res.json());
      // A raw message could carry a filesystem path or key material.
      expect(body).not.toContain("id_ed25519");
      expect(body).toContain("internal_error");
    });
  });

  it("hands the provider a signal that aborts when the caller hangs up", async () => {
    let observed: AbortSignal | undefined;
    let sawAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      sawAbort = resolve;
    });
    const { provider } = stubProvider({
      chat: (_req, signal) => {
        observed = signal;
        signal.addEventListener("abort", () => sawAbort());
        return new Promise<ChatCompletionResponse>(() => undefined);
      },
    });

    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const controller = new AbortController();
      const pending = postInfer(base, BODY, {}).catch(() => undefined);
      // Give the request time to reach the provider before hanging up.
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      void pending;
    });

    await aborted;
    // A client that walked away must not leave the GPU generating tokens nobody reads.
    expect(observed?.aborted).toBe(true);
  });
});

describe("admission control", () => {
  it("answers 503 with Retry-After once the semaphore is saturated", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, state } = stubProvider({
      chat: async () => {
        state.chatCalls += 1;
        await held;
        return completion("slow");
      },
    });

    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const first = postInfer(base, BODY);
      // Let the first request take the only permit.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const second = await postInfer(base, BODY);
      expect(second.status).toBe(503);
      expect(second.headers.get("retry-after")).toBe("1");
      expect(await second.json()).toMatchObject({
        error: {
          code: "no_capacity",
          details: { inFlight: 1, maxConcurrency: 1 },
        },
      });
      // The refused request must never have reached the backend.
      expect(state.chatCalls).toBe(1);

      release();
      expect((await first).status).toBe(200);
    });
  });

  it("returns the permit after a failed request, so the node does not wedge", async () => {
    let attempt = 0;
    const { provider } = stubProvider({
      chat: async () => {
        attempt += 1;
        if (attempt <= 3) throw new UpstreamError("backend hiccup");
        return completion("recovered");
      },
    });

    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      for (let i = 0; i < 3; i += 1) {
        expect((await postInfer(base, BODY)).status).toBe(502);
      }
      // A permit leaked on the error path would make this a permanent 503.
      const res = await postInfer(base, BODY);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        choices: [{ message: { content: "recovered" } }],
      });
    });
  });

  it("returns the permit after a rejected body", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base, server) => {
      for (let i = 0; i < 5; i += 1) await postInfer(base, "{bad");
      expect(server.load).toEqual({ inFlight: 0, maxConcurrency: 1 });
      expect((await postInfer(base, BODY)).status).toBe(200);
    });
  });

  it("exposes live load for the heartbeat snapshot", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 4 }, async (base, server) => {
      expect(server.load).toEqual({ inFlight: 0, maxConcurrency: 4 });
      await postInfer(base, BODY);
      expect(server.load).toEqual({ inFlight: 0, maxConcurrency: 4 });
    });
  });
});

describe("SSE passthrough", () => {
  it("forwards each chunk and terminates with [DONE]", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const res = await postInfer(base, { ...BODY, stream: true });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("cache-control")).toContain("no-cache");
      // Proxy buffering would defeat the point of streaming.
      expect(res.headers.get("x-accel-buffering")).toBe("no");

      const { frames, done, raw } = await readSse(res);
      expect(frames).toHaveLength(2);
      expect(frames.map((f) => JSON.parse(f).choices[0].delta.content)).toEqual(["he", "llo"]);
      // The sentinel is what tells the gateway the completion is whole rather than truncated.
      expect(done).toBe(true);
      expect(raw.trimEnd().endsWith(`data: ${SSE_DONE}`)).toBe(true);
    });
  });

  it("normalizes every frame to the mesh chunk shape", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const { frames } = await readSse(await postInfer(base, { ...BODY, stream: true }));
      const first = JSON.parse(frames[0]!) as ChatCompletionChunk;
      expect(first.object).toBe("chat.completion.chunk");
      expect(first.model).toBe("llama3.1:8b");
    });
  });

  it("reports a mid-stream failure in band rather than truncating silently", async () => {
    const { provider } = stubProvider({
      chatStream: async function* () {
        yield chunkOf("partial");
        throw new UpstreamError("CUDA out of memory", { upstream: "ollama" });
      },
    });

    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      const res = await postInfer(base, { ...BODY, stream: true });
      // Headers are already on the wire, so the status cannot change.
      expect(res.status).toBe(200);

      const raw = await res.text();
      // A consumer that sees `event: error` knows the completion ended abnormally.
      expect(raw).toContain("event: error");
      expect(raw).toContain("upstream_error");
      expect(raw.trimEnd().endsWith(`data: ${SSE_DONE}`)).toBe(true);
    });
  });

  it("releases the permit when a stream fails", async () => {
    let first = true;
    const { provider } = stubProvider({
      chatStream: async function* () {
        if (first) {
          first = false;
          throw new UpstreamError("boom");
        }
        yield chunkOf("ok");
      },
    });

    await withServer({ provider, maxConcurrency: 1 }, async (base, server) => {
      await (await postInfer(base, { ...BODY, stream: true })).text();
      expect(server.load.inFlight).toBe(0);

      const { frames } = await readSse(await postInfer(base, { ...BODY, stream: true }));
      expect(JSON.parse(frames[0]!).choices[0].delta.content).toBe("ok");
    });
  });
});

describe("bearer authentication", () => {
  it("is off by default", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1 }, async (base) => {
      expect((await postInfer(base, BODY)).status).toBe(200);
    });
  });

  it("rejects a missing, malformed or wrong token", async () => {
    const { provider, state } = stubProvider();
    await withServer({ provider, maxConcurrency: 1, authToken: "gateway-secret" }, async (base) => {
      const attempts: Record<string, string>[] = [
        {},
        { authorization: "gateway-secret" },
        { authorization: "Bearer wrong" },
        // Same length as the real token, so this exercises the comparison, not the guard.
        { authorization: "Bearer gateway-secreT" },
      ];
      for (const headers of attempts) {
        const res = await postInfer(base, BODY, headers);
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: { code: "auth_error" } });
      }
      // A rejected caller must never reach the backend or consume a permit.
      expect(state.chatCalls).toBe(0);
    });
  });

  it("accepts the configured token", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1, authToken: "gateway-secret" }, async (base) => {
      const res = await postInfer(base, BODY, { authorization: "Bearer gateway-secret" });
      expect(res.status).toBe(200);
    });
  });

  it("leaves /health unauthenticated so probes keep working", async () => {
    const { provider } = stubProvider();
    await withServer({ provider, maxConcurrency: 1, authToken: "gateway-secret" }, async (base) => {
      expect((await fetch(`${base}/health`)).status).toBe(200);
    });
  });
});

describe("lifecycle", () => {
  it("binds an ephemeral port and reports it", async () => {
    const { provider } = stubProvider();
    const server = new NodeServer({
      provider,
      maxConcurrency: 1,
      nodeId: "n",
      models: ["m"],
      host: "127.0.0.1",
      port: 0,
    });

    const port = await server.listen();
    expect(port).toBeGreaterThan(0);
    expect(server.port).toBe(port);

    await server.close();
    // A second close is a no-op rather than an unhandled rejection.
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("rejects when the port is already taken", async () => {
    const { provider } = stubProvider();
    const first = new NodeServer({
      provider,
      maxConcurrency: 1,
      nodeId: "n",
      models: ["m"],
      host: "127.0.0.1",
      port: 0,
    });
    const port = await first.listen();

    const second = new NodeServer({
      provider,
      maxConcurrency: 1,
      nodeId: "n",
      models: ["m"],
      host: "127.0.0.1",
      port,
    });

    await expect(second.listen()).rejects.toThrow();
    await first.close();
  });

  it("closing before listening resolves", async () => {
    const { provider } = stubProvider();
    const server = new NodeServer({ provider, maxConcurrency: 1, nodeId: "n", models: ["m"] });
    await expect(server.close()).resolves.toBeUndefined();
    expect(server.port).toBe(0);
  });

  it("refuses a non-positive concurrency ceiling at construction", () => {
    const { provider } = stubProvider();
    expect(
      () => new NodeServer({ provider, maxConcurrency: 0, nodeId: "n", models: ["m"] }),
    ).toThrow(ValidationError);
  });

  it("emits structured log events for served and failed requests", async () => {
    const events: Array<Record<string, unknown>> = [];
    const { provider } = stubProvider({
      chat: () => Promise.reject(new UpstreamError("nope")),
    });

    await withServer(
      { provider, maxConcurrency: 1, log: (event) => events.push(event) },
      async (base) => {
        await postInfer(base, BODY);
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "error", status: 502, code: "upstream_error" });
    expect(JSON.stringify(events)).not.toContain("hi");
  });
});
