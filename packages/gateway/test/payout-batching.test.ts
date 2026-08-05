import { describe, expect, it } from "vitest";
import { computeSplit } from "@x402-mesh/shared";
import { silentLogger } from "../src/logger.js";
import { DoubleSettlementService } from "../src/services/settlement.js";
import { makeClock, makeConfig, makeOperator, StubPayer } from "./helpers.js";

/**
 * Payout batching, tested as a money system rather than as a feature.
 *
 * The economics that motivate it: every payout transaction costs a flat 0.001 ALGO whatever
 * its size, which at ALGO $0.30 is ~$0.0003 — the entire gateway margin on a $0.0020 request
 * and a third of it on a $0.0060 one. Paying ten requests in one transaction pays that fee
 * once instead of ten times.
 *
 * What batching buys in fees it risks in correctness, and the risks are specific:
 *
 *   - **Cross-payment.** Accruals are keyed by operator address. Getting that wrong sends one
 *     operator's earnings to another, which no retry can undo.
 *   - **Arithmetic.** The transaction amount must equal the sum of the requests it settles,
 *     exactly, in integer atomic units.
 *   - **Partial finalisation.** One transaction settles many ledger rows. Every one of them
 *     must reach the same terminal state — a row left `accrued` after its batch paid is a
 *     liability the gateway thinks it still owes.
 *   - **Lost liability.** Accrued balances are money owed that has not moved. They live in
 *     memory, so shutdown must flush them.
 *
 * There is one deliberate non-property: batching is **off by default**. Enabling it changes
 * when operators get paid, which is not a decision a default should make for a deployment.
 */

const OPERATOR_A = makeOperator().address;
const OPERATOR_B = makeOperator().address;

/** Payout is 85% of inbound at the default 1500 bps margin. */
const PAYOUT_PER_REQUEST = computeSplit(2000n, 1500).payout; // 1700n

function buildService(batchMinUsdc: string, maxDelayMs = 900_000) {
  const payer = new StubPayer();
  const clock = makeClock();
  const service = new DoubleSettlementService({
    config: makeConfig({
      payoutBatchMinUsdc: batchMinUsdc,
      payoutBatchMaxDelayMs: maxDelayMs,
    }),
    payer,
    logger: silentLogger,
    now: clock.now,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  });
  return { service, payer, clock };
}

/** Settles one request for `operator`, as the x402 hook would. */
async function settle(
  service: DoubleSettlementService,
  requestId: string,
  operator: string,
  inboundAtomic = 2000n,
): Promise<void> {
  service.recordRouting(requestId, `node-for-${operator.slice(0, 6)}`, operator);
  service.settleInbound({
    requestId,
    payerAddress: OPERATOR_A,
    inboundTxId: `INBOUND-${requestId}`,
    inboundAtomic,
  });
  await service.whenIdle();
}

describe("batching is off unless configured", () => {
  it("pays every request immediately at the default of 0", async () => {
    const { service, payer } = buildService("0");
    await settle(service, "r1", OPERATOR_A);
    await settle(service, "r2", OPERATOR_A);

    expect(payer.payments).toHaveLength(2);
    // The note/lease id stays the bare request id, byte-identical to the pre-batching
    // behaviour, so reconciliation against historical on-chain payouts keeps working.
    expect(payer.payments.map((p) => p.requestId)).toEqual(["r1", "r2"]);
    expect(service.getPendingPayouts()).toHaveLength(0);
  });
});

