import { createServer, request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { NoCapacityError } from "@x402-mesh/shared";
import { createApp } from "../src/app.js";
import { NODE_ID_HEADER } from "../src/routes/chat.js";
import type { RouteInput, RouteResult } from "../src/ports.js";
import {
  makeConfig,
  makeNodeRecord,
  StubRouter,
  StubSelector,
  StubSettlement,
  StubStore,
} from "./helpers.js";

/**
 * The paid route's own behaviour, exercised with the paywall off so that validation,
 * streaming and routing bookkeeping can be observed without constructing a real payment.
 */

const NODE = makeNodeRecord({}, { nodeId: "node-a" });

function buildApp(respond: (input: RouteInput) => Promise<RouteResult> | RouteResult) {
  const config = makeConfig();
  const settlement = new StubSettlement();
  const router = new StubRouter(respond);
  return {
    settlement,
    router,
    app: createApp({
      config,
      store: new StubStore([NODE]),
      selector: new StubSelector([NODE]),
      settlement,
      router,
      // No resourceServer: the paywall is deliberately off for these cases.
    }),
  };
}

const OK_RESULT: RouteResult = {
  node: NODE,
  body: { id: "chatcmpl-1", object: "chat.completion" },
  latencyMs: 12,
  attempts: 1,
};

describe("POST /v1/chat/completions validation", () => {
  it.each([
    ["missing model", { messages: [{ role: "user", content: "hi" }] }],
    ["empty messages", { model: "llama3.1:8b", messages: [] }],
    ["bad role", { model: "llama3.1:8b", messages: [{ role: "root", content: "hi" }] }],
    [
      "temperature out of range",
      { model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }], temperature: 9 },
    ],
    [
      "non-integer max_tokens",
      { model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }], max_tokens: 1.5 },
    ],
    ["not an object", "just a string"],
  ])("rejects %s", async (_label, body) => {
    const { app, router } = buildApp(() => OK_RESULT);

    const response = await request(app).post("/v1/chat/completions").send(body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
    // A malformed request must never reach a node.
    expect(router.calls).toHaveLength(0);
  });

  it("accepts and forwards unknown OpenAI fields by stripping them", async () => {
    const { app, router } = buildApp(() => OK_RESULT);

    const response = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "hi" }],
        // Real OpenAI clients send fields this gateway does not implement; rejecting them
        // outright would break drop-in compatibility.
        presence_penalty: 0.5,
        user: "someone",
      });

    expect(response.status).toBe(200);
    expect(router.calls[0]?.request).not.toHaveProperty("presence_penalty");
    expect(router.calls[0]?.request).not.toHaveProperty("user");
  });
});

describe("POST /v1/chat/completions routing", () => {
  it("returns the node's body and records the routing decision for settlement", async () => {
    const { app, settlement } = buildApp(() => OK_RESULT);

    const response = await request(app)
      .post("/v1/chat/completions")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe("chatcmpl-1");
    expect(response.headers[NODE_ID_HEADER]).toBeUndefined();

    // The stub router does not invoke onNodeSelected, so nothing is recorded — which is the
    // correct behaviour: a payout is only ever attributed to a node that was really chosen.
    expect(settlement.routed).toHaveLength(0);
  });

  it("records the routing note and node header when a node is committed to", async () => {
    const { app, settlement } = buildApp((input) => {
      input.onNodeSelected?.(NODE);
      return OK_RESULT;
    });

    const response = await request(app)
      .post("/v1/chat/completions")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(200);
    expect(response.headers[NODE_ID_HEADER]).toBe("node-a");
    expect(settlement.routed).toHaveLength(1);
    expect(settlement.routed[0]?.nodeId).toBe("node-a");
    expect(settlement.routed[0]?.operatorAddress).toBe(NODE.registration.operatorAddress);
    // The request id in the note is the one echoed to the client: that pairing is what lets
    // the settlement hook find the note again.
    expect(settlement.routed[0]?.requestId).toBe(response.headers["x-request-id"]);
  });

  it("re-points the routing note when the router fails over to a second node", async () => {
    const second = makeNodeRecord({}, { nodeId: "node-b" });
    const { app, settlement } = buildApp((input) => {
      input.onNodeSelected?.(NODE);
      input.onNodeSelected?.(second);
      return { ...OK_RESULT, node: second, attempts: 2 };
    });

    await request(app)
      .post("/v1/chat/completions")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    // Both selections are reported; the settlement service keys by request id, so the last
    // one — the node that actually served — is the one that gets paid.
    expect(settlement.routed.map((r) => r.nodeId)).toEqual(["node-a", "node-b"]);
  });

  it("maps a capacity failure to 503", async () => {
    const { app } = buildApp(() => {
      throw new NoCapacityError("no healthy node can serve the requested model", {
        model: "gpt-9",
      });
    });

    const response = await request(app)
      .post("/v1/chat/completions")
      .send({ model: "gpt-9", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("no_capacity");
  });

  it("never leaks a stack trace on an unexpected failure", async () => {
    const { app } = buildApp(() => {
      throw new Error("/Users/someone/secret/path.ts exploded");
    });

    const response = await request(app)
      .post("/v1/chat/completions")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(JSON.stringify(response.body)).not.toContain("/Users/");
  });
});

describe("POST /v1/chat/completions streaming", () => {
  it("writes SSE frames through the response sink and terminates with [DONE]", async () => {
    const { app } = buildApp(async (input) => {
      input.onNodeSelected?.(NODE);
      const sink = input.sink;
      expect(sink, "a streaming request must supply a sink").toBeDefined();
      sink!.begin("text/event-stream");
      sink!.write(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
      sink!.write(new TextEncoder().encode("data: [DONE]\n\n"));
      sink!.end();
      return { node: NODE, latencyMs: 5, attempts: 1 };
    });

    const response = await request(app)
      .post("/v1/chat/completions")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }], stream: true });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    // Asks an intermediary proxy not to re-buffer the stream we took care to un-buffer.
    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.headers["cache-control"]).toContain("no-cache");
    expect(response.text).toContain('"content":"Hi"');
    expect(response.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("does not abort the upstream on a request that completes normally", async () => {
    let observed: AbortSignal | undefined;
    const { app } = buildApp((input) => {
      observed = input.signal;
      input.onNodeSelected?.(NODE);
      return OK_RESULT;
    });

    await request(app)
      .post("/v1/chat/completions")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    expect(observed).toBeInstanceOf(AbortSignal);
    // The request stream emits `close` as soon as its body is consumed, which is before the
    // handler runs. Keying disconnect off that would abort every healthy request.
    expect(observed?.aborted).toBe(false);
  });

  it("aborts the upstream when the client destroys the connection mid-request", async () => {
    let observed: AbortSignal | undefined;
    let released!: () => void;
    const upstreamAborted = new Promise<void>((resolve) => {
      released = resolve;
    });

    const { app } = buildApp(async (input) => {
      observed = input.signal;
      input.onNodeSelected?.(NODE);
      input.signal.addEventListener("abort", () => released());
      // Emulate a node that never answers: only the abort can end this.
      await upstreamAborted;
      throw new Error("aborted");
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    const clientRequest = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    clientRequest.on("error", () => undefined); // the destroy below is deliberate
    clientRequest.end(
      JSON.stringify({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    clientRequest.destroy();
    await upstreamAborted;

    expect(observed?.aborted).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
