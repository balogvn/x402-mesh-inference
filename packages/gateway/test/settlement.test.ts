import { describe, expect, it, vi } from "vitest";
import { computeSplit, usdcToAtomic } from "@x402-mesh/shared";
import type { x402ResourceServer } from "@x402/core/server";
import { attachSettlementHook } from "../src/app.js";
import { silentLogger } from "../src/logger.js";
import type { Logger } from "../src/logger.js";
import { DEFAULT_RETRY_POLICY, DoubleSettlementService } from "@x402-mesh/settlement";
import { makeClock, makeConfig, makeNodeRecord, StubPayer, StubSettlement } from "./helpers.js";

/**
 * Settlement is where the money is, so these tests are about invariants rather than plumbing:
 * the split must be exact, a request must never be paid twice, and a failed payout must be
 * loud, recorded and non-fatal to the client.
 */

const NODE = makeNodeRecord();

function buildService(options: { payer?: StubPayer; logger?: Logger } = {}) {
  const payer = options.payer ?? new StubPayer();
  const clock = makeClock();
  const service = new DoubleSettlementService({
    config: makeConfig(),
    payer,
    logger: options.logger ?? silentLogger,
    now: clock.now,
    sleep: () => Promise.resolve(), // retry backoff is instant under test
    random: () => 0.5, // and deterministic
  });
  return { service, payer, clock };
}

function inbound(requestId: string, amount = 2000n) {
  return {
    requestId,
    payerAddress: NODE.registration.operatorAddress,
    inboundTxId: "INBOUNDTX",
    inboundAtomic: amount,
  };
}

describe("split arithmetic", () => {
  it("splits $0.0020 into $0.0017 payout and $0.0003 margin, exactly", () => {
    const split = computeSplit(usdcToAtomic("0.0020"), 1500);
    expect(split.inbound).toBe(2000n);
    expect(split.payout).toBe(1700n);
    expect(split.margin).toBe(300n);
    expect(split.inbound - split.payout).toBe(split.margin);
  });

  it("records the split on the ledger entry with the invariant intact", async () => {
    const { service } = buildService();
    service.recordRouting("req-1", NODE.registration.nodeId, NODE.registration.operatorAddress);
    service.settleInbound(inbound("req-1"));
    await service.whenIdle();

    const record = service.getRecord("req-1");
    expect(record).toBeDefined();
    expect(record?.inboundAtomic).toBe("2000");
    expect(record?.payoutAtomic).toBe("1700");
    expect(record?.marginAtomic).toBe("300");
    expect(BigInt(record!.inboundAtomic) - BigInt(record!.payoutAtomic)).toBe(
      BigInt(record!.marginAtomic),
    );
    expect(record?.status).toBe("settled");
    expect(record?.payoutTxId).toBe("PAYOUTTX-1");
  });

  it("gives any sub-atomic remainder to the operator, never to the gateway", async () => {
    const { service, payer } = buildService();
    service.recordRouting("req-odd", NODE.registration.nodeId, NODE.registration.operatorAddress);
    // 333 * 1500 / 10000 = 49.95, which floors to 49 margin and leaves 284 to the operator.
    service.settleInbound(inbound("req-odd", 333n));
    await service.whenIdle();

    const record = service.getRecord("req-odd");
    expect(record?.payoutAtomic).toBe("284");
    expect(record?.marginAtomic).toBe("49");
    expect(payer.payments[0]?.amountAtomic).toBe(284n);
  });

  it("pays in integer atomic units, never a float", async () => {
    const { service, payer } = buildService();
    service.recordRouting("req-2", NODE.registration.nodeId, NODE.registration.operatorAddress);
    service.settleInbound(inbound("req-2"));
    await service.whenIdle();

    expect(typeof payer.payments[0]?.amountAtomic).toBe("bigint");
    expect(payer.payments[0]?.amountAtomic).toBe(1700n);
    expect(payer.payments[0]?.assetId).toBe("10458941");
  });
});

