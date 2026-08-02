import type { Atomic, GatewayConfig, SettlementRecord } from "@x402-mesh/shared";
import {
  assertSplitInvariant,
  atomicToWire,
  computeSplit,
  usdcAssetId,
  SettlementError,
} from "@x402-mesh/shared";
import type { Logger } from "../logger.js";
import type {
  Clock,
  InboundSettlement,
  SettlementServicePort,
  Sleep,
  UsdcPayoutPort,
} from "../ports.js";
import { withSpan } from "../telemetry/otel.js";

/**
 * The double-settlement orchestrator.
 *
 * One paid request produces two on-chain movements:
 *
 * ```text
 *   client ──$0.0020 USDC──▶ gateway      (leg 1: x402 facilitator, synchronous)
 *   gateway ─$0.0017 USDC──▶ node operator (leg 2: this file, asynchronous)
 * ```
 *
 * Leg 2 must never be able to break leg 1's caller. The client has already been served by
 * the time {@link DoubleSettlementService.settleInbound} runs, so every failure path here
 * ends in a ledger entry and a log line — never in a thrown error that could reach a
 * response. `settleInbound` is deliberately `void`-returning for that reason.
 *
 * All money is integer `bigint` atomic units. The invariant `inbound - payout === margin` is
 * asserted before any funds move, not merely documented: `computeSplit` proves it and
 * `assertSplitInvariant` re-proves it on the values that are actually about to be paid.
 */

/** Retry policy for the payout leg. */
export interface RetryPolicy {
  /** Total attempts, including the first. */
  attempts: number;
  /** Delay before the second attempt; doubles each time. */
  baseDelayMs: number;
  /** Upper bound on any single delay. */
  maxDelayMs: number;
  /** Fraction of the delay applied as random jitter, in [0, 1]. */
  jitterRatio: number;
}

/**
 * Backoff sized against Algorand block time, not against an algod blip.
 *
 * The payout spends the USDC the inbound leg just delivered, and those funds are only
 * spendable once the inbound transaction reaches finality — roughly one 2.8s block, sometimes
 * more. This policy previously ran three attempts over ~0.75s total, which cannot outlast a
 * single round, so on a gateway wallet with no float the very first payout of its life failed
 * every time with:
 *
 *     TransactionPool.Remember: underflow on subtracting 1700 from sender amount 0
 *
 * Observed in production: all three attempts fired inside one second, the client was charged,
 * and the operator was not paid. The second request then succeeded only because the first
 * request's inbound had landed by then and left a balance behind.
 *
 * 4 attempts at 3s / 6s / 12s spans ~21s and comfortably crosses several rounds. This costs
 * the client nothing: the payout runs after the response has already been delivered.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 4,
  baseDelayMs: 3_000,
  maxDelayMs: 15_000,
  jitterRatio: 0.25,
};

/** Collaborators {@link DoubleSettlementService} needs. */
export interface SettlementDeps {
  config: GatewayConfig;
  payer: UsdcPayoutPort;
  logger: Logger;
  /** Time source in milliseconds. */
  now?: Clock;
  /** Backoff sleep; injected so tests do not wait. */
  sleep?: Sleep;
  /** Jitter source in [0, 1); injected so retry timing is deterministic under test. */
  random?: () => number;
  retry?: RetryPolicy;
  /** Maximum ledger entries retained in memory. */
  maxLedgerEntries?: number;
}

/** What the chat route knows at routing time, before the inbound payment settles. */
interface RoutingNote {
  nodeId: string;
  operatorAddress: string;
  at: number;
}

/** Default ledger depth: large enough for a demo and an audit, small enough to be bounded. */
const DEFAULT_MAX_LEDGER_ENTRIES = 1_000;

/**
 * How long an unmatched routing note is kept.
 *
 * A note is created when a node is chosen and consumed when the inbound payment settles. If
 * settlement never happens (handler failed, payment cancelled) the note would leak, so it
 * expires well after any plausible settlement delay.
 */
const ROUTING_NOTE_TTL_MS = 10 * 60_000;

export class DoubleSettlementService implements SettlementServicePort {
  private readonly config: GatewayConfig;
  private readonly payer: UsdcPayoutPort;
  private readonly logger: Logger;
  private readonly now: Clock;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly retry: RetryPolicy;
  private readonly maxLedgerEntries: number;
  private readonly assetId: string;

  /** Routing decisions awaiting their inbound settlement, keyed by request id. */
  private readonly routing = new Map<string, RoutingNote>();

