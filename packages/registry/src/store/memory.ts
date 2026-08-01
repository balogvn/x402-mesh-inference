import type { NodeHealth, NodeRecord } from "@x402-mesh/shared";
import type { NodeStore, RequestOutcome } from "./types.js";

/**
 * In-memory node store — the authoritative implementation.
 *
 * Every health signal the router consumes is derived here from a bounded rolling window of
 * request outcomes. The Redis store reuses the same derivation functions so the two backends
 * cannot disagree about what "healthy" means.
 */

/** Outcomes retained per node. Bounded so a long-lived node cannot grow without limit. */
export const HEALTH_WINDOW_SIZE = 100;

/**
 * Consecutive failures that trip a node out of the routable set.
 *
 * Three is deliberately small: an unhealthy node still receives traffic through the selector's
 * weight floor once it recovers, so the cost of a false positive is a brief detour, while the
 * cost of a false negative is paying for failed inference.
 */
export const UNHEALTHY_CONSECUTIVE_FAILURES = 3;

/** Clamps a score-like value into the closed unit interval. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Nearest-rank percentile of an **ascending-sorted** sample.
 *
 * Uses the nearest-rank definition (`rank = ceil(p/100 * N)`, 1-indexed) rather than linear
 * interpolation, so every result is an observed latency rather than a synthetic value between
 * two observations — which is what an operator expects when they read "p95" off a dashboard.
 *
 * @param sorted Ascending-sorted samples. Passing an unsorted array yields a meaningless result.
 * @param p Percentile in `[0, 100]`. Values outside the range are clamped.
 * @returns The sample at the nearest rank, or `0` for an empty window (never `NaN`).
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const clampedP = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
  const rank = Math.ceil((clampedP / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

/**
 * Coerces a caller-supplied outcome into a sane record.
 *
 * A `NaN` latency from a botched timer would poison every percentile derived from the window
 * forever, so it is normalized at the boundary instead of being trusted.
 */
export function normalizeOutcome(o: RequestOutcome): RequestOutcome {
  const latencyMs = Number.isFinite(o.latencyMs) && o.latencyMs >= 0 ? o.latencyMs : 0;
  const at = Number.isFinite(o.at) && o.at > 0 ? Math.trunc(o.at) : 0;
  return { success: o.success === true, latencyMs, at };
}

/**
 * Recomputes the window-derived fields of a node's health.
 *
 * `base` supplies the fields this function does not own — `nodeId`, `inFlight`,
 * `maxConcurrency` and the previous `lastSeenAt`. An empty window returns `base` unchanged so
 * that a freshly registered node keeps whatever health its registrar assigned rather than being
 * forced to a fabricated default.
 */
export function deriveHealth(base: NodeHealth, window: readonly RequestOutcome[]): NodeHealth {
  if (window.length === 0) return { ...base };

  const latencies = window.map((o) => o.latencyMs).sort((a, b) => a - b);

  let successes = 0;
  let lastSeenAt = base.lastSeenAt;
  for (const o of window) {
    if (!o.success) continue;
    successes += 1;
    if (o.at > lastSeenAt) lastSeenAt = o.at;
  }

  // The window is oldest-first, so the current failure streak is its trailing run.
  let consecutiveFailures = 0;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if (window[i]?.success !== false) break;
    consecutiveFailures += 1;
  }

  const uptimeRatio = clamp01(successes / window.length);
  // A node decays linearly to zero quality as it approaches the failure threshold, so the
  // selector starts shedding load *before* the node is formally evicted.
  const failurePenalty = Math.max(0, 1 - consecutiveFailures / UNHEALTHY_CONSECUTIVE_FAILURES);

  return {
    nodeId: base.nodeId,
    healthy: consecutiveFailures < UNHEALTHY_CONSECUTIVE_FAILURES,
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
    inFlight: base.inFlight,
    maxConcurrency: base.maxConcurrency,
    uptimeRatio,
    qualityScore: clamp01(uptimeRatio * failurePenalty),
    consecutiveFailures,
    lastSeenAt,
  };
}

/** Structural copy, so a caller holding a returned record cannot mutate stored state. */
export function cloneRecord(r: NodeRecord): NodeRecord {
  return {
    registration: {
      ...r.registration,
      capabilities: r.registration.capabilities.map((c) => ({ ...c })),
    },
    health: { ...r.health },
    usdcOptedIn: r.usdcOptedIn,
    totalRequests: r.totalRequests,
    totalPaidAtomic: r.totalPaidAtomic,
    registeredAt: r.registeredAt,
  };
}