describe("idempotency", () => {
  it("pays exactly once for a repeated requestId", async () => {
    const { service, payer } = buildService();
    service.recordRouting("req-dup", NODE.registration.nodeId, NODE.registration.operatorAddress);

    service.settleInbound(inbound("req-dup"));
    // A duplicate settlement callback — the exact scenario a facilitator retry produces.
    service.recordRouting("req-dup", NODE.registration.nodeId, NODE.registration.operatorAddress);
    service.settleInbound(inbound("req-dup"));
    await service.whenIdle();

    expect(payer.payments).toHaveLength(1);
    expect(service.getSettlementLedger()).toHaveLength(1);
  });

  it("claims the request id synchronously so concurrent callbacks cannot race", async () => {
    const { service, payer } = buildService();
    service.recordRouting("req-race", NODE.registration.nodeId, NODE.registration.operatorAddress);

    // Both calls happen in the same synchronous turn; only the claim-then-check ordering
    // inside settleInbound prevents a double payout here.
    service.settleInbound(inbound("req-race"));
    service.recordRouting("req-race", NODE.registration.nodeId, NODE.registration.operatorAddress);
    service.settleInbound(inbound("req-race"));
    await service.whenIdle();

    expect(payer.payments).toHaveLength(1);
  });

  it("skips the payout entirely when no routing note exists", async () => {
    const { service, payer } = buildService();

    // Money arrived for a request no node was ever chosen for.
    service.settleInbound(inbound("req-orphan"));
    await service.whenIdle();

    expect(payer.payments).toHaveLength(0);
    expect(service.getRecord("req-orphan")).toBeUndefined();
  });
});

describe("retry and failure", () => {
  it("retries with backoff and succeeds on the third attempt", async () => {
    const payer = new StubPayer(2);
    const { service } = buildService({ payer });
    service.recordRouting("req-flaky", NODE.registration.nodeId, NODE.registration.operatorAddress);

    service.settleInbound(inbound("req-flaky"));
    await service.whenIdle();

    expect(payer.payments).toHaveLength(3);
    expect(service.getRecord("req-flaky")?.status).toBe("settled");
    expect(service.getRecord("req-flaky")?.payoutTxId).toBe("PAYOUTTX-3");
  });

  it("marks the record failed and raises an operator alert after exhausting retries", async () => {
    const errors: Array<Record<string, unknown>> = [];
    const logger: Logger = {
      ...silentLogger,
      error: (obj) => {
        errors.push(obj);
      },
      child: () => logger,
    };
    const payer = new StubPayer(99);
    const { service } = buildService({ payer, logger });
    service.recordRouting("req-dead", NODE.registration.nodeId, NODE.registration.operatorAddress);

    service.settleInbound(inbound("req-dead"));
    await service.whenIdle();

    // Derived from the policy rather than hardcoded: this assertion pinned the old
    // 3-attempt backoff and would silently fight the next tuning change.
    expect(payer.payments).toHaveLength(DEFAULT_RETRY_POLICY.attempts);
    const record = service.getRecord("req-dead");
    expect(record?.status).toBe("failed");
    expect(record?.payoutTxId).toBeNull();
    expect(record?.error).toContain("algod unavailable");

    // The alert has to carry everything needed to replay the payout by hand.
    const alert = errors.find((e) => e["alert"] === "payout_failed");
    expect(alert).toBeDefined();
    expect(alert?.["operatorAddress"]).toBe(NODE.registration.operatorAddress);
    expect(alert?.["payoutAtomic"]).toBe("1700");
    expect(alert?.["inboundTxId"]).toBe("INBOUNDTX");
  });

  it("never throws out of settleInbound, whatever the payer does", async () => {
    const payer = new StubPayer(99);
    const { service } = buildService({ payer });
    service.recordRouting("req-safe", NODE.registration.nodeId, NODE.registration.operatorAddress);

    // A throw here would surface to the client on a payment that in fact succeeded.
    expect(() => service.settleInbound(inbound("req-safe"))).not.toThrow();
    await service.whenIdle();
  });

  it("records a settled entry with no transaction when the payout rounds to zero", async () => {
    const payer = new StubPayer();
    const service = new DoubleSettlementService({
      config: makeConfig({ marginBps: 10_000 }), // 100% margin: nothing is owed
      payer,
      logger: silentLogger,
      sleep: () => Promise.resolve(),
    });
    service.recordRouting("req-zero", NODE.registration.nodeId, NODE.registration.operatorAddress);

    service.settleInbound(inbound("req-zero"));
    await service.whenIdle();

    expect(payer.payments).toHaveLength(0);
    expect(service.getRecord("req-zero")?.status).toBe("settled");
    expect(service.getRecord("req-zero")?.payoutAtomic).toBe("0");
    expect(service.getRecord("req-zero")?.marginAtomic).toBe("2000");
  });
});

