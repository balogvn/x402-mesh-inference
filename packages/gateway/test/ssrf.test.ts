import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetEndpointValidationCache } from "@x402-mesh/shared";

import { createApp } from "../src/app.js";
import {
  makeConfig,
  makeNodeRecord,
  makeOperator,
  makeSignedRegistration,
  StubChain,
  StubSelector,
  StubSettlement,
  StubStore,
} from "./helpers.js";

/**
 * Regression tests for the SSRF vector found by audit.
 *
 * Before the fix, registration accepted any syntactically valid http(s) URL and the router
 * fetched it verbatim: registering `http://169.254.169.254/latest/meta-data` caused the
 * gateway to issue a real request to cloud instance metadata. Node registration is open to
 * anyone who can generate an Algorand keypair, so this was reachable by any attacker.
 */
// The endpoint validation cache is module-level state. Clearing it between tests keeps each
// case independent of what ran before it — a security assertion that depends on test order is
// worse than no assertion.
beforeEach(() => {
  resetEndpointValidationCache();
});

describe("SSRF guard on operator-supplied endpoints", () => {
  it("refuses to register a cloud-metadata endpoint", async () => {
    const app = createApp({
      config: makeConfig({ requireUsdcOptIn: false, allowPrivateNodeEndpoints: false }),
      store: new StubStore(),
      selector: new StubSelector([]),
      settlement: new StubSettlement(),
      chain: new StubChain(false),
    });

    const res = await request(app)
      .post("/v1/nodes/register")
      .send(
        makeSignedRegistration(makeOperator(), {
          endpoint: "http://169.254.169.254/latest/meta-data",
        }),
      );

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/non-public address/);
  });

  it.each([
    ["http://127.0.0.1:6379", "loopback"],
    ["http://10.0.0.5:8000", "RFC1918"],
    ["http://192.168.1.10:8000", "RFC1918"],
  ])("refuses to register %s (%s)", async (endpoint) => {
    const app = createApp({
      config: makeConfig({ requireUsdcOptIn: false, allowPrivateNodeEndpoints: false }),
      store: new StubStore(),
      selector: new StubSelector([]),
      settlement: new StubSettlement(),
      chain: new StubChain(false),
    });

    const res = await request(app)
      .post("/v1/nodes/register")
      .send(makeSignedRegistration(makeOperator(), { endpoint }));

    expect(res.status).toBe(400);
  });

  it("refuses an endpoint embedding credentials", async () => {
    const app = createApp({
      config: makeConfig({ requireUsdcOptIn: false, allowPrivateNodeEndpoints: false }),
      store: new StubStore(),
      selector: new StubSelector([]),
      settlement: new StubSettlement(),
      chain: new StubChain(false),
    });

    const res = await request(app)
      .post("/v1/nodes/register")
      .send(makeSignedRegistration(makeOperator(), { endpoint: "http://u:p@node.example.com" }));

    expect(res.status).toBe(400);
  });

  it("never fetches a private endpoint that reached the store, defeating DNS rebinding", async () => {
    // Simulates a node whose hostname resolved to a public address at registration time and
    // was later re-pointed at metadata. The store already holds it, so only the connect-time
    // re-validation in the router can stop the request.
    const record = makeNodeRecord({}, { endpoint: "http://169.254.169.254" });
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;

    const app = createApp({
      config: makeConfig({ allowPrivateNodeEndpoints: false }),
      store: new StubStore([record]),
      selector: new StubSelector([record]),
      settlement: new StubSettlement(),
      chain: new StubChain(true),
      fetchImpl,
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    // The critical assertion: no outbound request was made at all.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("still routes to a private endpoint when the operator opted in (local dev)", async () => {
    const record = makeNodeRecord({}, { endpoint: "http://127.0.0.1:11434" });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "llama3.1:8b",
            choices: [
              { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const app = createApp({
      config: makeConfig({ allowPrivateNodeEndpoints: true }),
      store: new StubStore([record]),
      selector: new StubSelector([record]),
      settlement: new StubSettlement(),
      chain: new StubChain(true),
      fetchImpl,
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

/**
 * Regression test for the unbounded-buffering vector found by audit.
 *
 * Before the fix the cap was enforced *after* `await response.text()` had already resolved
 * the whole body into memory, so a hostile node could exhaust the gateway's heap even though
 * the response was destined to be rejected.
 */
describe("upstream body size cap", () => {
  it("stops reading an oversized body instead of buffering it whole", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
    let chunksPulled = 0;

    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              chunksPulled += 1;
              // Far more than the 8 MiB cap; a buffer-then-check reader would drain it all.
              if (chunksPulled > 64) {
                controller.close();
                return;
              }
              controller.enqueue(chunk);
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const record = makeNodeRecord();
    const app = createApp({
      config: makeConfig({ allowPrivateNodeEndpoints: true }),
      store: new StubStore([record]),
      selector: new StubSelector([record]),
      settlement: new StubSettlement(),
      chain: new StubChain(true),
      fetchImpl,
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(502);
    // 8 MiB cap over 1 MiB chunks: the reader must bail out at ~9 pulls, nowhere near 64.
    expect(chunksPulled).toBeLessThanOrEqual(12);
  });
});
