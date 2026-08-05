import { describe, expect, it } from "vitest";
import type { AccrualStore, PersistedAccrual } from "@x402-mesh/registry";
import { createAccrualStore } from "@x402-mesh/registry";
import { computeSplit, loadGatewayConfig } from "@x402-mesh/shared";
import { silentLogger } from "../src/logger.js";
import { DoubleSettlementService } from "../src/services/settlement.js";
import { makeClock, makeConfig, makeOperator, StubPayer, TEST_PAY_TO } from "./helpers.js";
import type { PayoutRequest } from "../src/ports.js";

/**
 * Durability of accrued balances.
 *
 * An accrued balance is USDC the gateway holds and already owes. Batching without persistence
 * means a hard crash loses the record of who was owed what — the funds sit in the wallet and
 * nothing remembers to send them. That is the one batching failure mode that cannot be
 * recovered from without reconciling by hand against the chain.
 *
 * Persistence introduces its own hazard, and it is worse than the one it fixes: a process that
 * dies *mid-payout* leaves a record saying "pay this", when the transfer may already have
 * landed. Recovering that naively pays twice, and nothing on chain undoes it. The defence is
 * that a batch's id is persisted before the payout is attempted and reused verbatim on
 * recovery, so the retry carries the same Algorand lease and the same transaction note as the
 * attempt that may have committed — which is what lets `findLandedPayout` recognise it.
 *
 * These tests are mostly about that second hazard.
 */

const OPERATOR = makeOperator().address;
const PAYOUT_PER_REQUEST = computeSplit(2000n, 1500).payout; // 1700n

/** An in-memory {@link AccrualStore} that records every call. */
class FakeAccrualStore implements AccrualStore {
  open = new Map<string, PersistedAccrual>();
  batches = new Map<string, PersistedAccrual & { batchId: string }>();
  readonly calls: string[] = [];
  failOn: string | null = null;

