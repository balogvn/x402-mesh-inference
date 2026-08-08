import type { Atomic, GatewayConfig, SettlementRecord } from "@x402-mesh/shared";
import {
  assertSplitInvariant,
  atomicToWire,
  computeSplit,
  usdcAssetId,
  usdcToAtomic,
  SettlementError,
} from "@x402-mesh/shared";
import type { AccrualStore, LedgerStore, PersistedAccrual } from "@x402-mesh/registry";
import type { Logger } from "../logger.js";
import type {
  Clock,
  InboundSettlement,
  PendingPayout,
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
  /**
   * Durable store for accrued balances. Omit to keep them in memory only.
   *
   * Only meaningful when batching is enabled. Without it, an accrued balance — USDC the
   * gateway already owes — exists solely in this process, and a crash loses the record of who
   * was owed what.
   */
  accrualStore?: AccrualStore;
  /**
   * Durable store for the audit ledger. Omit to keep it in memory only.
   *
   * The ledger is the only place the per-request `inbound - payout = margin` split is written
   * down; the chain shows the transfers but not the accounting behind them. Without this it
   * resets on every deploy.
   */
  ledgerStore?: LedgerStore;
}

/** What the chat route knows at routing time, before the inbound payment settles. */
interface RoutingNote {
  nodeId: string;
  operatorAddress: string;
  at: number;
}

/**
 * A batch that has been carved off an accrual and is in flight or stuck.
 *
 * Mirrors a durable `accrual:batch:<batchId>` row for reporting only. `attempts` and
 * `lastError` are what separate "not paid yet" from "not going to be paid" — the distinction
 * `/v1/payouts/pending` claims to make and previously could not.
 */
interface BatchLiability {
  batchId: string;
  operatorAddress: string;
  owedAtomic: bigint;
  requests: number;
  /** When the oldest request in the batch settled. Carried over from the accrual. */
  oldestAt: number;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: number | null;
}

/** One operator's accrued-but-unpaid balance. */
interface Accrual {
  operatorAddress: string;
  /** Ledger entries this accrual will settle, in arrival order. */
  records: SettlementRecord[];
  /** Sum of `records[].payoutAtomic`. Maintained incrementally and re-derived before paying. */
  totalAtomic: Atomic;
  /** When the first request in this accrual settled; drives the age deadline. */
  firstAt: number;
  /** Fires the age-based flush. Cleared whenever the accrual is drained. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One payout transaction, whether it settles one request or many.
 *
 * Batched and unbatched payouts run the same code, which is the point: the retry policy, the
 * already-landed chain check and the ledger finalisation are the parts most likely to hide a
 * money bug, and having one copy means a batch cannot quietly get a weaker version of them.
 *
 * `payoutId` is what goes into the transaction note and lease. For an unbatched payout it is
 * the request id — byte-identical to what shipped before batching existed, so historical
 * reconciliation by note prefix keeps working.
 */
interface PayoutJob {
  payoutId: string;
  receiver: string;
  amountAtomic: Atomic;
  records: SettlementRecord[];
  batchId: string | null;
  /**
   * Ask the chain whether this payout already landed BEFORE submitting it.
   *
   * Set only for a batch resumed from storage after a crash. Such a batch was already handed
   * to `pay()` once by the process that died, so its transfer may well be on chain — and the
   * Algorand lease that would otherwise reject the duplicate is only valid for a bounded
   * window of rounds. A restart slower than that window turns a naive re-submit into a second
   * real payment, which nothing on chain undoes.
   *
   * Never set for a fresh payout: that would spend an indexer round trip on every request to
   * look for a transaction that cannot exist yet.
   */
  checkLandedFirst?: boolean;
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

  /** Minimum owed before a batch is paid. Zero disables batching. */
  private readonly batchMinAtomic: Atomic;

  /** Accrued-but-unpaid balances, keyed by operator address. */
  private readonly accruals = new Map<string, Accrual>();

