import type { NodeRecord } from "@x402-mesh/shared";

/**
 * Storage contract for the node registry.
 *
 * Two independent write paths converge on a {@link NodeRecord}, and the split matters:
 *
 * - **Operator-owned** state (`registration`, `usdcOptedIn`, `maxConcurrency`) arrives via
 *   {@link NodeStore.upsert} when a node registers or heartbeats.
 * - **Store-owned** state (latency percentiles, uptime, consecutive failures, in-flight count,
 *   request counters) is derived from {@link NodeStore.recordOutcome} and
 *   {@link NodeStore.beginRequest} / {@link NodeStore.endRequest}. An operator cannot forge it,
 *   and a re-registration must not reset it.
 */

/** One completed proxied request, fed into a node's rolling health window. */
export interface RequestOutcome {
  /** True when the node returned a usable response. */
  success: boolean;
  /** Wall-clock duration of the request in milliseconds. Non-finite values are coerced to 0. */
  latencyMs: number;
  /** Unix epoch milliseconds at which the request completed. */
  at: number;
}

/**
 * Async because the Redis-backed implementation is the deployment target; the in-memory
 * implementation satisfies the same signatures so the two are interchangeable at runtime.
 */
export interface NodeStore {
  /**
   * Creates or updates a node.
   *
   * For a node the store has never seen, `record` is stored as given. For an existing node the
   * store-owned fields listed on {@link NodeStore} are preserved and re-derived rather than
   * overwritten, so a heartbeat cannot erase accumulated health history.
   */
  upsert(record: NodeRecord): Promise<void>;

  /** Returns a snapshot of one node, or `null` if it is not registered. */
  get(nodeId: string): Promise<NodeRecord | null>;

  /** Returns snapshots of every registered node. Order is not guaranteed. */
  list(): Promise<NodeRecord[]>;

  /** Deregisters a node and discards its health window. Absent nodes are a no-op. */
  remove(nodeId: string): Promise<void>;

  /**
   * Appends a request outcome and re-derives the node's health.
   *
   * Outcomes for unknown nodes are dropped rather than throwing: a node may be deregistered
   * while one of its requests is still in flight, and that must not fail the request path.
   */
  recordOutcome(nodeId: string, o: RequestOutcome): Promise<void>;

  /** Increments the in-flight counter. Callers must pair this with {@link endRequest}. */
  beginRequest(nodeId: string): Promise<void>;

  /** Decrements the in-flight counter, saturating at zero. Safe to call more than once. */
  endRequest(nodeId: string): Promise<void>;

  /** Releases any underlying connection. The store must not be used afterwards. */
  close(): Promise<void>;
}
