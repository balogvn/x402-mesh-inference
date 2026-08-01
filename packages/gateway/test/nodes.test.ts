import { sign as signEd25519 } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  ALGORAND_MAINNET,
  canonicalRegistrationBytes,
  REGISTRATION_MAX_SKEW_MS,
} from "@x402-mesh/shared";
import { createApp } from "../src/app.js";
import { verifyRegistrationSignature } from "../src/routes/nodes.js";
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
 * Node registration is the mesh's only trust boundary with operators. Each test below pins
 * one defence; removing any of them yields a mesh that works right up until money moves.
 */

function buildApp(options: { optedIn?: boolean; requireUsdcOptIn?: boolean } = {}) {
  const config = makeConfig({ requireUsdcOptIn: options.requireUsdcOptIn ?? true });
  const store = new StubStore();
  const chain = new StubChain(options.optedIn ?? true);
  return {
    store,
    chain,
    config,
    app: createApp({
      config,
      store,
      selector: new StubSelector([]),
      settlement: new StubSettlement(),
      chain,
    }),
  };
}

describe("POST /v1/nodes/register", () => {
  it("accepts a correctly signed, fresh registration from an opted-in operator", async () => {
    const { app, store, chain } = buildApp();
    const operator = makeOperator();
    const signed = makeSignedRegistration(operator);

    const response = await request(app).post("/v1/nodes/register").send(signed);

    expect(response.status).toBe(201);
    expect(response.body.nodeId).toBe("node-alpha");
    expect(response.body.usdcOptedIn).toBe(true);
    expect(response.body.routable).toBe(true);
    expect(store.get("node-alpha")).toBeDefined();
    // The opt-in check queries the TestNet USDC ASA, read from USDC_CONFIG, not hardcoded.
    expect(chain.optInQueries[0]?.assetId).toBe("10458941");
    expect(chain.optInQueries[0]?.address).toBe(operator.address);
  });

  it("rejects a registration whose signature does not verify", async () => {
    const { app, store } = buildApp();
    const operator = makeOperator();
    const signed = makeSignedRegistration(operator);

    // Tamper with a signature-covered field. The endpoint is the interesting one: this is
    // exactly the attack the signature exists to stop.
    const tampered = {
      ...signed,
      registration: { ...signed.registration, endpoint: "https://attacker.test" },
    };

    const response = await request(app).post("/v1/nodes/register").send(tampered);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("auth_error");
    expect(store.get("node-alpha")).toBeUndefined();
  });

  it("rejects a signature made by a key that is not the operator address", async () => {
    const { app } = buildApp();
    const operator = makeOperator();
    const impostor = makeOperator();
    const signed = makeSignedRegistration(operator);

    // A valid signature over the same bytes, but from the wrong key — and the payload
    // honestly declares that key. Verifying against `publicKey` alone would accept this and
    // let the impostor register an endpoint under the operator's payout address.
    const forged = {
      registration: signed.registration,
      signature: signEd25519(
        null,
        Buffer.from(canonicalRegistrationBytes(signed.registration)),
        impostor.privateKey,
      ).toString("base64"),
      publicKey: impostor.publicKeyB64,
    };

    const response = await request(app).post("/v1/nodes/register").send(forged);

    expect(response.status).toBe(401);
    expect(response.body.error.message).toContain("does not match the operator address");
  });

  it("rejects a stale timestamp", async () => {
    const { app } = buildApp();
    const operator = makeOperator();
    const stale = makeSignedRegistration(
      operator,
      {},
      Date.now() - REGISTRATION_MAX_SKEW_MS - 1_000,
    );

    const response = await request(app).post("/v1/nodes/register").send(stale);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
    expect(response.body.error.message).toContain("too old");
  });

  it("rejects a timestamp too far in the future", async () => {
    const { app } = buildApp();
    const operator = makeOperator();
    const future = makeSignedRegistration(
      operator,
      {},
      Date.now() + REGISTRATION_MAX_SKEW_MS + 1_000,
    );

    const response = await request(app).post("/v1/nodes/register").send(future);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("future");
  });

  it("rejects a replayed nonce even when the signature and timestamp are still valid", async () => {
    const { app } = buildApp();
    const operator = makeOperator();
    const signed = makeSignedRegistration(operator);

    const first = await request(app).post("/v1/nodes/register").send(signed);
    expect(first.status).toBe(201);

    // Byte-for-byte replay: freshness still passes, so only the nonce cache can stop it.
    const replay = await request(app).post("/v1/nodes/register").send(signed);

    expect(replay.status).toBe(400);
    expect(replay.body.error.message).toContain("nonce has already been used");
  });

  it("rejects an operator that has not opted in to USDC, with actionable remediation", async () => {
    const { app, store } = buildApp({ optedIn: false });
    const operator = makeOperator();

    const response = await request(app)
      .post("/v1/nodes/register")
      .send(makeSignedRegistration(operator));

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("opted in to USDC");
    expect(response.body.error.details.assetId).toBe("10458941");
    expect(response.body.error.details.remedy).toContain("opt-in");
    expect(store.get("node-alpha")).toBeUndefined();
  });

  it("admits a non-opted-in operator when the deployment does not require opt-in", async () => {
    const { app, store } = buildApp({ optedIn: false, requireUsdcOptIn: false });
    const operator = makeOperator();

    const response = await request(app)
      .post("/v1/nodes/register")
      .send(makeSignedRegistration(operator));

    expect(response.status).toBe(201);
    expect(response.body.usdcOptedIn).toBe(false);
    expect(store.get("node-alpha")?.usdcOptedIn).toBe(false);
  });

  it("rejects a node that settles on a different network", async () => {
    const { app } = buildApp();
    const operator = makeOperator();

    const response = await request(app)
      .post("/v1/nodes/register")
      .send(makeSignedRegistration(operator, { network: ALGORAND_MAINNET }));

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("different network");
  });

  it("refuses to let a second operator claim an existing node id", async () => {
    const { app } = buildApp();
    const first = makeOperator();
    const second = makeOperator();

    await request(app).post("/v1/nodes/register").send(makeSignedRegistration(first));
    const hijack = await request(app)
      .post("/v1/nodes/register")
      .send(makeSignedRegistration(second));

    expect(hijack.status).toBe(401);
    expect(hijack.body.error.message).toContain("already registered to a different operator");
  });

  it("preserves lifetime counters across a re-registration", async () => {
    const { app, store } = buildApp();
    const operator = makeOperator();

    await request(app).post("/v1/nodes/register").send(makeSignedRegistration(operator));
    const existing = store.get("node-alpha");
    expect(existing).toBeDefined();
    store.upsert({ ...existing!, totalRequests: 42, totalPaidAtomic: "71400" });

    const again = await request(app)
      .post("/v1/nodes/register")
      .send(makeSignedRegistration(operator, { endpoint: "https://node-alpha-v2.test" }));

    expect(again.status).toBe(200);
    expect(store.get("node-alpha")?.totalRequests).toBe(42);
    expect(store.get("node-alpha")?.totalPaidAtomic).toBe("71400");
    expect(store.get("node-alpha")?.registration.endpoint).toBe("https://node-alpha-v2.test");
  });

  it("rejects a structurally invalid registration", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/v1/nodes/register")
      .send({ registration: { nodeId: "x" }, signature: "nope", publicKey: "nope" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });
});

describe("verifyRegistrationSignature", () => {
  it("round-trips a real Ed25519 signature through the SPKI-wrapped address key", () => {
    const operator = makeOperator();
    const signed = makeSignedRegistration(operator);

    // The whole point: an Algorand address *is* an Ed25519 public key, so node:crypto can
    // verify an operator signature with no third-party crypto dependency.
    expect(() => verifyRegistrationSignature(signed)).not.toThrow();
  });

  it("rejects a signature over different bytes", () => {
    const operator = makeOperator();
    const signed = makeSignedRegistration(operator);
    const other = makeSignedRegistration(operator, { nodeId: "node-beta" });

    expect(() => verifyRegistrationSignature({ ...signed, signature: other.signature })).toThrow(
      /signature verification failed/,
    );
  });
});

describe("POST /v1/nodes/:id/heartbeat", () => {
  it("refreshes liveness for a registered node", async () => {
    const { app, store } = buildApp();
    const operator = makeOperator();
    await request(app).post("/v1/nodes/register").send(makeSignedRegistration(operator));

    const before = store.get("node-alpha")?.health.lastSeenAt ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const response = await request(app)
      .post("/v1/nodes/node-alpha/heartbeat")
      .send(makeSignedHeartbeat(operator));

    expect(response.status).toBe(200);
    expect(response.body.healthy).toBe(true);
    expect(store.get("node-alpha")!.health.lastSeenAt).toBeGreaterThan(before);
  });

  it("rejects a heartbeat from an unregistered node", async () => {
    const { app } = buildApp();
    const operator = makeOperator();

    const response = await request(app)
      .post("/v1/nodes/ghost/heartbeat")
      .send(makeSignedHeartbeat(operator, { nodeId: "ghost" }));

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("register before sending heartbeats");
  });
});

describe("GET /v1/nodes", () => {
  it("publishes registrations while withholding internal counters", async () => {
    const { app } = buildApp();
    const operator = makeOperator();
    await request(app).post("/v1/nodes/register").send(makeSignedRegistration(operator));

    const response = await request(app).get("/v1/nodes");

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
    const node = response.body.nodes[0];
    expect(node.nodeId).toBe("node-alpha");
    expect(node.operatorAddress).toBe(operator.address);
    expect(node.capabilities[0].model).toBe("llama3.1:8b");
    // Internal accounting stays internal.
    expect(node.inFlight).toBeUndefined();
    expect(node.consecutiveFailures).toBeUndefined();
    expect(node.totalPaidAtomic).toBeUndefined();
    expect(node.totalRequests).toBeUndefined();
  });
});
