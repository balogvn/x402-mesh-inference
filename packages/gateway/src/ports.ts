import type {
  Atomic,
  ChatCompletionRequest,
  NodeRecord,
  NodeSelection,
  SettlementRecord,
} from "@x402-mesh/shared";

/**
 * Every collaborator the gateway talks to, expressed as a narrow port.
 *
 * The gateway owns no persistence, no chain client and no inference backend; it orchestrates
 * them. Keeping each collaborator behind an interface is what lets `createApp` be built in a
 * unit test with no network, no wallet and no Redis, which is the only way the payment,
 * routing and settlement paths can be exercised deterministically.
 *
 * Methods are declared with `| Promise<T>` returns where an implementation could reasonably
 * be either synchronous (in-memory) or asynchronous (Redis, algod); call sites always
 * `await`, so both satisfy the contract.
 */

/** A monotonically-usable source of wall-clock milliseconds. Injected so tests can freeze it. */
export type Clock = () => number;

/** Sleep helper, injected so retry backoff is instant under test. */
export type Sleep = (ms: number) => Promise<void>;

/** Persistence for node registrations and their health. */
export interface NodeStorePort {
  /** Inserts or replaces a node record, returning the stored value. */
  upsert(record: NodeRecord): NodeRecord | Promise<NodeRecord>;
  /** Returns the record for `nodeId`, or undefined when it is not registered. */
  get(nodeId: string): NodeRecord | undefined | Promise<NodeRecord | undefined>;
  /** Returns every registered node. */
  list(): NodeRecord[] | Promise<NodeRecord[]>;
  /** Refreshes liveness for an already-registered node. Returns undefined when unknown. */
  heartbeat(nodeId: string, at: number): NodeRecord | undefined | Promise<NodeRecord | undefined>;
}

/** Criteria the router hands the selector. */
export interface NodeSelectionCriteria {
  /** Model the client asked for. */
  model: string;
  /** Nodes that already failed this request and must not be chosen again. */
  excludeNodeIds?: readonly string[];
}

/** Outcome of one upstream call, fed back into health tracking. */
export interface NodeOutcome {
  success: boolean;
  latencyMs: number;
  /** Short, non-sensitive failure summary. Omitted on success. */
  error?: string;
}

/** Chooses which node serves a request and tracks the consequences. */
export interface NodeSelectorPort {
  /**
   * Picks the best healthy node for `criteria`.
   *
   * @throws {NoCapacityError} when no eligible node exists.
   */
  select(criteria: NodeSelectionCriteria): NodeSelection | Promise<NodeSelection>;
  /** Marks one more request in flight against `nodeId`. */
  beginRequest(nodeId: string): void | Promise<void>;
  /** Releases an in-flight slot. Must be called in a `finally`. */
  endRequest(nodeId: string): void | Promise<void>;
  /** Records latency/success so the score reflects reality. */
  recordOutcome(nodeId: string, outcome: NodeOutcome): void | Promise<void>;
}

/** Read-only chain queries the gateway needs (opt-in checks, funding checks). */
export interface ChainReaderPort {
  /** True when `address` holds the ASA `assetId` (i.e. has opted in). */
  isOptedIn(address: string, assetId: string): Promise<boolean>;
  /** Spendable ALGO balance in microAlgos. Used by `/readyz` to catch an unfunded wallet. */
  getAlgoBalanceMicro(address: string): Promise<bigint>;
}

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
}

/** Where a streamed upstream response is written. */
export interface StreamSink {
  /**
   * Called once before the first chunk, with the upstream content type.
   * Implementations must flush headers here so the client sees bytes immediately.
   */
  begin(contentType: string): void;
  /** Forwards one upstream chunk verbatim. */
  write(chunk: Uint8Array): void;
  /** Terminates the stream. Called exactly once, including on error. */
  end(): void;
}

/** Input to one routed inference request. */
export interface RouteInput {
  requestId: string;
  request: ChatCompletionRequest;
  /** Aborted when the client disconnects; the router propagates it to the upstream fetch. */
  signal: AbortSignal;
  /** Supplied when the client asked for `stream: true`. */
  sink?: StreamSink;
  /**
   * Called with each node the router commits to, before any bytes move.
   *
   * This is the only point at which the caller can still set response headers on a streamed
   * request, and it is where the settlement routing note is written — so a retry onto a
   * second node overwrites the first note and the payout follows the node that actually
   * served. Must not throw.
   */
  onNodeSelected?: (node: NodeRecord) => void;
}

/** Result of one routed inference request. */
export interface RouteResult {
  /** The node that ultimately served the request. */
  node: NodeRecord;
  /** Parsed upstream body. Present only for non-streaming responses. */
  body?: unknown;
  /** Wall-clock duration of the successful upstream call. */
  latencyMs: number;
  /** How many nodes were tried, including the successful one. */
  attempts: number;
}

/** Selects a node and proxies the request to it. */
export interface RouterPort {
  route(input: RouteInput): Promise<RouteResult>;
}
