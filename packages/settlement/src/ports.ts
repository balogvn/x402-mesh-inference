/**
 * The contracts the settlement core is written against.
 *
 * Everything here is an interface the host application supplies. The package
 * knows how to split a payment and how to amortize a payout fee; it knows
 * nothing about Algorand, Express, Redis, or inference — those arrive through
 * these ports.
 *
 * Extracted from the gateway so the settlement logic can be depended on without
 * dragging a web server in behind it. `@x402-mesh/gateway` re-exports every name
 * here, so nothing downstream had to change.
 */

import type { Atomic, SettlementRecord } from "@x402-mesh/shared";

export type { Atomic, SettlementRecord };

/** A monotonically-usable source of wall-clock milliseconds. Injected so tests can freeze it. */
export type Clock = () => number;

/** Sleep helper, injected so retry backoff is instant under test. */
export type Sleep = (ms: number) => Promise<void>;

/** One outbound USDC payout. */
export interface PayoutRequest {
  /** Operator address receiving the funds. Must be opted in to the ASA. */
  receiver: string;
  /** Amount in integer atomic units. */
  amountAtomic: Atomic;
  /** USDC ASA id as a decimal string. */
  assetId: string;
  /** Request id, embedded in the transaction note and lease for on-chain traceability. */
  requestId: string;
}

/** Moves USDC from the gateway wallet to a node operator. */
export interface UsdcPayoutPort {
  /** Algorand address funds leave from. */
  readonly senderAddress: string;
  /** Submits and confirms the transfer, returning the confirmed transaction id. */
  pay(request: PayoutRequest): Promise<{ txId: string }>;
  /**
   * Asks the chain whether a payout for this request has already committed.
   *
   * `pay` can submit a transaction successfully and then throw while waiting for
   * confirmation — a timeout, a dropped connection, an algod hiccup. The money has moved; the
   * caller just never heard so. Without this, the ledger records `failed` for a payout that
   * landed, which is worse than a cosmetic error: an operator is told they were not paid, and
   * any "retry the failed payouts" reconciliation would pay them a second time.
   *
   * Observed on MainNet: payout BRW5GM5FQJJHLICDTTXNJH3BNRBRVP7RCS6C4FMGYTCTRPOCFO4Q landed
   * while its ledger row said `failed` with a null payoutTxId.
   *
   * Optional so tests and alternative payers need not implement chain search; when absent the
   * caller falls back to trusting `pay`, which is the old behaviour.
   */
  findLandedPayout?(requestId: string, receiver: string): Promise<{ txId: string } | undefined>;
}

/** The inbound (client -> gateway) leg, as reported by the facilitator after settlement. */
export interface InboundSettlement {
  requestId: string;
  /** Algorand address that paid. */
  payerAddress: string;
  /** Confirmed inbound transaction id. */
  inboundTxId: string;
  /** Amount actually settled, in integer atomic units. */
  inboundAtomic: Atomic;
}

/**
 * One unpaid liability, as reported by `GET /v1/payouts/pending`.
 *
 * Covers both money still accruing toward a payout and money already handed to a payout that
 * has not discharged it. The second kind used to be omitted entirely, so a batch whose payout
 * kept failing was invisible on the one endpoint that exists to answer "what am I owed".
 */
export interface PendingPayout {
  operatorAddress: string;
  /** Sum owed, in atomic USDC units, as a decimal string. */
  owedAtomic: string;
  /** How many settled requests make up that sum. */
  requests: number;
  /** When the oldest request in this liability settled. */
  oldestAt: number;
  /**
   * Where this money is in its lifecycle.
   *
   * - `accruing` — still collecting; will flush on threshold or deadline.
   * - `paying`   — handed to a payout, not yet confirmed.
   * - `stuck`    — a payout attempt failed. Still owed, and retried on the next boot, but
   *   something is wrong: a receiver not opted in to USDC never resolves on its own.
   */
  state: "accruing" | "paying" | "stuck";
  /** Set only while `accruing`: when it pays out even if it never reaches the threshold. */
  deadlineAt?: number;
  /** Set once carved off. The id the payout carries as its Algorand lease and note. */
  batchId?: string;
  /** Payout attempts made against this batch in the current process. */
  attempts?: number;
  /** Why the last attempt failed. Present only when `stuck`. */
  lastError?: string;
  /** When the last attempt failed. Present only when `stuck`. */
  lastAttemptAt?: number;
}

/** Orchestrates the second settlement leg and owns the audit ledger. */
export interface SettlementServicePort {
  /**
   * Records which node served `requestId` so the payout can be addressed once the inbound
   * leg confirms. Called by the chat route as soon as a node is chosen.
   */
  recordRouting(requestId: string, nodeId: string, operatorAddress: string): void;
  /**
   * Accepts a confirmed inbound payment and schedules the operator payout.
   *
   * Never throws and never blocks the client response: failures are retried out of band and
   * ultimately land in the ledger as `failed`.
   */
  settleInbound(inbound: InboundSettlement): void;
  /** Audit trail, newest first. Served by `GET /v1/settlements`. */
  getSettlementLedger(): SettlementRecord[];
  /** Resolves when no payout is in flight. Test-only affordance; cheap in production. */
  whenIdle(): Promise<void>;
  /**
   * Pays out every accrued balance immediately, regardless of threshold or age.
   *
   * Called on graceful shutdown. With batching enabled the gateway holds funds it already
   * owes operators, and that liability lives in memory — so a deploy that exits without
   * flushing loses the record of who is owed what. This is the difference between a restart
   * being routine and a restart costing operators money.
   *
   * Resolves once every flush has reached a terminal state. Never throws: a failed flush is
   * recorded and logged like any other failed payout.
   */
  flushPayouts(): Promise<void>;
  /** What is currently owed but unpaid, by operator. Served by `GET /v1/payouts/pending`. */
  getPendingPayouts(): PendingPayout[];
}

/**
 * The subset of a structured logger this package uses.
 *
 * Declared structurally rather than imported so the host can pass pino, console,
 * or a test double without this package caring which.
 */
export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Tracing hook, injected because the span helper belongs to the host's telemetry
 * setup. Defaults to a pass-through, so tracing is optional and free when unused.
 */
export type WithSpan = <T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
) => Promise<T>;