  /** Audit trail, keyed by request id and insertion-ordered oldest-first. */
  private readonly ledger = new Map<string, SettlementRecord>();

  /**
   * Request ids that have already entered the payout path.
   *
   * This is the idempotency guard: membership is checked and set in the same synchronous
   * turn as the decision to pay, so two concurrent settlement callbacks for one request
   * cannot both reach the chain. Entries are never removed for completed requests — a
   * settled request must stay un-payable forever, not merely while it is in flight.
   */
  private readonly claimed = new Set<string>();

  /** In-flight payout promises, awaited by {@link whenIdle}. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: SettlementDeps) {
    this.config = deps.config;
    this.payer = deps.payer;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
    this.retry = deps.retry ?? DEFAULT_RETRY_POLICY;
    this.maxLedgerEntries = deps.maxLedgerEntries ?? DEFAULT_MAX_LEDGER_ENTRIES;
    // Resolved once at construction: a mismatch between the configured network and the ASA
    // would silently pay operators in the wrong asset.
    this.assetId = usdcAssetId(this.config.network);
  }

  /** @inheritdoc */
  recordRouting(requestId: string, nodeId: string, operatorAddress: string): void {
    const at = this.now();
    this.pruneRouting(at);
    this.routing.set(requestId, { nodeId, operatorAddress, at });
  }

  /** @inheritdoc */
  settleInbound(inbound: InboundSettlement): void {
    const note = this.routing.get(inbound.requestId);
    if (note === undefined) {
      // Payment settled for a request we have no routing record for. Never silently drop
      // this: it means money arrived that no operator will be paid for.
      this.logger.error(
        { requestId: inbound.requestId, inboundTxId: inbound.inboundTxId },
        "settlement without a routing record; operator payout skipped",
      );
      return;
    }
    this.routing.delete(inbound.requestId);

    if (this.claimed.has(inbound.requestId)) {
      this.logger.warn(
        { requestId: inbound.requestId, nodeId: note.nodeId },
        "duplicate settlement suppressed by idempotency guard",
      );
      return;
    }
    this.claimed.add(inbound.requestId);

    let record: SettlementRecord;
    try {
      record = this.openRecord(inbound, note);
    } catch (error) {
      // A broken split means we must not move funds at all. Surface it loudly.
      this.logger.error(
        { requestId: inbound.requestId, reason: describe(error) },
        "refusing to pay out: price split failed validation",
      );
      return;
    }
    this.remember(record);

    // Detach the payout so the (already-buffered) client response is flushed first.
    const task = this.runPayout(record).finally(() => {
      this.inFlight.delete(task);
    });
    this.inFlight.add(task);
  }

  /** @inheritdoc */
  getSettlementLedger(): SettlementRecord[] {
    return [...this.ledger.values()].reverse();
  }

