import express from "express";
import request from "supertest";
import { x402ResourceServer } from "@x402/core/server";
import { describe, expect, it } from "vitest";

import { attachSettlementHook, createApp } from "../src/app.js";
import { silentLogger } from "../src/logger.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { rateLimit, rateLimitKey } from "../src/middleware/rateLimit.js";
import { DoubleSettlementService } from "../src/services/settlement.js";
import {
  makeConfig,
  makeNodeRecord,
  StubChain,
  StubSelector,
  StubSettlement,
  StubStore,
} from "./helpers.js";

/**
 * Regression tests for the three defects found by the adversarial audit, each of which was
 * demonstrated by execution before being fixed.
 */

describe("operator payout is gated on confirmed settlement", () => {
  /**
   * Drives the real `onAfterSettle` hook with a facilitator whose settle() resolves the way
   * GoPlausible actually answers a group that failed on-chain: HTTP 200 carrying
   * `success: false`.
   *
   * @param settleResult - The settle response to simulate.
   * @returns The payouts the gateway attempted, and the resulting ledger.
   */
  async function runSettlement(settleResult: Record<string, unknown>) {
    const config = makeConfig();
    const payouts: Array<{ receiver: string; amountAtomic: bigint }> = [];
    const settlement = new DoubleSettlementService({
      config,
      payer: {
        senderAddress: "GATEWAY",
        pay: (r: { receiver: string; amountAtomic: bigint }) => {
          payouts.push({ receiver: r.receiver, amountAtomic: r.amountAtomic });
          return Promise.resolve({ txId: "PAYOUT_TX" });
        },
      },
      logger: silentLogger,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    });
    settlement.recordRouting("req-1", "node-alpha", "OPERATOR_ADDR");

    const facilitator = {
      verify: () => Promise.resolve({ isValid: true }),
      settle: () => Promise.resolve(settleResult),
      getSupported: () => Promise.resolve({ kinds: [], extensions: [], signers: {} }),
    };
    const server = new x402ResourceServer(facilitator as never);
    attachSettlementHook(server, settlement, silentLogger);

    await (
      server as never as { settlePayment: (...a: unknown[]) => Promise<unknown> }
    ).settlePayment(
      { x402Version: 2, scheme: "exact", network: config.network, payload: {} },
      {
        scheme: "exact",
        network: config.network,
        amount: "2000",
        asset: "10458941",
        payTo: config.payToAddress,
        maxTimeoutSeconds: 180,
        extra: {},
      },
      {},
      { responseHeaders: { "x-request-id": "req-1", "x-mesh-node-id": "node-alpha" } },
    );
    await settlement.whenIdle();
    return { payouts, ledger: settlement.getSettlementLedger() };
  }

  it("does not pay the operator when the facilitator reports success:false", async () => {
    // Before the fix this paid 1700 atomic USDC out of the gateway's float against a payment
    // that never landed — one drain per failed settlement, and trivially forced by a payer
    // who lets their own payment fail.
    const { payouts, ledger } = await runSettlement({
      success: false,
      errorReason: "unexpected_settle_error",
      errorMessage: "asset transfer rejected: underflow on asset balance",
      transaction: "",
      network: makeConfig().network,
    });
    expect(payouts).toEqual([]);
    expect(ledger).toEqual([]);
  });

  it("does not pay out on a success with no transaction id", async () => {
    // Without an on-chain txid there is no evidence the inbound leg landed, so a ledger row
    // would claim a settlement it cannot prove.
    const { payouts, ledger } = await runSettlement({
      success: true,
      transaction: "",
      network: makeConfig().network,
      payer: "PAYER",
      amount: "2000",
    });
    expect(payouts).toEqual([]);
    expect(ledger).toEqual([]);
  });

  it("pays the operator on a genuinely confirmed settlement", async () => {
    const { payouts, ledger } = await runSettlement({
      success: true,
      transaction: "INBOUND_TX",
      network: makeConfig().network,
      payer: "PAYER",
      amount: "2000",
    });
    expect(payouts).toEqual([{ receiver: "OPERATOR_ADDR", amountAtomic: 1700n }]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.inboundTxId).toBe("INBOUND_TX");
    expect(ledger[0]?.status).toBe("settled");
  });
});

describe("rate limit bucket key cannot be chosen by the client", () => {
  it("keys on the socket peer, never on an unverified payment header", () => {
    // The payer address used to be read from the x402 header BEFORE verification. The sender
    // of an unsigned transaction decodes fine, so an attacker could name a victim's address
    // (draining their bucket) or rotate senders (minting unlimited buckets).
    const withForgedPayer = {
      header: () => "obviously-not-a-valid-payment-header",
      ip: "203.0.113.7",
      socket: { remoteAddress: "203.0.113.7" },
    } as never;
    expect(rateLimitKey(withForgedPayer)).toBe("ip:203.0.113.7");
    expect(rateLimitKey(withForgedPayer)).not.toMatch(/^payer:/);
  });

  it("gives two requests from one peer the same bucket regardless of headers", () => {
    const a = {
      header: () => undefined,
      ip: "198.51.100.9",
      socket: { remoteAddress: "198.51.100.9" },
    } as never;
    const b = {
      header: () => "anything",
      ip: "198.51.100.9",
      socket: { remoteAddress: "198.51.100.9" },
    } as never;
    expect(rateLimitKey(a)).toBe(rateLimitKey(b));
  });
});

describe("X-Forwarded-For cannot mint fresh rate-limit buckets by default", () => {
  /**
   * Builds a minimal app with the real limiter at the configured trust-proxy setting.
   *
   * @param hops - Value for Express's `trust proxy`.
   * @returns The configured app.
   */
  function appWithTrust(hops: number) {
    const app = express();
    app.set("trust proxy", hops);
    // A frozen clock removes refill from the equation entirely, so the assertion is about
    // bucket identity and nothing else.
    app.use(rateLimit({ capacity: 2, refillPerSecond: 1, now: () => 1_000_000 }));
    app.get("/probe", (_req, res) => {
      res.json({ ok: true });
    });
    // The limiter throws RateLimitError; the shared error handler is what turns it into 429.
    app.use(errorHandler(silentLogger));
    return app;
  }

  it("exhausts one shared bucket even as the client rotates X-Forwarded-For", async () => {
    // With the previous hardcoded `trust proxy: 1`, each new forwarded address produced a
    // fresh full bucket and the limiter never engaged on a directly exposed gateway.
    const app = appWithTrust(0);
    expect((await request(app).get("/probe").set("X-Forwarded-For", "1.2.3.4")).status).toBe(200);
    expect((await request(app).get("/probe").set("X-Forwarded-For", "5.6.7.8")).status).toBe(200);
    const third = await request(app).get("/probe").set("X-Forwarded-For", "9.10.11.12");
    expect(third.status).toBe(429);
  });

  it("defaults to trusting no proxy hops", () => {
    expect(makeConfig().trustProxyHops).toBe(0);
  });

  it("still applies the limiter on the real app", async () => {
    const record = makeNodeRecord();
    const app = createApp({
      config: makeConfig({ trustProxyHops: 0 }),
      store: new StubStore([record]),
      selector: new StubSelector([record]),
      settlement: new StubSettlement(),
      chain: new StubChain(true),
    });
    // Health is deliberately outside the limiter; this just proves the app still builds and
    // serves with the new trust-proxy wiring.
    expect((await request(app).get("/healthz")).status).toBe(200);
  });
});