/** Parses an atomic decimal-integer string, or `null` when it is not one. */
function tryAtomic(s: string): bigint | null {
  return typeof s === "string" && /^\d+$/.test(s) ? BigInt(s) : null;
}

/**
 * Picks the larger of two atomic USDC amounts.
 *
 * Comparison happens in `bigint`; the amounts are never converted to a JS number, and the
 * winning string is returned verbatim rather than re-rendered.
 */
function maxAtomic(a: string, b: string): string {
  const av = tryAtomic(a);
  const bv = tryAtomic(b);
  if (av === null) return bv === null ? "0" : b;
  if (bv === null) return a;
  return av >= bv ? a : b;
}

/**
 * Merges an incoming registration/heartbeat over whatever the store already holds.
 *
 * Shared by both store backends so that "what a heartbeat is allowed to change" has exactly one
 * definition. The rules:
 *
 * - `inFlight` comes from `existing`; it is owned by `beginRequest`/`endRequest`.
 * - `registeredAt` keeps the first registration time.
 * - `totalRequests` and `totalPaidAtomic` are monotonic — a heartbeat carrying stale counters
 *   cannot roll lifetime totals backwards.
 * - Window-derived health is recomputed from the retained window, so an operator cannot
 *   self-report a clean bill of health.
 * - An explicit `healthy: false` from the caller still wins: a heartbeat monitor observes
 *   liveness signals the outcome window does not. `healthy: true` remains subject to the
 *   failure threshold, and a subsequent success re-derives it back to true.
 */
export function mergeRecord(
  existing: NodeRecord | null,
  incoming: NodeRecord,
  window: readonly RequestOutcome[],
): NodeRecord {
  const next = cloneRecord(incoming);
  if (existing === null) return next;

  next.health.inFlight = existing.health.inFlight;
  next.registeredAt = existing.registeredAt;
  next.totalRequests = Math.max(existing.totalRequests, incoming.totalRequests);
  next.totalPaidAtomic = maxAtomic(existing.totalPaidAtomic, incoming.totalPaidAtomic);
  next.health.lastSeenAt = Math.max(existing.health.lastSeenAt, incoming.health.lastSeenAt);

  if (window.length > 0) {
    const derived = deriveHealth(next.health, window);
    derived.healthy = incoming.health.healthy && derived.healthy;
    next.health = derived;
  }
  return next;
}

/**
 * Process-local {@link NodeStore}. Used directly for single-instance deployments and tests, and
 * as the degraded-mode fallback inside `RedisNodeStore`.
 */
export class MemoryNodeStore implements NodeStore {
  readonly #records = new Map<string, NodeRecord>();
  readonly #windows = new Map<string, RequestOutcome[]>();

  async upsert(record: NodeRecord): Promise<void> {
    const nodeId = record.registration.nodeId;
    const existing = this.#records.get(nodeId) ?? null;
    const window = this.#windows.get(nodeId) ?? [];
    this.#records.set(nodeId, mergeRecord(existing, record, window));
    if (!this.#windows.has(nodeId)) this.#windows.set(nodeId, window);
  }

  async get(nodeId: string): Promise<NodeRecord | null> {
    const record = this.#records.get(nodeId);
    return record === undefined ? null : cloneRecord(record);
  }

  async list(): Promise<NodeRecord[]> {
    return [...this.#records.values()].map(cloneRecord);
  }

  async remove(nodeId: string): Promise<void> {
    this.#records.delete(nodeId);
    this.#windows.delete(nodeId);
  }

  async recordOutcome(nodeId: string, o: RequestOutcome): Promise<void> {
    const record = this.#records.get(nodeId);
    if (record === undefined) return;

    const window = this.#windows.get(nodeId) ?? [];
    window.push(normalizeOutcome(o));
    if (window.length > HEALTH_WINDOW_SIZE) {
      window.splice(0, window.length - HEALTH_WINDOW_SIZE);
    }
    this.#windows.set(nodeId, window);

    record.totalRequests += 1;
    record.health = deriveHealth(record.health, window);
  }

  async beginRequest(nodeId: string): Promise<void> {
    const record = this.#records.get(nodeId);
    if (record !== undefined) record.health.inFlight += 1;
  }

  async endRequest(nodeId: string): Promise<void> {
    const record = this.#records.get(nodeId);
    if (record !== undefined) {
      record.health.inFlight = Math.max(0, record.health.inFlight - 1);
    }
  }

  async close(): Promise<void> {
    this.#records.clear();
    this.#windows.clear();
  }
}