  /** @inheritdoc */
  async whenIdle(): Promise<void> {
    // Payouts can be enqueued while we await, so loop until the set drains.
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Looks up one record. Used by `/v1/settlements/:requestId` and by tests. */
  getRecord(requestId: string): SettlementRecord | undefined {
    return this.ledger.get(requestId);
  }

  /**
   * Builds the `pending` ledger entry, computing and double-checking the split.
   *
   * @throws {PricingError} when the split does not satisfy `inbound - payout === margin`.
   */
  private openRecord(inbound: InboundSettlement, note: RoutingNote): SettlementRecord {
    const split = computeSplit(inbound.inboundAtomic, this.config.marginBps);
    assertSplitInvariant(split);
    return {
      requestId: inbound.requestId,
      nodeId: note.nodeId,
      payerAddress: inbound.payerAddress,
      operatorAddress: note.operatorAddress,
      inboundAtomic: atomicToWire(split.inbound),
      payoutAtomic: atomicToWire(split.payout),
      marginAtomic: atomicToWire(split.margin),
      inboundTxId: inbound.inboundTxId,
      payoutTxId: null,
      status: "pending",
      createdAt: this.now(),
      settledAt: null,
    };
  }

  /**
   * Executes the payout with bounded exponential backoff and jitter.
   *
   * Never throws: the terminal state is either `settled` with a payout transaction id, or
   * `failed` with an operator-actionable reason and an alert-level log line.
   */
  private async runPayout(record: SettlementRecord): Promise<void> {
    const payout = BigInt(record.payoutAtomic);

    if (payout === 0n) {
      // A 100% margin configuration is legal but means nothing is owed; recording it as
      // settled with no transaction is more honest than submitting a zero-value transfer.
      this.finalizeSettled(record, null);
      return;
    }

    let lastError = "unknown error";
    for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
      try {
        const { txId } = await withSpan(
          "gateway.payout",
          () =>
            this.payer.pay({
              receiver: record.operatorAddress,
              amountAtomic: payout,
              assetId: this.assetId,
              requestId: record.requestId,
            }),
          {
            "mesh.request_id": record.requestId,
            "mesh.node_id": record.nodeId,
            "mesh.payout_atomic": record.payoutAtomic,
            "mesh.attempt": attempt,
          },
        );
        this.finalizeSettled(record, txId);
        this.logger.info(
          {
            requestId: record.requestId,
            nodeId: record.nodeId,
            payoutAtomic: record.payoutAtomic,
            marginAtomic: record.marginAtomic,
            payoutTxId: txId,
            attempt,
          },
          "operator payout settled",
        );
        return;
      } catch (error) {
        lastError = describe(error);
        this.logger.warn(
          {
            requestId: record.requestId,
            nodeId: record.nodeId,
            attempt,
            attempts: this.retry.attempts,
            reason: lastError,
          },
          "operator payout attempt failed",
        );
        if (attempt < this.retry.attempts) await this.sleep(this.backoffMs(attempt));
      }
    }

    this.finalizeFailed(record, lastError);
    // Operator alert: money was taken from the client and the node operator has not been
    // paid. This needs a human or an automated reconciliation run, so it is error level with
    // every field required to replay the payout by hand.
    this.logger.error(
      {
        alert: "payout_failed",
        requestId: record.requestId,
        nodeId: record.nodeId,
        operatorAddress: record.operatorAddress,
        payoutAtomic: record.payoutAtomic,
        assetId: this.assetId,
        inboundTxId: record.inboundTxId,
        attempts: this.retry.attempts,
        reason: lastError,
      },
      "OPERATOR ALERT: node payout failed after all retries",
    );
  }

  /** Exponential backoff with proportional jitter, clamped to `maxDelayMs`. */
  private backoffMs(attempt: number): number {
    const exponential = this.retry.baseDelayMs * 2 ** (attempt - 1);
    const clamped = Math.min(this.retry.maxDelayMs, exponential);
    const jitter = clamped * this.retry.jitterRatio * this.random();
    return Math.round(clamped + jitter);
  }

  private finalizeSettled(record: SettlementRecord, txId: string | null): void {
    this.update(record.requestId, {
      ...record,
      payoutTxId: txId,
      status: "settled",
      settledAt: this.now(),
    });
  }

  private finalizeFailed(record: SettlementRecord, reason: string): void {
    this.update(record.requestId, {
      ...record,
      status: "failed",
      error: reason.slice(0, 1024),
      settledAt: this.now(),
    });
  }

  /**
   * Writes a terminal state back onto an existing ledger entry.
   *
   * A payout resolves long after the entry was created, by which time the entry may have
   * aged out of the bounded ledger. Writing it back unconditionally would resurrect an
   * evicted record and push the ledger over its cap, so an entry that is gone stays gone —
   * the outcome is still on the operator's log line and on chain.
   */
  private update(requestId: string, record: SettlementRecord): void {
    // `Map.set` on an existing key preserves its insertion position, so the oldest-first
    // ordering the eviction loop relies on survives this update.
    if (!this.ledger.has(requestId)) return;
    this.ledger.set(requestId, record);
  }

  /** Inserts a record and evicts the oldest once the ledger is full. */
  private remember(record: SettlementRecord): void {
    this.ledger.set(record.requestId, record);
    while (this.ledger.size > this.maxLedgerEntries) {
      const oldest = this.ledger.keys().next();
      if (oldest.done) break;
      this.ledger.delete(oldest.value);
    }
  }

  /** Drops routing notes whose settlement never arrived. */
  private pruneRouting(at: number): void {
    for (const [requestId, note] of this.routing) {
      if (at - note.at < ROUTING_NOTE_TTL_MS) break;
      this.routing.delete(requestId);
    }
  }
}

/**
 * Convenience wrapper used by call sites that have a decimal wire amount rather than a
 * bigint, so the string→bigint conversion happens exactly once, here.
 *
 * @throws {SettlementError} when the amount is not a decimal integer of atomic units.
 */
export function parseInboundAmount(wire: string, requestId: string): Atomic {
  if (!/^\d+$/.test(wire)) {
    throw new SettlementError("facilitator reported a non-integer settled amount", {
      requestId,
      amount: wire,
    });
  }
  return BigInt(wire);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