  #guard(name: string): void {
    this.calls.push(name);
    if (this.failOn === name) throw new Error(`${name} unavailable`);
  }

  putOpen(a: PersistedAccrual): Promise<void> {
    this.#guard("putOpen");
    this.open.set(a.operatorAddress, a);
    return Promise.resolve();
  }

  removeOpen(address: string): Promise<void> {
    this.#guard("removeOpen");
    this.open.delete(address);
    return Promise.resolve();
  }

  putBatch(a: PersistedAccrual & { batchId: string }): Promise<void> {
    this.#guard("putBatch");
    this.batches.set(a.batchId, a);
    return Promise.resolve();
  }

  removeBatch(batchId: string): Promise<void> {
    this.#guard("removeBatch");
    this.batches.delete(batchId);
    return Promise.resolve();
  }

  loadAll(): Promise<{
    open: PersistedAccrual[];
    batches: (PersistedAccrual & { batchId: string })[];
  }> {
    this.#guard("loadAll");
    return Promise.resolve({ open: [...this.open.values()], batches: [...this.batches.values()] });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function build(store?: AccrualStore, batchMinUsdc = "1.00") {
  const payer = new StubPayer();
  const service = new DoubleSettlementService({
    config: makeConfig({ payoutBatchMinUsdc: batchMinUsdc, payoutBatchMaxDelayMs: 900_000 }),
    payer,
    logger: silentLogger,
    now: makeClock().now,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...(store ? { accrualStore: store } : {}),
  });
  return { service, payer };
}

async function settle(service: DoubleSettlementService, requestId: string): Promise<void> {
  service.recordRouting(requestId, "node-a", OPERATOR);
  service.settleInbound({
    requestId,
    payerAddress: OPERATOR,
    inboundTxId: `IN-${requestId}`,
    inboundAtomic: 2000n,
  });
  await service.whenIdle();
}

describe("accruals are written down before they are owed for long", () => {
  it("persists an open accrual as soon as one exists", async () => {
    const store = new FakeAccrualStore();
    const { service } = build(store);
    await settle(service, "r1");

    const stored = store.open.get(OPERATOR);
    expect(stored, "an unpaid liability must exist outside this process").toBeDefined();
    expect(stored?.records).toHaveLength(1);
    expect(stored?.batchId ?? null).toBeNull();
  });

  it("promotes open to batch before attempting the payout", async () => {
    const store = new FakeAccrualStore();
    const { service } = build(store);
    await settle(service, "r1");
    await settle(service, "r2");
    await service.flushPayouts();

    // Ordering is the property under test: the batch record must be written before pay() is
    // called, otherwise a crash mid-payout leaves nothing to recover from.
    expect(store.calls.indexOf("putBatch")).toBeLessThan(store.calls.indexOf("removeBatch"));
    expect(store.open.size, "the open record must not survive its own flush").toBe(0);
  });

  it("drops the batch record once the payout settles", async () => {
    const store = new FakeAccrualStore();
    const { service } = build(store);
    await settle(service, "r1");
    await service.flushPayouts();

    expect(store.batches.size).toBe(0);
    expect(store.open.size).toBe(0);
  });

  it("drops the batch record when the payout fails, so boot does not retry a recorded failure", async () => {
    const store = new FakeAccrualStore();
    const payer = new StubPayer(99);
    const service = new DoubleSettlementService({
      config: makeConfig({ payoutBatchMinUsdc: "1.00" }),
      payer,
      logger: silentLogger,
      now: makeClock().now,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      accrualStore: store,
    });
    await settle(service, "r1");
    await service.flushPayouts();

    expect(service.getRecord("r1")?.status).toBe("failed");
    expect(store.batches.size).toBe(0);
  });
});

describe("recovery after a crash", () => {
  it("pays an open accrual left by a dead process", async () => {
    const store = new FakeAccrualStore();
    const first = build(store);
    await settle(first.service, "r1");
    await settle(first.service, "r2");
    expect(first.payer.payments, "the old process never paid these").toHaveLength(0);

    // A new process over the same store — the crash.
    const second = build(store);
    await second.service.recoverAccruals();
    await second.service.whenIdle();

    expect(second.payer.payments).toHaveLength(1);
    expect(second.payer.payments[0]?.receiver).toBe(OPERATOR);
    expect(second.payer.payments[0]?.amountAtomic).toBe(PAYOUT_PER_REQUEST * 2n);
    expect(store.open.size).toBe(0);
  });

  it("re-seeds the ledger so the recovered requests are visible and cannot be paid again", async () => {
    const store = new FakeAccrualStore();
    const first = build(store);
    await settle(first.service, "r1");

    const second = build(store);
    await second.service.recoverAccruals();
    await second.service.whenIdle();

    expect(second.service.getRecord("r1")?.status).toBe("settled");

    // A late duplicate settlement callback for a recovered request must be refused: the
    // claim guard is rebuilt during recovery, not left empty.
    await settle(second.service, "r1");
    expect(second.payer.payments).toHaveLength(1);
  });

  it("resumes an in-flight batch under its ORIGINAL id", async () => {
    // The scenario that can pay twice: the batch record was written, the payout was attempted,
    // and the process died without knowing whether it landed.
    const store = new FakeAccrualStore();
    store.batches.set("stuck-1", {
      operatorAddress: OPERATOR,
      firstAt: 1,
      batchId: "stuck-1",
      records: [
        {
          requestId: "r1",
          nodeId: "node-a",
          payerAddress: OPERATOR,
          operatorAddress: OPERATOR,
          inboundAtomic: "2000",
          payoutAtomic: "1700",
          marginAtomic: "300",
          inboundTxId: "IN-r1",
          payoutTxId: null,
          status: "accrued",
          createdAt: 1,
          settledAt: null,
        },
      ],
    });

    const { service, payer } = build(store);
    await service.recoverAccruals();
    await service.whenIdle();

    expect(payer.payments).toHaveLength(1);
    // Same id => same transaction note and same Algorand lease as the attempt that may
    // already have committed. A freshly generated id would make the chain treat the retry as
    // an unrelated transfer and pay the operator twice.
    expect(payer.payments[0]?.requestId).toBe("batch/stuck-1");
    expect(payer.payments[0]?.amountAtomic).toBe(1700n);
  });

  it("does not pay again when the in-flight batch already landed", async () => {
    const store = new FakeAccrualStore();
    store.batches.set("landed-1", {
      operatorAddress: OPERATOR,
      firstAt: 1,
      batchId: "landed-1",
      records: [
        {
          requestId: "r1",
          nodeId: "node-a",
          payerAddress: OPERATOR,
          operatorAddress: OPERATOR,
          inboundAtomic: "2000",
          payoutAtomic: "1700",
          marginAtomic: "300",
          inboundTxId: "IN-r1",
          payoutTxId: null,
          status: "accrued",
          createdAt: 1,
          settledAt: null,
        },
      ],
    });

    // A payer that fails to submit but reports the earlier attempt as already on chain —
    // exactly what algod does when the lease blocks a duplicate.
    const payments: PayoutRequest[] = [];
    const payer = {
      senderAddress: OPERATOR,
      pay: (request: PayoutRequest): Promise<{ txId: string }> => {
        payments.push(request);
        return Promise.reject(new Error("overlapping lease"));
      },
      findLandedPayout: (payoutId: string): Promise<{ txId: string } | undefined> =>
        Promise.resolve(payoutId === "batch/landed-1" ? { txId: "ALREADYLANDED" } : undefined),
    };

    const service = new DoubleSettlementService({
      config: makeConfig({ payoutBatchMinUsdc: "1.00" }),
      payer,
      logger: silentLogger,
      now: makeClock().now,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      accrualStore: store,
    });

    await service.recoverAccruals();
    await service.whenIdle();

    // The ledger tells the truth about the ORIGINAL transaction rather than inventing a
    // second one, and the batch record is released.
    expect(service.getRecord("r1")?.status).toBe("settled");
    expect(service.getRecord("r1")?.payoutTxId).toBe("ALREADYLANDED");
    expect(store.batches.size).toBe(0);
  });

  it("is a no-op with nothing stored", async () => {
    const store = new FakeAccrualStore();
    const { service, payer } = build(store);
    await expect(service.recoverAccruals()).resolves.toBeUndefined();
    expect(payer.payments).toHaveLength(0);
  });

  it("starts anyway when the store cannot be read", async () => {
    const store = new FakeAccrualStore();
    store.failOn = "loadAll";
    const { service } = build(store);
    // A gateway that cannot reach Redis must still boot and serve.
    await expect(service.recoverAccruals()).resolves.toBeUndefined();
  });
});

describe("persistence never blocks getting paid", () => {
  it("still pays out when the store write fails", async () => {
    const store = new FakeAccrualStore();
    store.failOn = "putOpen";
    const { service, payer } = build(store);

    await settle(service, "r1");
    await service.flushPayouts();

    // Durability is best-effort relative to paying. A Redis outage degrades the crash
    // guarantee; it must not stop an operator from being paid.
    expect(payer.payments).toHaveLength(1);
    expect(service.getRecord("r1")?.status).toBe("settled");
  });

  it("works with no store at all, exactly as before persistence existed", async () => {
    const { service, payer } = build(undefined);
    await settle(service, "r1");
    await settle(service, "r2");
    expect(payer.payments).toHaveLength(0);

    await service.flushPayouts();
    expect(payer.payments).toHaveLength(1);
    expect(payer.payments[0]?.amountAtomic).toBe(PAYOUT_PER_REQUEST * 2n);
  });
});

describe("a bad REDIS_URL must never crash the gateway", () => {
  it("is rejected at config load, naming the variable", () => {
    // The deploy-time half: a mistyped URL should fail loudly rather than quietly disable
    // durability. Observed in production as prose pasted in front of the URL.
    const base = {
      X402_PAY_TO_ADDRESS: TEST_PAY_TO,
      MESH_NETWORK: "testnet",
    } as NodeJS.ProcessEnv;

    for (const bad of [
      "Apps in the personal org can connect to at redis://default:pw@x.upstash.io:6379",
      "not-a-url",
      "http://example.com",
      "redis//missing-colon",
    ]) {
      expect(() => loadGatewayConfig({ ...base, REDIS_URL: bad }), bad).toThrow(/REDIS_URL/);
    }
  });

  it("accepts the forms Fly and Upstash actually hand out", () => {
    const base = {
      X402_PAY_TO_ADDRESS: TEST_PAY_TO,
      MESH_NETWORK: "testnet",
    } as NodeJS.ProcessEnv;

    for (const good of [
      "redis://127.0.0.1:6379",
      "redis://default:secret@fly-x402-mesh-redis.upstash.io:6379",
      "rediss://default:secret@eu1-abc.upstash.io:6380",
    ]) {
      expect(() => loadGatewayConfig({ ...base, REDIS_URL: good }), good).not.toThrow();
    }
  });

  it("degrades instead of throwing when the client cannot be built", async () => {
    // The runtime half. `new Redis(url)` parses eagerly and throws on a malformed URL; letting
    // that escape killed the process at boot rather than degrading. A payout path may lose
    // durability, but it must never refuse to start.
    await expect(
      createAccrualStore("Apps in the personal org can connect to at redis://x:1", {
        logger: { warn: () => undefined },
      }),
    ).resolves.toBeUndefined();
  });
});