describe("ledger", () => {
  it("returns entries newest first and stays bounded", async () => {
    const payer = new StubPayer();
    const service = new DoubleSettlementService({
      config: makeConfig(),
      payer,
      logger: silentLogger,
      sleep: () => Promise.resolve(),
      maxLedgerEntries: 3,
    });

    for (let i = 0; i < 5; i += 1) {
      service.recordRouting(
        `req-${i}`,
        NODE.registration.nodeId,
        NODE.registration.operatorAddress,
      );
      service.settleInbound(inbound(`req-${i}`));
    }
    await service.whenIdle();

    const ledger = service.getSettlementLedger();
    expect(ledger).toHaveLength(3);
    expect(ledger[0]?.requestId).toBe("req-4");
    expect(ledger[2]?.requestId).toBe("req-2");
  });
});

describe("attachSettlementHook", () => {
  /** Captures the hook the app registers, so it can be driven with a synthetic context. */
  function captureHook() {
    let hook: ((context: unknown) => Promise<void>) | undefined;
    const resourceServer = {
      onAfterSettle: (fn: (context: unknown) => Promise<void>) => {
        hook = fn;
        return resourceServer;
      },
    } as unknown as x402ResourceServer;
    const settlement = new StubSettlement();
    attachSettlementHook(resourceServer, settlement, silentLogger);
    return { hook: hook!, settlement };
  }

  it("correlates the settled payment back to the request via the response headers", async () => {
    const { hook, settlement } = captureHook();

    await hook({
      result: { success: true, transaction: "TXABC", payer: "PAYERADDR", network: "algorand:x" },
      requirements: { amount: "2000" },
      transportContext: {
        responseHeaders: { "x-request-id": "req-77", "x-mesh-node-id": "node-a" },
      },
    });

    expect(settlement.inbound).toHaveLength(1);
    expect(settlement.inbound[0]?.requestId).toBe("req-77");
    expect(settlement.inbound[0]?.inboundTxId).toBe("TXABC");
    expect(settlement.inbound[0]?.payerAddress).toBe("PAYERADDR");
    expect(settlement.inbound[0]?.inboundAtomic).toBe(2000n);
  });

  it("prefers the actually-settled amount over the advertised requirement", async () => {
    const { hook, settlement } = captureHook();

    await hook({
      // A partial settlement: the client was charged less than the advertised maximum, so
      // the operator's share must be computed from what actually moved.
      result: { success: true, transaction: "TXABC", amount: "1000", network: "algorand:x" },
      requirements: { amount: "2000" },
      transportContext: { responseHeaders: { "x-request-id": "req-78" } },
    });

    expect(settlement.inbound[0]?.inboundAtomic).toBe(1000n);
  });

  it("does not throw when the request id is missing", async () => {
    const { hook, settlement } = captureHook();
    const spy = vi.fn();

    await expect(
      hook({
        result: { success: true, transaction: "TXABC", network: "algorand:x" },
        requirements: { amount: "2000" },
        transportContext: { responseHeaders: {} },
      }).then(spy),
    ).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalled();
    expect(settlement.inbound).toHaveLength(0);
  });
});

/**
 * Regression: the payout backoff must outlast Algorand block finality.
 *
 * The payout spends the USDC the inbound leg just delivered, and that money is not spendable
 * until the inbound transaction is final — about one 2.8s block. The old policy ran three
 * attempts over ~0.75s, so a gateway wallet holding no float failed its very first payout
 * every time: "underflow on subtracting 1700 from sender amount 0". Observed in production —
 * client charged, operator unpaid, all three attempts inside one second.
 */
describe("payout retry policy", () => {
  /** One Algorand block, the floor any funds-related retry has to clear. */
  const ALGORAND_BLOCK_MS = 2_800;

  it("spans more than a single block before giving up", () => {
    let total = 0;
    let delay = DEFAULT_RETRY_POLICY.baseDelayMs;
    for (let i = 1; i < DEFAULT_RETRY_POLICY.attempts; i++) {
      total += Math.min(delay, DEFAULT_RETRY_POLICY.maxDelayMs);
      delay *= 2;
    }
    expect(total).toBeGreaterThan(ALGORAND_BLOCK_MS * 2);
  });

  it("waits at least one block before the first retry", () => {
    // A sub-block first retry is guaranteed to observe the same unfunded balance.
    expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBeGreaterThanOrEqual(ALGORAND_BLOCK_MS);
  });

  it("makes more than two attempts", () => {
    expect(DEFAULT_RETRY_POLICY.attempts).toBeGreaterThanOrEqual(3);
  });
});

