import type { ChatCompletionRequest, NodeRecord, NodeSelection } from "@x402-mesh/shared";

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

/*
  Settlement contracts now live in @x402-mesh/settlement, which is where the code
  that consumes them lives. Re-exported here so every existing import keeps
  working — the move is a package boundary, not an API change.
*/
export type {
  Clock,
  Sleep,
  PayoutRequest,
  UsdcPayoutPort,
  InboundSettlement,
  PendingPayout,
  SettlementServicePort,
} from "@x402-mesh/settlement";