  /**
   * Batches that have left `accruals` and are being paid, or have failed and are still owed.
   *
   * Read ONLY by {@link getPendingPayouts}. Nothing in the payout path consults it, so it
   * cannot influence what is paid — it exists solely so that money we owe is visible.
   *
   * It exists because `/v1/payouts/pending` reported only `accruals`, which a batch leaves the
   * instant it is carved off. A batch whose payout keeps failing therefore vanished from the
   * one endpoint whose stated purpose is telling an operator what they are owed — and the
   * failing case is precisely the one worth seeing. A real MainNet batch sat invisible this
   * way: 0.0153 USDC owed, with the endpoint reporting `totalOwed: 0`.
   *
   * Redis remains authoritative. This mirror is per-process and can only ever be a SUBSET of
   * the durable rows, because entries are added where `putBatch` is enqueued and removed where
   * `removeBatch` is. Its failure direction is therefore under-reporting — the status quo —
   * never inventing a liability that is not durably recorded.
   */
  private readonly batchLiabilities = new Map<string, BatchLiability>();

  /** Monotonic suffix making each batch id unique within a process. */
  private batchSeq = 0;

  /** Durable accrual storage, when configured. */
  private readonly accrualStore: AccrualStore | undefined;

  /** Durable audit-ledger storage, when configured. */
  private readonly ledgerStore: LedgerStore | undefined;

  /**
   * Per-operator serialization of durable writes.
   *
   * Accrue, flush and finalise all mutate one operator's stored state, and they are triggered
   * from independent async contexts (a settlement callback, a deadline timer, a payout
   * completing). Without ordering, a flush's delete can land after a later accrue's write and
   * resurrect a batch that was already paid. Chaining per operator makes the stored state
   * follow the same order the in-memory state did.
   */
  private readonly writeChains = new Map<string, Promise<void>>();

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
    this.batchMinAtomic = usdcToAtomic(this.config.payoutBatchMinUsdc);
    this.accrualStore = deps.accrualStore;
    this.ledgerStore = deps.ledgerStore;

    if (this.batchMinAtomic > 0n && this.accrualStore === undefined) {
      // Deliberate risk, said out loud. Batching without persistence means a hard crash
      // loses the record of accrued liabilities; the funds stay in the wallet and nothing
      // remembers to send them.
      this.logger.warn(
        {
          batchMinUsdc: this.config.payoutBatchMinUsdc,
          maxDelayMs: this.config.payoutBatchMaxDelayMs,
        },
        "payout batching is enabled with NO durable accrual store: a hard crash will lose accrued balances (set REDIS_URL)",
      );
    }
  }

