import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import {
  makeConfig,
  makeOperator,
  makeSignedHeartbeat,
  makeSignedRegistration,
  StubChain,
  StubSelector,
  StubSettlement,
  StubStore,
} from "./helpers.js";

/**
 * Regression tests for unauthenticated heartbeats.
 *
 * The daemon has always signed its heartbeats with a domain-separated Ed25519 signature, but
 * the gateway validated only the body schema and then marked the node healthy. Node ids are
 * public via `GET /v1/nodes`, so anyone could keep any node — including a dead one, or a
 * competitor's — marked healthy. Health is what the selector uses to decide where paid
 * traffic goes, which made this unauthenticated input driving an economic decision.
 */
function buildApp() {
  const store = new StubStore();
  return {
    store,
    app: createApp({
      config: makeConfig({ requireUsdcOptIn: false }),
      store,
      selector: new StubSelector([]),
      settlement: new StubSettlement(),
      chain: new StubChain(true),
    }),
  };
}

/**
 * Registers `node-alpha` under a fresh operator.
 *
 * @returns The app, store and the registered operator identity.
 */
async function withRegisteredNode() {
  const { app, store } = buildApp();
  const operator = makeOperator();
  const res = await request(app).post("/v1/nodes/register").send(makeSignedRegistration(operator));
  expect(res.status).toBe(201);
  return { app, store, operator };
}

describe("heartbeat authentication", () => {
  it("rejects an anonymous heartbeat with no signature at all", async () => {
    const { app, store } = await withRegisteredNode();
    const before = store.get("node-alpha")?.health.lastSeenAt ?? 0;

    // This is precisely the request that used to succeed.
    const res = await request(app).post("/v1/nodes/node-alpha/heartbeat").send({});

    expect(res.status).toBe(400);
    expect(store.get("node-alpha")?.health.lastSeenAt).toBe(before);
  });

  it("rejects a heartbeat signed by a DIFFERENT operator", async () => {
    const { app, store } = await withRegisteredNode();
    const attacker = makeOperator();
    const before = store.get("node-alpha")?.health.lastSeenAt ?? 0;

    // The attacker signs a structurally perfect heartbeat with their own valid key. It must
    // fail because the gateway checks the key against the address it stored at registration,
    // not against anything in the request.
    const res = await request(app)
      .post("/v1/nodes/node-alpha/heartbeat")
      .send(makeSignedHeartbeat(attacker));

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(/does not match the registered operator/);
    expect(store.get("node-alpha")?.health.lastSeenAt).toBe(before);
  });

  it("rejects a replayed heartbeat", async () => {
    const { app, operator } = await withRegisteredNode();
    const beat = makeSignedHeartbeat(operator);

    expect((await request(app).post("/v1/nodes/node-alpha/heartbeat").send(beat)).status).toBe(200);
    // Byte-identical replay: valid signature, already-used nonce.
    const replay = await request(app).post("/v1/nodes/node-alpha/heartbeat").send(beat);
    expect(replay.status).toBe(400);
    expect(JSON.stringify(replay.body)).toMatch(/nonce has already been used/);
  });

  it("rejects a stale heartbeat outside the skew window", async () => {
    const { app, operator } = await withRegisteredNode();
    const stale = makeSignedHeartbeat(operator, {}, Date.now() - 10 * 60 * 1000);

    const res = await request(app).post("/v1/nodes/node-alpha/heartbeat").send(stale);
    expect(res.status).toBe(400);
  });

  it("rejects a heartbeat whose signed nodeId does not match the path", async () => {
    const { app, operator } = await withRegisteredNode();
    // Signed for a different node, replayed against this one by the same operator.
    const res = await request(app)
      .post("/v1/nodes/node-alpha/heartbeat")
      .send(makeSignedHeartbeat(operator, { nodeId: "node-beta" }));

    expect(res.status).toBe(401);
  });

  it("rejects a tampered heartbeat whose signature no longer covers the body", async () => {
    const { app, operator } = await withRegisteredNode();
    const beat = makeSignedHeartbeat(operator);
    // Flip a signed field, keeping the otherwise-valid signature.
    beat.heartbeat.healthy = !beat.heartbeat.healthy;

    const res = await request(app).post("/v1/nodes/node-alpha/heartbeat").send(beat);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(/signature verification failed/);
  });

  it("accepts a correctly signed, fresh heartbeat and refreshes liveness", async () => {
    const { app, store, operator } = await withRegisteredNode();
    const before = store.get("node-alpha")?.health.lastSeenAt ?? 0;
    await new Promise((r) => setTimeout(r, 5));

    const res = await request(app)
      .post("/v1/nodes/node-alpha/heartbeat")
      .send(makeSignedHeartbeat(operator));

    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(true);
    expect(store.get("node-alpha")!.health.lastSeenAt).toBeGreaterThan(before);
  });

  it("accepts successive heartbeats, each with a fresh nonce", async () => {
    const { app, operator } = await withRegisteredNode();
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/v1/nodes/node-alpha/heartbeat")
        .send(makeSignedHeartbeat(operator));
      expect(res.status).toBe(200);
    }
  });
});

/**
 * Regression: an unknown node must get 404, not 400.
 *
 * The daemon re-registers on 404/410 and treats 400 as "my request is malformed, retrying
 * will not help". The gateway returned 400 when it had forgotten a node — which happens on
 * every restart, since the default registry is in-memory. The result, observed in production:
 * a healthy node heartbeated into a void indefinitely, the gateway served `503 no_capacity`,
 * and both sides reported themselves healthy. Recovery only came when the node process
 * happened to restart.
 */
describe("heartbeat for a node the gateway has forgotten", () => {
  it("answers 404 so the daemon knows to re-register", async () => {
    const { app } = buildApp();
    const operator = makeOperator();

    const res = await request(app)
      .post("/v1/nodes/ghost/heartbeat")
      .send(makeSignedHeartbeat(operator, { nodeId: "ghost" }));

    // 400 here is what silently killed the mesh: the daemon would never retry registration.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("still rejects a forged heartbeat with 401, not 404", async () => {
    // The 404 path must not become a way to skip signature verification for a known node.
    const { app } = await withRegisteredNode();
    const res = await request(app)
      .post("/v1/nodes/node-alpha/heartbeat")
      .send(makeSignedHeartbeat(makeOperator()));
    expect(res.status).toBe(401);
  });
});