/**
 * Regression: a payout that landed on chain must never be recorded as failed.
 *
 * `pay` can submit a transaction successfully and then throw while awaiting confirmation —
 * a timeout, a dropped socket, an algod blip. The money has moved; the caller just never
 * heard so. Observed on Algorand MainNet: payout
 * BRW5GM5FQJJHLICDTTXNJH3BNRBRVP7RCS6C4FMGYTCTRPOCFO4Q was committed while its ledger row
 * read `status: failed, payoutTxId: null`.
 *
 * That is worse than a cosmetic accounting error. The ledger is what an operator reads to
 * check they were paid, and what a reconciliation job reads to decide what to re-send — so a
 * false `failed` both misinforms the operator and invites a double payment.
 */
describe("payout that already landed on chain", () => {
  /** A payer whose submissions always land but whose confirmation read always throws. */
  class LandsThenThrowsPayer {
    readonly senderAddress = "GATEWAY";
    attempts = 0;
    readonly lookups: Array<{ requestId: string; receiver: string }> = [];

    pay(): Promise<{ txId: string }> {
      this.attempts += 1;
      // Submitted fine; the confirmation wait is what fails.
      return Promise.reject(new Error("confirmation timed out"));
    }

    findLandedPayout(requestId: string, receiver: string): Promise<{ txId: string } | undefined> {
      this.lookups.push({ requestId, receiver });
      return Promise.resolve({ txId: "LANDED_TX" });
    }
  }

  it("records it as settled with the on-chain transaction id", async () => {
    const payer = new LandsThenThrowsPayer();
    const { service } = buildService({ payer: payer as never });
    service.recordRouting(
      "req-landed",
      NODE.registration.nodeId,
      NODE.registration.operatorAddress,
    );

    service.settleInbound(inbound("req-landed"));
    await service.whenIdle();

    const record = service.getRecord("req-landed");
    expect(record?.status).toBe("settled");
    expect(record?.payoutTxId).toBe("LANDED_TX");
  });

  it("stops retrying once it discovers the payout landed", async () => {
    const payer = new LandsThenThrowsPayer();
    const { service } = buildService({ payer: payer as never });
    service.recordRouting("req-stop", NODE.registration.nodeId, NODE.registration.operatorAddress);

    service.settleInbound(inbound("req-stop"));
    await service.whenIdle();

    // One attempt, then the chain check ends it — not the full retry budget.
    expect(payer.attempts).toBe(1);
    expect(payer.lookups[0]?.receiver).toBe(NODE.registration.operatorAddress);
  });

  it("still fails honestly when nothing landed", async () => {
    class NothingLandedPayer extends LandsThenThrowsPayer {
      override findLandedPayout(): Promise<{ txId: string } | undefined> {
        return Promise.resolve(undefined);
      }
    }
    const payer = new NothingLandedPayer();
    const { service } = buildService({ payer: payer as never });
    service.recordRouting("req-none", NODE.registration.nodeId, NODE.registration.operatorAddress);

    service.settleInbound(inbound("req-none"));
    await service.whenIdle();

    const record = service.getRecord("req-none");
    expect(record?.status).toBe("failed");
    expect(record?.payoutTxId).toBeNull();
    expect(payer.attempts).toBe(DEFAULT_RETRY_POLICY.attempts);
  });

  it("treats a lookup that throws as unknown rather than as a settlement", async () => {
    class BrokenLookupPayer extends LandsThenThrowsPayer {
      override findLandedPayout(): Promise<{ txId: string } | undefined> {
        return Promise.reject(new Error("indexer unavailable"));
      }
    }
    const payer = new BrokenLookupPayer();
    const { service } = buildService({ payer: payer as never });
    service.recordRouting(
      "req-broken",
      NODE.registration.nodeId,
      NODE.registration.operatorAddress,
    );

    service.settleInbound(inbound("req-broken"));
    await service.whenIdle();

    // A flaky indexer must degrade to the old behaviour, never invent a payout.
    expect(service.getRecord("req-broken")?.status).toBe("failed");
  });
});
