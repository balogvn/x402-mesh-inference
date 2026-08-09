/**
 * Whether a node can serve *anything* right now.
 *
 * This exists because two places were answering that question with different code and quietly
 * disagreeing. `NodeSelector.select()` rejected nodes on the wrong chain, nodes that had stopped
 * heartbeating, and nodes not opted in to USDC. The gateway's `/readyz` check applied only
 * `healthy && (usdcOptedIn || !requireUsdcOptIn)` — no network test, no staleness test — and so
 * reported "2/2 nodes routable" on a live MainNet gateway whose second node was a TestNet node
 * the selector refused to route to. Real capacity was 1/2.
 *
 * A readiness endpoint that over-reports capacity is worse than one that under-reports: it hides
 * an outage until traffic fails, which is the moment it was supposed to warn about.
 *
 * The checks here are exactly the **model-independent** subset of the selector's eligibility
 * rules. Model fit, saturation and priceability are deliberately excluded: they answer "can this
 * node serve THIS request", which is a different question from "is this node part of the mesh's
 * usable capacity".
 */

import type { NodeRecord } from "@x402-mesh/shared";

/** Why a node cannot serve any request. Ordered as the selector evaluates them. */
export type UnroutableReason = "wrongNetwork" | "stale" | "unhealthy" | "notOptedIn";

export interface RoutabilityOptions {
  /** Canonical CAIP-2 the gateway settles on. Omit to skip the network test. */
  network?: string | undefined;
  /** How long since the last heartbeat before a node counts as gone. Omit to skip. */
  staleAfterMs?: number | undefined;
  /** Injected so tests can pin time. */
  now?: (() => number) | undefined;
}

/**
 * Returns why `record` cannot serve any request, or `null` if it can.
 *
 * @param record - The stored node.
 * @param options - Gateway-level constraints. Both are optional so a caller that genuinely does
 *   not know the network (a test, a tool) degrades to the health and opt-in checks rather than
 *   silently treating every node as wrong-network.
 */
export function unroutableReason(
  record: NodeRecord,
  options: RoutabilityOptions = {},
): UnroutableReason | null {
  const now = options.now ?? Date.now;

  // Before health, deliberately: a node on the wrong chain is not unhealthy, it is irrelevant,
  // and calling it unhealthy sends an operator chasing a node that is fine.
  if (options.network !== undefined && record.registration.network !== options.network) {
    return "wrongNetwork";
  }
  // Before the health flag: a node that stopped heartbeating is gone whatever its last recorded
  // health said. Without this, that flag is a memory of when the node was last reachable rather
  // than a statement about now.
  if (
    options.staleAfterMs !== undefined &&
    now() - record.health.lastSeenAt > options.staleAfterMs
  ) {
    return "stale";
  }
  if (!record.health.healthy) return "unhealthy";
  // Unconditional, matching the selector. A node that cannot receive USDC cannot be paid, and
  // routing paid traffic to it manufactures a liability that can never be discharged — which is
  // exactly how 0.0153 USDC ended up permanently owed to a node whose address was not opted in.
  if (!record.usdcOptedIn) return "notOptedIn";
  return null;
}

/** Convenience wrapper for the common "is it usable" question. */
export function isRoutable(record: NodeRecord, options: RoutabilityOptions = {}): boolean {
  return unroutableReason(record, options) === null;
}
