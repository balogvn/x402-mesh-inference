import { describe, expect, it } from "vitest";
import request from "supertest";
import { ALGORAND_TESTNET, usdcAssetId } from "@x402-mesh/shared";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createApp } from "../src/app.js";
import { buildResourceServer } from "../src/x402/server.js";
import {
  makeConfig,
  makeNodeRecord,
  StubFacilitator,
  StubSelector,
  StubSettlement,
  StubStore,
  TEST_PAY_TO,
} from "./helpers.js";

/**
 * The paywall itself: an unpaid caller must be told precisely what to pay, and the free
 * surface must stay free.
 */

function buildApp() {
  const config = makeConfig();
  const node = makeNodeRecord();
  const settlement = new StubSettlement();
  return {
    config,
    settlement,
    app: createApp({
      config,
      store: new StubStore([node]),
      selector: new StubSelector([node]),
      settlement,
      resourceServer: buildResourceServer(config, new StubFacilitator()),
      // The stub facilitator answers `getSupported` in memory, so the sync is free and
      // exercises the same code path production takes.
      syncFacilitatorOnStart: true,
    }),
  };
}

describe("402 payment required", () => {
  it("rejects an unpaid chat completion with a well-formed payment requirement", async () => {
    const { app, config } = buildApp();

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("accept", "application/json")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(402);

    // x402 v2 carries the machine-readable requirement in the `payment-required` header;
    // the body is free for the human/agent-readable preview.
    const header = response.headers["payment-required"];
    expect(header, "402 must carry a payment-required header").toBeDefined();
    const required = decodePaymentRequiredHeader(header as string);

    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);

    const requirement = required.accepts[0];
    expect(requirement).toBeDefined();
    expect(requirement?.scheme).toBe("exact");
    expect(requirement?.network).toBe(ALGORAND_TESTNET);
    expect(requirement?.payTo).toBe(TEST_PAY_TO);
    // $0.0020 with 6 decimals is exactly 2000 atomic units — integer, never a float.
    expect(requirement?.amount).toBe("2000");
    expect(requirement?.asset).toBe(usdcAssetId(config.network));
    expect(requirement?.maxTimeoutSeconds).toBeGreaterThanOrEqual(60);
  });

  it("advertises the challenge tag and the Bazaar declaration for discovery", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("accept", "application/json")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    const required = decodePaymentRequiredHeader(response.headers["payment-required"] as string);
    expect(required.resource?.tags).toContain("x402-global-challenge");

    // `declareDiscoveryExtension` returns a record already keyed `bazaar`; assigning it
    // directly (rather than re-wrapping) is what keeps this a single level deep.
    const bazaar = required.extensions?.["bazaar"] as { info?: { input?: { method?: string } } };
    expect(bazaar).toBeDefined();
    expect(bazaar.info?.input?.method).toBe("POST");
  });

  it("teaches an unpaid caller how to pay via the preview body", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("accept", "application/json")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(402);
    const serialized = JSON.stringify(response.body);
    expect(serialized).toContain("0.0020");
    expect(serialized).toContain(ALGORAND_TESTNET);
    expect(serialized).toContain(TEST_PAY_TO);
    expect(response.body.howToPay.join(" ")).toContain("opted in");
  });

  it("echoes a server-generated request id", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("x-request-id", "client-supplied-id")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

    const echoed = response.headers["x-request-id"];
    expect(echoed).toBeDefined();
    // A client-supplied id is ignored: it keys settlement idempotency, so honouring it would
    // let one payer suppress another payer's operator payout.
    expect(echoed).not.toBe("client-supplied-id");
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("leaves the free surface unguarded", async () => {
    const { app } = buildApp();

    for (const path of ["/healthz", "/.well-known/x402", "/llms.txt", "/v1/nodes"]) {
      const response = await request(app).get(path);
      expect(response.status, `${path} should not be paywalled`).toBe(200);
    }
  });
});

describe("health endpoints", () => {
  it("reports liveness without touching any dependency", async () => {
    const config = makeConfig();
    const settlement = new StubSettlement();
    const app = createApp({
      config,
      store: new StubStore(),
      selector: new StubSelector([]),
      settlement,
      // No resource server and no probes: /healthz must still answer.
    });

    const response = await request(app).get("/healthz");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.network).toBe(ALGORAND_TESTNET);
  });

  it("reports ready when every dependency answers", async () => {
    const config = makeConfig();
    const node = makeNodeRecord();
    const app = createApp({
      config,
      store: new StubStore([node]),
      selector: new StubSelector([node]),
      settlement: new StubSettlement(),
      probeFacilitator: () => Promise.resolve({ ok: true, detail: "stub" }),
      probeWallet: () => Promise.resolve({ ok: true, detail: "1000000 microAlgo" }),
    });

    const response = await request(app).get("/readyz");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ready");
    expect(response.body.checks.store.detail).toContain("1/1 nodes routable");
  });

  it("reports not ready when the facilitator is unreachable", async () => {
    const config = makeConfig();
    const app = createApp({
      config,
      store: new StubStore(),
      selector: new StubSelector([]),
      settlement: new StubSettlement(),
      probeFacilitator: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });

    const response = await request(app).get("/readyz");
    expect(response.status).toBe(503);
    expect(response.body.status).toBe("not_ready");
    expect(response.body.checks.facilitator.ok).toBe(false);
    expect(response.body.checks.facilitator.detail).toContain("ECONNREFUSED");
  });

  it("reports not ready when the payout wallet is underfunded", async () => {
    const config = makeConfig();
    const app = createApp({
      config,
      store: new StubStore(),
      selector: new StubSelector([]),
      settlement: new StubSettlement(),
      probeFacilitator: () => Promise.resolve({ ok: true }),
      probeWallet: () => Promise.resolve({ ok: false, detail: "0 microAlgo" }),
    });

    const response = await request(app).get("/readyz");
    expect(response.status).toBe(503);
    expect(response.body.checks.wallet.ok).toBe(false);
  });

  it("publishes the economics it actually settles with", async () => {
    const config = makeConfig();
    const app = createApp({
      config,
      store: new StubStore(),
      selector: new StubSelector([]),
      settlement: new StubSettlement(),
    });

    const response = await request(app).get("/v1/settlements");
    expect(response.status).toBe(200);
    const { economics } = response.body;
    expect(economics.inboundAtomic).toBe("2000");
    expect(economics.payoutAtomic).toBe("1700");
    expect(economics.marginAtomic).toBe("300");
    expect(BigInt(economics.inboundAtomic) - BigInt(economics.payoutAtomic)).toBe(
      BigInt(economics.marginAtomic),
    );
  });
});