  /**
   * Appends a durable write to an operator's chain, so stored state follows memory order.
   *
   * The key is ALWAYS the operator address. It previously varied — flushes chained on the
   * operator while batch releases chained on `batch:<id>` — which meant the two were
   * unordered with respect to each other: `removeBatch` could complete before the `putBatch`
   * it was meant to undo, leaving a settled batch's record written *after* its own deletion.
   * That record then survives forever and the next boot pays it a second time. One key per
   * operator is what makes "stored state follows memory order" actually true.
   *
   * Failures are swallowed after logging: durability is best-effort relative to paying, and a
   * Redis outage must never stop an operator from being paid.
   */
  private enqueueWrite(operatorAddress: string, work: () => Promise<void>): Promise<void> {
    const previous = this.writeChains.get(operatorAddress) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work)
      .catch((error: unknown) => {
        this.logger.error(
          { alert: "accrual_persist_failed", operatorAddress, reason: describe(error) },
          "OPERATOR ALERT: could not persist accrual state; a crash would lose this liability",
        );
      })
      .finally(() => {
        // Drop the entry once this is the tail, so a long-lived gateway does not accumulate
        // one resolved promise per operator forever.
        if (this.writeChains.get(operatorAddress) === next) {
          this.writeChains.delete(operatorAddress);
        }
      });
    this.writeChains.set(operatorAddress, next);
    this.spawn(next);
    return next;
  }

  /**
   * Reloads the audit ledger from storage at boot.
   *
   * Without it `/v1/settlements` reported only what had happened since the last deploy, which
   * made a routine restart look like the history had been wiped. Records are inserted
   * oldest-first so the in-memory map's insertion order — which the eviction loop depends on —
   * matches the order the store already keeps.
   *
   * Never throws: history is worth having, never worth refusing to start for.
   */
  private async hydrateLedger(): Promise<void> {
    if (this.ledgerStore === undefined) return;
    try {
      const recent = await this.ledgerStore.loadRecent(this.maxLedgerEntries);
      // loadRecent returns newest-first; the ledger map is oldest-first.
      for (const raw of [...recent].reverse()) {
        const record = raw as SettlementRecord;
        if (typeof record?.requestId !== "string") continue;
        this.ledger.set(record.requestId, record);
        // A request already in the ledger must never be paid again, whatever arrives later.
        this.claimed.add(record.requestId);
      }
      if (recent.length > 0) {
        this.logger.info({ rows: recent.length }, "settlement ledger restored from storage");
      }
    } catch (error) {
      this.logger.warn(
        { reason: describe(error) },
        "could not restore the settlement ledger; history starts from this boot",
      );
    }
  }

  /**
   * Drops a stored batch record once its payout SETTLED.
   *
   * Only on success. A failed payout keeps its record: the operator has not been paid, so the
   * liability is still real and must outlive the process that failed to discharge it.
   */
  private releaseBatch(batchId: string | null, operatorAddress: string): void {
    if (batchId === null || this.accrualStore === undefined) return;
    const store = this.accrualStore;
    this.enqueueWrite(operatorAddress, () => store.removeBatch(batchId));
  }

  /**
   * Recovers accrued liabilities left behind by a previous process.
   *
   * Called once at boot, before the listener accepts traffic. Two cases, and the difference
   * matters:
   *
   *   - **open** accruals were still accumulating. They are paid out immediately rather than
   *     resumed: the gateway cannot know how long it was down, and money owed for an unknown
   *     interval should move now, not wait for a threshold that may never be reached.
   *   - **batch** accruals were mid-payout when the process died, so the transfer may or may
   *     not have landed. Each is re-run under its ORIGINAL batch id, which means the same
   *     transaction note and the same Algorand lease. `findLandedPayout` recognises an
   *     attempt that already committed and records it settled instead of paying again; the
   *     lease is the backstop if it does not.
   *
   * Never throws — a gateway that cannot reach Redis must still start and serve.
   */
  async recoverAccruals(): Promise<void> {
    await this.hydrateLedger();
    if (this.accrualStore === undefined) return;

    let loaded: Awaited<ReturnType<AccrualStore["loadAll"]>>;
    try {
      loaded = await this.accrualStore.loadAll();
    } catch (error) {
      this.logger.error(
        { alert: "accrual_recovery_failed", reason: describe(error) },
        "OPERATOR ALERT: could not load accrued payouts at boot; they will not be paid until this succeeds",
      );
      return;
    }

    const total = loaded.open.length + loaded.batches.length;
    if (total === 0) return;

    this.logger.warn(
      { openAccruals: loaded.open.length, inFlightBatches: loaded.batches.length },
      "recovering accrued operator payouts left by a previous process",
    );

    // Batches first, then open accruals — and de-duplicated by request id across BOTH.
    //
    // The two sets can genuinely overlap. Promoting an accrual writes the batch record and
    // then deletes the open one; if the process dies between those, or the delete fails and
    // its error is swallowed, the same requests exist in both. Iterating the concatenation
    // without de-duplication pays them twice in a single boot — the money bug this whole
    // recovery path exists to prevent.
    //
    // Batches take precedence because they are further along: one may already be on chain,
    // and resuming it under its original id is what lets the chain check recognise that.
    const handled = new Set<string>();

    for (const stored of [...loaded.batches, ...loaded.open]) {
      const records = stored.records as SettlementRecord[];
      const usable = records.filter(
        (r) => typeof r?.payoutAtomic === "string" && typeof r?.requestId === "string",
      );
      const dropped = records.length - usable.length;
      if (dropped > 0) {
        this.logger.error(
          {
            alert: "accrual_recovery_unusable_records",
            operatorAddress: stored.operatorAddress,
            batchId: stored.batchId ?? null,
            dropped,
          },
          "OPERATOR ALERT: recovered accrual contained unusable records; that portion cannot be paid automatically",
        );
      }

      const payable = usable.filter((r) => !handled.has(r.requestId));
      if (payable.length < usable.length) {
        this.logger.warn(
          {
            operatorAddress: stored.operatorAddress,
            batchId: stored.batchId ?? null,
            skipped: usable.length - payable.length,
          },
          "recovered accrual overlapped one already being paid; the overlap was not paid twice",
        );
      }

      if (payable.length === 0) {
        // Nothing left to pay: either empty, or entirely covered by a batch handled above.
        // Drop the stale row so the next boot does not reconsider it.
        if (typeof stored.batchId === "string") this.batchLiabilities.delete(stored.batchId);
        this.dropRecovered(stored);
        continue;
      }

      // Re-seed the ledger so /v1/settlements reports these, and re-claim the request ids so
      // a late duplicate settlement callback cannot pay them a second time.
      for (const record of payable) {
        this.claimed.add(record.requestId);
        handled.add(record.requestId);
        if (!this.ledger.has(record.requestId)) this.remember(record);
      }

      const summed = payable.reduce((acc, r) => acc + BigInt(r.payoutAtomic), 0n);
      if (summed === 0n) {
        if (typeof stored.batchId === "string") this.batchLiabilities.delete(stored.batchId);
        this.dropRecovered(stored);
        continue;
      }

      const resumed = typeof stored.batchId === "string" && stored.batchId.length > 0;
      const batchId = resumed
        ? (stored.batchId as string)
        : `${this.now().toString(36)}-r${(this.batchSeq += 1).toString(36)}`;

      this.logger.warn(
        {
          batchId,
          operatorAddress: stored.operatorAddress,
          requests: payable.length,
          owedAtomic: summed.toString(10),
          resumed,
        },
        "paying out a recovered accrual",
      );

      this.batchLiabilities.set(batchId, {
        batchId,
        operatorAddress: stored.operatorAddress,
        owedAtomic: summed,
        requests: payable.length,
        // The ORIGINAL settlement time, not now: a debt recovered at boot is as old as the
        // request that created it, and resetting it would make a long-stuck batch look fresh.
        oldestAt: stored.firstAt,
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
      });

      // Store it as a batch under the id we are about to pay with, so a crash during recovery
      // is itself recoverable. Chained on the OPERATOR, like every other durable write, so it
      // cannot race the writes a live request is making for the same operator.
      if (this.accrualStore !== undefined) {
        const store = this.accrualStore;
        const snapshot = { ...stored, records: payable, batchId };
        this.enqueueWrite(stored.operatorAddress, async () => {
          await store.putBatch(snapshot);
          if (!resumed) await store.removeOpen(stored.operatorAddress);
        });
      }

      this.spawn(
        this.runPayout({
          payoutId: `batch/${batchId}`,
          receiver: stored.operatorAddress,
          amountAtomic: summed,
          records: payable,
          batchId,
          // Only a resumed batch may already be on chain. Ask before paying.
          ...(resumed ? { checkLandedFirst: true } : {}),
        }),
      );
    }
  }

  /** Removes a recovered row that has nothing left to pay. */
  private dropRecovered(stored: PersistedAccrual): void {
    if (this.accrualStore === undefined) return;
    const store = this.accrualStore;
    const batchId = typeof stored.batchId === "string" ? stored.batchId : null;
    this.enqueueWrite(stored.operatorAddress, async () => {
      if (batchId !== null) await store.removeBatch(batchId);
      else await store.removeOpen(stored.operatorAddress);
    });
  }

  /** Serializes an in-memory accrual for storage. */
  private toPersisted(accrual: Accrual, batchId: string | null): PersistedAccrual {
    return {
      operatorAddress: accrual.operatorAddress,
      records: accrual.records,
      firstAt: accrual.firstAt,
      batchId,
    };
  }

  /** @inheritdoc */
  async flushPayouts(): Promise<void> {
    // Loop rather than snapshot-then-await. A settlement landing during the await would add a
    // new accrual that a single pass never sees — and on the shutdown path that accrual is
    // simply lost, which is the exact liability this method exists to protect.
    while (this.accruals.size > 0) {
      for (const operatorAddress of [...this.accruals.keys()]) {
        this.flushAccrual(operatorAddress, "flush");
      }
      await this.whenIdle();
    }
    await this.whenIdle();
  }

  /**
   * @inheritdoc
   *
   * Reports BOTH still-accruing balances and batches already carved off but not yet paid.
   *
   * It used to report only the former, which meant a batch disappeared from this list the
   * instant it was handed to a payout — including when that payout could never succeed. The
   * endpoint answering "what am I owed" went silent on precisely the debts worth asking about.
   *
   * One entry per accrual and one per batch, deliberately not merged by operator: an operator
   * can simultaneously have a fresh accrual and a stuck batch, and collapsing them would hide
   * which `batchId` is wedged, which is the only actionable part.
   */
  getPendingPayouts(): PendingPayout[] {
    const accruing: PendingPayout[] = [...this.accruals.values()].map((a) => ({
      operatorAddress: a.operatorAddress,
      owedAtomic: a.totalAtomic.toString(10),
      requests: a.records.length,
      oldestAt: a.firstAt,
      state: "accruing" as const,
      deadlineAt: a.firstAt + this.config.payoutBatchMaxDelayMs,
    }));

    const batched: PendingPayout[] = [...this.batchLiabilities.values()].map((b) => ({
      operatorAddress: b.operatorAddress,
      owedAtomic: b.owedAtomic.toString(10),
      requests: b.requests,
      oldestAt: b.oldestAt,
      // A batch that has failed at least once is not merely late — something is wrong with it,
      // and saying so is the whole point of this list.
      state: b.lastError === null ? ("paying" as const) : ("stuck" as const),
      batchId: b.batchId,
      attempts: b.attempts,
      ...(b.lastError === null ? {} : { lastError: b.lastError }),
      ...(b.lastAttemptAt === null ? {} : { lastAttemptAt: b.lastAttemptAt }),
    }));

    return [...accruing, ...batched].sort((x, y) => x.oldestAt - y.oldestAt);
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

    const payout = BigInt(record.payoutAtomic);

    // Nothing owed (a 100% margin configuration) never becomes a transaction, batched or not:
    // recording it settled with no txId is more honest than submitting a zero-value transfer.
    if (payout === 0n) {
      this.finalizeSettled([record], null, null);
      return;
    }

    if (this.batchMinAtomic > 0n) {
      this.accrue(record, payout);
      return;
    }

    // Detach the payout so the (already-buffered) client response is flushed first.
    this.spawn(
      this.runPayout({
        payoutId: record.requestId,
        receiver: record.operatorAddress,
        amountAtomic: payout,
        records: [record],
        batchId: null,
      }),
    );
  }

  /**
   * Adds one settled request to its operator's accrual, flushing when the threshold is hit.
   *
   * The record is marked `accrued` rather than left `pending`: the client's money has landed
   * and the operator is owed, which is a liability, not an in-flight network call. An operator
   * reading the ledger must be able to tell those apart.
   */
  private accrue(record: SettlementRecord, payout: Atomic): void {
    const at = this.now();
    this.update(record.requestId, { ...record, status: "accrued" });

    let accrual = this.accruals.get(record.operatorAddress);
    if (accrual === undefined) {
      accrual = {
        operatorAddress: record.operatorAddress,
        records: [],
        totalAtomic: 0n,
        firstAt: at,
      };
      this.accruals.set(record.operatorAddress, accrual);
    }
    accrual.records.push(record);
    accrual.totalAtomic += payout;

    if (accrual.totalAtomic >= this.batchMinAtomic) {
      this.flushAccrual(record.operatorAddress, "threshold");
      return;
    }
    // Size cap, checked alongside the value threshold. Without it a batch grows unbounded
    // whenever the value threshold is slow to be reached, and every accrual rewrites the
    // whole record list — so the durable-write cost is quadratic in batch size.
    if (accrual.records.length >= this.config.payoutBatchMaxRequests) {
      this.flushAccrual(record.operatorAddress, "max-requests");
      return;
    }

    // Durably record the liability. Deliberately after the threshold check: an accrual that
    // is about to be paid this turn never needs an open record written and immediately
    // deleted.
    if (this.accrualStore !== undefined) {
      const store = this.accrualStore;
      const snapshot = this.toPersisted(accrual, null);
      this.enqueueWrite(record.operatorAddress, () => store.putOpen(snapshot));
    }

    // Age deadline, armed once per accrual so the wait is measured from the FIRST request in
    // it. Re-arming on every request would let a steadily-trickling operator never get paid.
    if (accrual.timer === undefined) {
      const timer = setTimeout(() => {
        this.flushAccrual(record.operatorAddress, "deadline");
      }, this.config.payoutBatchMaxDelayMs);
      // Unref'd so an accrual waiting on its deadline cannot keep the process alive; graceful
      // shutdown flushes explicitly rather than relying on this timer firing.
      timer.unref?.();
      accrual.timer = timer;
    }
  }

  /** Detaches one accrual into a payout job. Safe to call when nothing is accrued. */
  private flushAccrual(operatorAddress: string, reason: string): void {
    const accrual = this.accruals.get(operatorAddress);
    if (accrual === undefined || accrual.records.length === 0) return;

    this.accruals.delete(operatorAddress);
    if (accrual.timer !== undefined) clearTimeout(accrual.timer);

    // Re-derived from the records rather than trusted from the running total. These two
    // disagreeing would mean paying an amount no set of requests adds up to, so it is checked
    // rather than assumed — the same reason `computeSplit` is re-asserted before funds move.
    const summed = accrual.records.reduce((acc, r) => acc + BigInt(r.payoutAtomic), 0n);
    if (summed !== accrual.totalAtomic) {
      this.logger.error(
        {
          alert: "batch_sum_mismatch",
          operatorAddress,
          running: accrual.totalAtomic.toString(10),
          summed: summed.toString(10),
          requests: accrual.records.length,
        },
        "OPERATOR ALERT: accrual total disagrees with its records; paying the summed amount",
      );
    }

    this.batchSeq += 1;
    const batchId = `${this.now().toString(36)}-${this.batchSeq.toString(36)}`;

    this.logger.info(
      {
        batchId,
        operatorAddress,
        requests: accrual.records.length,
        owedAtomic: summed.toString(10),
        reason,
      },
      "flushing operator payout batch",
    );

    this.batchLiabilities.set(batchId, {
      batchId,
      operatorAddress,
      owedAtomic: summed,
      requests: accrual.records.length,
      oldestAt: accrual.firstAt,
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
    });

    // Promote open -> batch BEFORE paying. The stored batchId is what a restart reuses, so
    // the retry carries the same Algorand lease and the same note as an attempt that may
    // already have landed — which is what stops crash recovery from paying twice.
    if (this.accrualStore !== undefined) {
      const store = this.accrualStore;
      const snapshot = { ...this.toPersisted(accrual, batchId), batchId };
      this.enqueueWrite(operatorAddress, async () => {
        await store.putBatch(snapshot);
        await store.removeOpen(operatorAddress);
      });
    }

    this.spawn(
      this.runPayout({
        payoutId: `batch/${batchId}`,
        receiver: operatorAddress,
        amountAtomic: summed,
        records: accrual.records,
        batchId,
      }),
    );
  }

  /** Tracks a detached payout so {@link whenIdle} and {@link flushPayouts} can await it. */
  private spawn(work: Promise<void>): void {
    const task = work.finally(() => {
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
  private async runPayout(job: PayoutJob): Promise<void> {
    const payout = job.amountAtomic;

    if (job.checkLandedFirst === true) {
      const already = await this.findLandedPayout(job);
      if (already !== undefined) {
        this.finalizeSettled(job.records, already.txId, job.batchId);
        this.logger.warn(
          {
            payoutId: job.payoutId,
            batchId: job.batchId,
            payoutTxId: already.txId,
            requests: job.records.length,
          },
          "recovered batch had already been paid on chain; recorded without paying again",
        );
        return;
      }
    }

    let lastError = "unknown error";
    for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
      try {
        const { txId } = await withSpan(
          "gateway.payout",
          () =>
            this.payer.pay({
              receiver: job.receiver,
              amountAtomic: payout,
              assetId: this.assetId,
              requestId: job.payoutId,
            }),
          {
            "mesh.payout_id": job.payoutId,
            "mesh.batch_id": job.batchId ?? "",
            "mesh.batch_size": job.records.length,
            "mesh.payout_atomic": payout.toString(10),
            "mesh.attempt": attempt,
          },
        );
        this.finalizeSettled(job.records, txId, job.batchId);
        this.logger.info(
          {
            payoutId: job.payoutId,
            batchId: job.batchId,
            operatorAddress: job.receiver,
            requests: job.records.length,
            payoutAtomic: payout.toString(10),
            payoutTxId: txId,
            attempt,
          },
          "operator payout settled",
        );
        return;
      } catch (error) {
        lastError = describe(error);

        // `pay` can submit successfully and then throw while awaiting confirmation, in which
        // case the money HAS moved and only the acknowledgement was lost. Ask the chain
        // before retrying: retrying is at best wasted work, and recording `failed` for a
        // payout that landed tells an operator they were not paid and invites a
        // reconciliation run to pay them twice. Observed on MainNet — payout
        // BRW5GM5FQJJHLICDTTXNJH3BNRBRVP7RCS6C4FMGYTCTRPOCFO4Q landed while its ledger row
        // said failed. (The Algorand lease on the payout already prevents an actual double
        // spend; this is about the ledger telling the truth.)
        const landed = await this.findLandedPayout(job);
        if (landed !== undefined) {
          this.finalizeSettled(job.records, landed.txId, job.batchId);
          this.logger.info(
            {
              payoutId: job.payoutId,
              batchId: job.batchId,
              payoutTxId: landed.txId,
              attempt,
              reason: lastError,
            },
            "operator payout had already landed on chain; recorded as settled",
          );
          return;
        }

        this.logger.warn(
          {
            payoutId: job.payoutId,
            batchId: job.batchId,
            attempt,
            attempts: this.retry.attempts,
            reason: lastError,
          },
          "operator payout attempt failed",
        );
        if (attempt < this.retry.attempts) await this.sleep(this.backoffMs(attempt));
      }
    }

    // Last look before declaring failure: a payout submitted on the final attempt may have
    // committed after that attempt's confirmation wait gave up.
    const lateLanded = await this.findLandedPayout(job);
    if (lateLanded !== undefined) {
      this.finalizeSettled(job.records, lateLanded.txId, job.batchId);
      this.logger.info(
        { payoutId: job.payoutId, batchId: job.batchId, payoutTxId: lateLanded.txId },
        "operator payout landed after the final attempt; recorded as settled",
      );
      return;
    }

    this.finalizeFailed(job.records, lastError, job.batchId);
    // Operator alert: money was taken from the client and the node operator has not been
    // paid. This needs a human or an automated reconciliation run, so it is error level with
    // every field required to replay the payout by hand.
    this.logger.error(
      {
        alert: "payout_failed",
        payoutId: job.payoutId,
        batchId: job.batchId,
        operatorAddress: job.receiver,
        payoutAtomic: payout.toString(10),
        assetId: this.assetId,
        requests: job.records.length,
        // Singular fields preserved verbatim for an unbatched payout, so alerting built
        // against the pre-batching shape keeps working. A batch cannot honestly report one
        // request id or one inbound transaction, so it reports the lists instead — which is
        // what a human replaying the payout actually needs.
        ...(job.records.length === 1 && job.records[0] !== undefined
          ? {
              requestId: job.records[0].requestId,
              nodeId: job.records[0].nodeId,
              inboundTxId: job.records[0].inboundTxId,
            }
          : {
              requestIds: job.records.map((r) => r.requestId),
              inboundTxIds: job.records.map((r) => r.inboundTxId),
            }),
        attempts: this.retry.attempts,
        reason: lastError,
      },
      "OPERATOR ALERT: node payout failed after all retries",
    );
  }

  /** Exponential backoff with proportional jitter, clamped to `maxDelayMs`. */
  /**
   * Asks the payer whether a payout for this record already committed.
   *
   * Returns undefined both when nothing landed and when the lookup itself failed — the caller
   * treats undefined as "keep going", so a flaky indexer degrades to the old behaviour rather
   * than inventing a settlement.
   *
   * @param record - The settlement record whose payout to look for.
   * @returns The committed transaction id, or undefined.
   */
  private async findLandedPayout(job: PayoutJob): Promise<{ txId: string } | undefined> {
    if (this.payer.findLandedPayout === undefined) return undefined;
    try {
      return await this.payer.findLandedPayout(job.payoutId, job.receiver);
    } catch {
      return undefined;
    }
  }

  private backoffMs(attempt: number): number {
    const exponential = this.retry.baseDelayMs * 2 ** (attempt - 1);
    const clamped = Math.min(this.retry.maxDelayMs, exponential);
    const jitter = clamped * this.retry.jitterRatio * this.random();
    return Math.round(clamped + jitter);
  }

  /**
   * Marks every request the payout covered as settled.
   *
   * All of them share one `payoutTxId`, and the on-chain amount is the SUM of their
   * `payoutAtomic` — which is why `batchId` is written alongside. Without it a reader
   * comparing one row's `payoutAtomic` against the transaction would conclude the gateway
   * overpaid.
   */
  private finalizeSettled(
    records: readonly SettlementRecord[],
    txId: string | null,
    batchId: string | null,
  ): void {
    // Before releaseBatch, and unconditionally: releaseBatch early-returns without an accrual
    // store, so putting this inside it would leave a store-less service reporting settled
    // batches as owed forever.
    if (batchId !== null) this.batchLiabilities.delete(batchId);
    this.releaseBatch(batchId, records[0]?.operatorAddress ?? "");
    const settledAt = this.now();
    for (const record of records) {
      this.update(record.requestId, {
        ...record,
        payoutTxId: txId,
        batchId,
        status: "settled",
        settledAt,
      });
    }
  }

  private finalizeFailed(
    records: readonly SettlementRecord[],
    reason: string,
    batchId: string | null,
  ): void {
    // Deliberately NOT released. A payout that exhausted its retries has still not paid the
    // operator, so the money is still owed. This used to delete the stored batch and defer to
    // "the ledger" — but the ledger is in memory and capped at maxLedgerEntries, so deleting
    // here erased the only durable trace of a real liability. Keeping it means the next boot
    // retries, which is correct: the debt outlives the process that failed to settle it.
    //
    // The mirror entry is annotated rather than removed, for the same reason: it is the only
    // thing that makes an undischargeable debt visible at /v1/payouts/pending.
    if (batchId !== null) {
      const liability = this.batchLiabilities.get(batchId);
      if (liability !== undefined) {
        liability.attempts += 1;
        liability.lastError = reason.slice(0, 256);
        liability.lastAttemptAt = this.now();
      }
    }
    const settledAt = this.now();
    for (const record of records) {
      this.update(record.requestId, {
        ...record,
        batchId,
        status: "failed",
        error: reason.slice(0, 1024),
        settledAt,
      });
    }
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
    // Persisted on update too: `pending` -> `settled`/`failed` is the transition the audit
    // trail exists to record, and storing only the insert would keep a permanent lie.
    this.persistLedger(record);
  }

  /** Persists one ledger row, so the audit trail outlives the process. */
  private persistLedger(record: SettlementRecord): void {
    if (this.ledgerStore === undefined) return;
    const store = this.ledgerStore;
    // Chained on the request id so a terminal update cannot land before the insert it
    // supersedes. The key is namespaced to keep it out of the per-operator accrual chains.
    this.enqueueWrite(`ledger:${record.requestId}`, () =>
      store.put(record.requestId, record, this.maxLedgerEntries),
    );
  }

  /** Inserts a record and evicts the oldest once the ledger is full. */
  private remember(record: SettlementRecord): void {
    this.ledger.set(record.requestId, record);
    this.persistLedger(record);
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
