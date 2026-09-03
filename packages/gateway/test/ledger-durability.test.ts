import { describe, expect, it } from "vitest";
import type { LedgerStore } from "@x402-mesh/registry";
import { silentLogger } from "../src/logger.js";
import { DoubleSettlementService } from "@x402-mesh/settlement";
import { makeClock, makeConfig, makeOperator, StubPayer } from "./helpers.js";

/**
 * The audit ledger has to outlive the process.
 *
 * It records every request's three money legs, both transaction ids and a terminal status.
 * It lived only in memory, so a routine deploy erased it: after a restart `/v1/settlements`
 * reported a handful of rows from whatever had happened since boot and nothing before.
 *
 * The chain is the authoritative record of the transfers, but not of the accounting — the
 * per-request `inbound - payout = margin` split is written down here and nowhere else.
 */

const OPERATOR = makeOperator().address;

/** An in-memory {@link LedgerStore} that behaves like the Redis one, including the cap. */
class FakeLedgerStore implements LedgerStore {
  records = new Map<string, unknown>();
  order: string[] = [];
  failOn: string | null = null;

  put(requestId: string, record: unknown, maxEntries: number): Promise<void> {
    if (this.failOn === "put") return Promise.reject(new Error("redis down"));
    const isNew = !this.records.has(requestId);
    this.records.set(requestId, record);
    if (isNew) {
      this.order.unshift(requestId);
      // Evict past the cap, dropping the records too — otherwise keys leak forever.
      for (const id of this.order.splice(maxEntries)) this.records.delete(id);
    }
    return Promise.resolve();
  }

  loadRecent(limit: number): Promise<unknown[]> {
    if (this.failOn === "loadRecent") return Promise.reject(new Error("redis down"));
    return Promise.resolve(
      this.order
        .slice(0, limit)
        .map((id) => this.records.get(id))
        .filter((r) => r !== undefined),
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function build(store?: LedgerStore, maxLedgerEntries = 1000) {
  const payer = new StubPayer();
  const service = new DoubleSettlementService({
    config: makeConfig(),
    payer,
    logger: silentLogger,
    now: makeClock().now,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    maxLedgerEntries,
    ...(store ? { ledgerStore: store } : {}),
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

describe("the ledger survives a restart", () => {
  it("reloads rows written by a previous process", async () => {
    const store = new FakeLedgerStore();
    const first = build(store);
    await settle(first.service, "r1");
    await settle(first.service, "r2");
    expect(first.service.getSettlementLedger()).toHaveLength(2);

    // The deploy.
    const second = build(store);
    expect(second.service.getSettlementLedger(), "in memory only until hydrated").toHaveLength(0);
    await second.service.recoverAccruals();

    const rows = second.service.getSettlementLedger();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.requestId).sort()).toEqual(["r1", "r2"]);
  });

  it("restores the terminal status, not the row as first written", async () => {
    // `pending` -> `settled` is the transition the audit trail exists to record. Persisting
    // only the insert would keep a permanent lie about every completed payout.
    const store = new FakeLedgerStore();
    const first = build(store);
    await settle(first.service, "r1");
    expect(first.service.getRecord("r1")?.status).toBe("settled");

    const second = build(store);
    await second.service.recoverAccruals();
    const restored = second.service.getRecord("r1");
    expect(restored?.status).toBe("settled");
    expect(restored?.payoutTxId).toBeTruthy();
  });

  it("keeps the money split intact across the restart", async () => {
    const store = new FakeLedgerStore();
    await settle(build(store).service, "r1");

    const second = build(store);
    await second.service.recoverAccruals();
    const r = second.service.getRecord("r1");
    expect(BigInt(r?.inboundAtomic ?? "0") - BigInt(r?.payoutAtomic ?? "0")).toBe(
      BigInt(r?.marginAtomic ?? "0"),
    );
  });

  it("restores newest-last so eviction still drops the oldest", async () => {
    const store = new FakeLedgerStore();
    const first = build(store, 3);
    for (const id of ["r1", "r2", "r3"]) await settle(first.service, id);

    const second = build(store, 3);
    await second.service.recoverAccruals();
    await settle(second.service, "r4");

    // r1 is the oldest and must be the one evicted; a reversed restore would drop r3.
    const ids = second.service.getSettlementLedger().map((r) => r.requestId);
    expect(ids).not.toContain("r1");
    expect(ids).toContain("r3");
    expect(ids).toContain("r4");
  });

  it("will not pay a restored request a second time", async () => {
    const store = new FakeLedgerStore();
    await settle(build(store).service, "r1");

    const second = build(store);
    await second.service.recoverAccruals();
    await settle(second.service, "r1");

    expect(second.payer.payments, "the claim guard is rebuilt from the ledger").toHaveLength(0);
  });

  it("respects the entry cap in storage as well as in memory", async () => {
    const store = new FakeLedgerStore();
    const { service } = build(store, 3);
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) await settle(service, id);

    expect(service.getSettlementLedger()).toHaveLength(3);
    expect(store.order.length, "storage must not grow without bound").toBe(3);
    expect(store.records.size, "evicted rows must be deleted, not orphaned").toBe(3);
  });
});

describe("durability never blocks settling", () => {
  it("settles normally when the store write fails", async () => {
    const store = new FakeLedgerStore();
    store.failOn = "put";
    const { service, payer } = build(store);

    await settle(service, "r1");

    expect(payer.payments).toHaveLength(1);
    expect(service.getRecord("r1")?.status).toBe("settled");
  });

  it("starts anyway when history cannot be read", async () => {
    const store = new FakeLedgerStore();
    store.failOn = "loadRecent";
    const { service } = build(store);
    await expect(service.recoverAccruals()).resolves.toBeUndefined();
  });

  it("works with no store at all, exactly as before", async () => {
    const { service } = build(undefined);
    await settle(service, "r1");
    expect(service.getSettlementLedger()).toHaveLength(1);
  });
});