describe("accrual", () => {
  it("submits nothing while the balance is below the threshold", async () => {
    const { service, payer } = buildService("0.010"); // 10000 atomic; each request owes 1700
    await settle(service, "r1", OPERATOR_A);
    await settle(service, "r2", OPERATOR_A);

    expect(payer.payments).toHaveLength(0);
    // `accrued`, not `pending`: the client's money has landed and the operator is owed. A
    // reader must be able to tell a liability from an in-flight network call.
    expect(service.getRecord("r1")?.status).toBe("accrued");
    expect(service.getRecord("r2")?.status).toBe("accrued");
  });

  it("reports what is owed while it waits", async () => {
    const { service } = buildService("0.010");
    await settle(service, "r1", OPERATOR_A);
    await settle(service, "r2", OPERATOR_A);

    const pending = service.getPendingPayouts();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      operatorAddress: OPERATOR_A,
      owedAtomic: (PAYOUT_PER_REQUEST * 2n).toString(10),
      requests: 2,
    });
  });

  it("pays once, for the exact sum, when the threshold is crossed", async () => {
    // 5000 atomic threshold; three requests at 1700 = 5100 crosses it on the third.
    const { service, payer } = buildService("0.005");
    await settle(service, "r1", OPERATOR_A);
    await settle(service, "r2", OPERATOR_A);
    expect(payer.payments).toHaveLength(0);

    await settle(service, "r3", OPERATOR_A);

    expect(payer.payments).toHaveLength(1);
    expect(payer.payments[0]?.amountAtomic).toBe(PAYOUT_PER_REQUEST * 3n);
    expect(payer.payments[0]?.receiver).toBe(OPERATOR_A);
    // Three requests, one fee. That is the entire point.
    expect(service.getPendingPayouts()).toHaveLength(0);
  });

  it("finalises every request the batch covered, not just the last one", async () => {
    const { service, payer } = buildService("0.005");
    for (const id of ["r1", "r2", "r3"]) await settle(service, id, OPERATOR_A);

    const txId = payer.payments[0] === undefined ? undefined : "PAYOUTTX-1";
    const records = ["r1", "r2", "r3"].map((id) => service.getRecord(id));

    for (const record of records) {
      expect(record?.status, "a row left accrued is a liability the gateway thinks it owes").toBe(
        "settled",
      );
      expect(record?.payoutTxId).toBe(txId);
      expect(record?.batchId).toBeTruthy();
    }
    // One shared batch id, so a reader can tell these rows were paid by one transaction whose
    // on-chain amount is their SUM, not any single row's payoutAtomic.
    expect(new Set(records.map((r) => r?.batchId)).size).toBe(1);
  });

  it("keeps each row's own split intact even though they were paid together", async () => {
    const { service, payer } = buildService("0.005");
    for (const id of ["r1", "r2", "r3"]) await settle(service, id, OPERATOR_A);

    const summed = ["r1", "r2", "r3"]
      .map((id) => BigInt(service.getRecord(id)?.payoutAtomic ?? "0"))
      .reduce((a, b) => a + b, 0n);

    // The invariant that matters: the chain moved exactly what the ledger says was owed.
    expect(payer.payments[0]?.amountAtomic).toBe(summed);
    for (const id of ["r1", "r2", "r3"]) {
      const r = service.getRecord(id);
      expect(BigInt(r?.inboundAtomic ?? "0") - BigInt(r?.payoutAtomic ?? "0")).toBe(
        BigInt(r?.marginAtomic ?? "0"),
      );
    }
  });
});

