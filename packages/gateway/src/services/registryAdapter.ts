import type { NodeRecord, NodeSelection } from "@x402-mesh/shared";
import type { NodeSelector, NodeStore } from "@x402-mesh/registry";
import type {
  Clock,
  NodeOutcome,
  NodeSelectionCriteria,
  NodeSelectorPort,
  NodeStorePort,
} from "../ports.js";

/**
 * Adapters from `@x402-mesh/registry` onto the gateway's ports.
 *
 * The two packages describe the same concepts with deliberately different shapes: the
 * registry is async-first (its deployment target is Redis) and keeps health accounting on
 * the *store*, while the gateway's ports are written around what a request handler needs.
 * Reconciling them here — rather than bending either side — keeps the registry reusable
 * outside the gateway and keeps the gateway testable without the registry.
 *
 * Two small impedance mismatches are handled:
 *
 * - The registry returns `null` for a missing node; the gateway's ports use `undefined`,
 *   matching `Map.get` and optional-chaining ergonomics.
 * - The registry has no `heartbeat` operation. A heartbeat is expressed as an `upsert` of
 *   the stored record with a fresh `lastSeenAt`, which is exactly what `mergeRecord` is
 *   designed to absorb: it keeps store-owned health, monotonic counters and the original
 *   registration time, so a heartbeat cannot launder a node's reputation.
 */

/** Wraps a registry {@link NodeStore} as a {@link NodeStorePort}. */
export class RegistryStoreAdapter implements NodeStorePort {
  constructor(private readonly store: NodeStore) {}

  /**
   * Stores `record` and returns what the store actually kept.
   *
   * The re-read matters: `upsert` merges rather than replaces, so the caller's copy is not
   * the authoritative one — returning it would report health the store just discarded.
   */
  async upsert(record: NodeRecord): Promise<NodeRecord> {
    await this.store.upsert(record);
    return (await this.store.get(record.registration.nodeId)) ?? record;
  }

  async get(nodeId: string): Promise<NodeRecord | undefined> {
    return (await this.store.get(nodeId)) ?? undefined;
  }

  async list(): Promise<NodeRecord[]> {
    return await this.store.list();
  }

  async heartbeat(nodeId: string, at: number): Promise<NodeRecord | undefined> {
    const existing = await this.store.get(nodeId);
    if (existing === null) return undefined;
    await this.store.upsert({
      ...existing,
      health: {
        ...existing.health,
        lastSeenAt: at,
        // A node that just spoke is alive. `mergeRecord` still re-derives window health, so
        // this cannot override a node the failure threshold has benched.
        healthy: true,
        consecutiveFailures: 0,
      },
    });
    return (await this.store.get(nodeId)) ?? undefined;
  }
}

/**
 * Wraps a registry {@link NodeSelector} as a {@link NodeSelectorPort}.
 *
 * The in-flight bracket and outcome recording go to the *store*, which is where the registry
 * keeps them — the selector deliberately does not reserve capacity, because only the caller
 * knows when the request it is about to issue finishes.
 */
export class RegistrySelectorAdapter implements NodeSelectorPort {
  constructor(
    private readonly selector: NodeSelector,
    private readonly store: NodeStore,
    private readonly now: Clock = Date.now,
  ) {}

  async select(criteria: NodeSelectionCriteria): Promise<NodeSelection> {
    return await this.selector.select(criteria.model, {
      excludeNodeIds: [...(criteria.excludeNodeIds ?? [])],
    });
  }

  async beginRequest(nodeId: string): Promise<void> {
    await this.store.beginRequest(nodeId);
  }

  async endRequest(nodeId: string): Promise<void> {
    await this.store.endRequest(nodeId);
  }

  async recordOutcome(nodeId: string, outcome: NodeOutcome): Promise<void> {
    await this.store.recordOutcome(nodeId, {
      success: outcome.success,
      latencyMs: outcome.latencyMs,
      at: this.now(),
    });
  }
}
