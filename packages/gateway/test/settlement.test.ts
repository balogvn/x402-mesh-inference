import { describe, expect, it, vi } from "vitest";
import { computeSplit, usdcToAtomic } from "@x402-mesh/shared";
import type { x402ResourceServer } from "@x402/core/server";
import { attachSettlementHook } from "../src/app.js";
import { silentLogger } from "../src/logger.js";
import type { Logger } from "../src/logger.js";
import { DoubleSettlementService } from "../src/services/settlement.js";
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

    expect(payer.payments).toHaveLength(3);
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