describe("operators are never cross-paid", () => {
  it("accrues each operator separately", async () => {
    const { service, payer } = buildService("0.005");
    // Interleaved on purpose: a single shared accumulator would merge these.
    await settle(service, "a1", OPERATOR_A);
    await settle(service, "b1", OPERATOR_B);
    await settle(service, "a2", OPERATOR_A);
    await settle(service, "b2", OPERATOR_B);

    expect(payer.payments).toHaveLength(0);
    const pending = service.getPendingPayouts();
    expect(pending).toHaveLength(2);
    for (const p of pending) {
      expect(p.owedAtomic).toBe((PAYOUT_PER_REQUEST * 2n).toString(10));
      expect(p.requests).toBe(2);
    }
  });

  it("crossing one operator's threshold does not pay the other", async () => {
    const { service, payer } = buildService("0.005");
    await settle(service, "b1", OPERATOR_B);
    for (const id of ["a1", "a2", "a3"]) await settle(service, id, OPERATOR_A);

    expect(payer.payments).toHaveLength(1);
    expect(payer.payments[0]?.receiver).toBe(OPERATOR_A);
    expect(payer.payments[0]?.amountAtomic).toBe(PAYOUT_PER_REQUEST * 3n);

    // B is still owed, untouched.
    expect(service.getRecord("b1")?.status).toBe("accrued");
    expect(service.getPendingPayouts()).toEqual([
      expect.objectContaining({ operatorAddress: OPERATOR_B, requests: 1 }),
    ]);
  });

  it("merges two nodes owned by the same operator into one payout", async () => {
    // The counterpart to the separation tests: accruals key on the payout DESTINATION, not on
    // the node. One person running two GPUs is one payee, and paying them twice would spend
    // two fees to deliver money that belongs in one transfer.
    const { service, payer } = buildService("1.00");
    service.recordRouting("n1r1", "node-one", OPERATOR_A);
    service.settleInbound({
      requestId: "n1r1",
      payerAddress: OPERATOR_A,
      inboundTxId: "IN-1",
      inboundAtomic: 2000n,
    });
    service.recordRouting("n2r1", "node-two", OPERATOR_A);
    service.settleInbound({
      requestId: "n2r1",
      payerAddress: OPERATOR_A,
      inboundTxId: "IN-2",
      inboundAtomic: 2000n,
    });
    await service.whenIdle();

    expect(service.getPendingPayouts()).toHaveLength(1);
    await service.flushPayouts();

    expect(payer.payments).toHaveLength(1);
    expect(payer.payments[0]?.amountAtomic).toBe(PAYOUT_PER_REQUEST * 2n);
  });

  it("pays each operator their own total on flush", async () => {
    const { service, payer } = buildService("1.00");
    await settle(service, "a1", OPERATOR_A);
    await settle(service, "a2", OPERATOR_A);
    await settle(service, "b1", OPERATOR_B);

    await service.flushPayouts();

    expect(payer.payments).toHaveLength(2);
    const byReceiver = new Map(payer.payments.map((p) => [p.receiver, p.amountAtomic]));
    expect(byReceiver.get(OPERATOR_A)).toBe(PAYOUT_PER_REQUEST * 2n);
    expect(byReceiver.get(OPERATOR_B)).toBe(PAYOUT_PER_REQUEST);
  });
});

describe("accrued balances survive shutdown", () => {
  it("flushPayouts pays everything owed regardless of threshold", async () => {
    const { service, payer } = buildService("1.00"); // never reached by two requests
    await settle(service, "r1", OPERATOR_A);
    await settle(service, "r2", OPERATOR_A);
    expect(payer.payments).toHaveLength(0);

    await service.flushPayouts();

    expect(payer.payments).toHaveLength(1);
    expect(payer.payments[0]?.amountAtomic).toBe(PAYOUT_PER_REQUEST * 2n);
    expect(service.getPendingPayouts()).toHaveLength(0);
    expect(service.getRecord("r1")?.status).toBe("settled");
    expect(service.getRecord("r2")?.status).toBe("settled");
  });

  it("is safe to call with nothing accrued", async () => {
    const { service, payer } = buildService("1.00");
    await expect(service.flushPayouts()).resolves.toBeUndefined();
    expect(payer.payments).toHaveLength(0);
  });

  it("resolves only once the flush has actually reached the chain", async () => {
    const { service, payer } = buildService("1.00");
    await settle(service, "r1", OPERATOR_A);

    await service.flushPayouts();

    // If flushPayouts resolved before the payout completed, shutdown would exit mid-transfer.
    expect(payer.payments).toHaveLength(1);
    expect(service.getRecord("r1")?.status).toBe("settled");
  });

  it("pays out on an age deadline even if the threshold is never reached", async () => {
    const { service, payer } = buildService("1.00", 10);
    await settle(service, "r1", OPERATOR_A);
    expect(payer.payments).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 40));
    await service.whenIdle();

    expect(payer.payments).toHaveLength(1);
    expect(service.getRecord("r1")?.status).toBe("settled");
  });
});

describe("failure handling covers the whole batch", () => {
  it("marks every request failed when the batch payout fails", async () => {
    const payer = new StubPayer(99); // fails every attempt
    const clock = makeClock();
    const service = new DoubleSettlementService({
      config: makeConfig({ payoutBatchMinUsdc: "0.005" }),
      payer,
      logger: silentLogger,
      now: clock.now,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    });

    for (const id of ["r1", "r2", "r3"]) await settle(service, id, OPERATOR_A);

    // A row left `accrued` after its batch failed would be invisible to any "retry failed
    // payouts" reconciliation — the money would simply never be paid.
    for (const id of ["r1", "r2", "r3"]) {
      expect(service.getRecord(id)?.status).toBe("failed");
      expect(service.getRecord(id)?.error).toBeTruthy();
    }
    expect(service.getPendingPayouts()).toHaveLength(0);
  });

  it("never accrues a zero payout", async () => {
    const { service, payer } = buildService("0.005");
    // 100% margin: nothing is owed, so there is nothing to batch and no transaction to make.
    const zeroService = new DoubleSettlementService({
      config: makeConfig({ payoutBatchMinUsdc: "0.005", marginBps: 10_000 }),
      payer,
      logger: silentLogger,
      now: makeClock().now,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    });
    void service;

    await settle(zeroService, "r1", OPERATOR_A);

    expect(payer.payments).toHaveLength(0);
    expect(zeroService.getPendingPayouts()).toHaveLength(0);
    expect(zeroService.getRecord("r1")?.status).toBe("settled");
    expect(zeroService.getRecord("r1")?.payoutTxId).toBeNull();
  });

  it("still refuses to pay a request twice", async () => {
    const { service, payer } = buildService("1.00");
    service.recordRouting("dup", "node-a", OPERATOR_A);
    service.settleInbound({
      requestId: "dup",
      payerAddress: OPERATOR_A,
      inboundTxId: "INBOUND-dup",
      inboundAtomic: 2000n,
    });
    // A second callback for the same request must not add a second accrual entry.
    service.settleInbound({
      requestId: "dup",
      payerAddress: OPERATOR_A,
      inboundTxId: "INBOUND-dup",
      inboundAtomic: 2000n,
    });
    await service.whenIdle();

    expect(service.getPendingPayouts()[0]?.requests).toBe(1);
    await service.flushPayouts();
    expect(payer.payments).toHaveLength(1);
    expect(payer.payments[0]?.amountAtomic).toBe(PAYOUT_PER_REQUEST);
  });
});

describe("the fee saving is real", () => {
  it("turns ten payouts into one", async () => {
    const { service, payer } = buildService("1.00");
    for (let i = 0; i < 10; i += 1) await settle(service, `r${i}`, OPERATOR_A);
    await service.flushPayouts();

    // 10 transactions at 0.001 ALGO each becomes 1. On a $0.0060 request that moves the fee
    // from a third of the margin to about 3% of it.
    expect(payer.payments).toHaveLength(1);
    expect(payer.payments[0]?.amountAtomic).toBe(PAYOUT_PER_REQUEST * 10n);
  });
});

describe("batch size is bounded independently of value", () => {
  it("flushes at the request cap even when the value threshold is far away", async () => {
    // The cap exists because every accrual rewrites the batch's whole record list to durable
    // storage: N requests cost O(N^2) bytes written. Gating only on value lets that grow
    // without limit whenever payouts are small relative to the threshold.
    const payer = new StubPayer();
    const service = new DoubleSettlementService({
      config: makeConfig({
        payoutBatchMinUsdc: "100.00", // unreachable
        payoutBatchMaxRequests: 3,
      }),
      payer,
      logger: silentLogger,
      now: makeClock().now,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    });

    await settle(service, "r1", OPERATOR_A);
    await settle(service, "r2", OPERATOR_A);
    expect(payer.payments).toHaveLength(0);

    await settle(service, "r3", OPERATOR_A);

    expect(payer.payments).toHaveLength(1);
    expect(payer.payments[0]?.amountAtomic).toBe(PAYOUT_PER_REQUEST * 3n);
    expect(service.getPendingPayouts()).toHaveLength(0);
  });

  it("counts per operator, not globally", async () => {
    const payer = new StubPayer();
    const service = new DoubleSettlementService({
      config: makeConfig({ payoutBatchMinUsdc: "100.00", payoutBatchMaxRequests: 3 }),
      payer,
      logger: silentLogger,
      now: makeClock().now,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    });

    // Four requests total, but never three for the same operator.
    await settle(service, "a1", OPERATOR_A);
    await settle(service, "b1", OPERATOR_B);
    await settle(service, "a2", OPERATOR_A);
    await settle(service, "b2", OPERATOR_B);

    expect(payer.payments).toHaveLength(0);
    expect(service.getPendingPayouts()).toHaveLength(2);
  });
});
