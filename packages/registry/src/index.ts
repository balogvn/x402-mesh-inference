/**
 * `@x402-mesh/registry` — node health aggregation and request routing.
 *
 * Two concerns live here. The **store** owns every health signal the mesh trusts, derived from
 * observed request outcomes rather than operator self-reporting. The **selector** turns those
 * signals into a route, filtering on hard eligibility and then spreading load across the
 * survivors in proportion to their score.
 *
 * Depends only on `@x402-mesh/shared`; it must never import from the gateway or the node daemon.
 */

export {
  HEALTH_WINDOW_SIZE,
  MemoryNodeStore,
  RedisNodeStore,
  UNHEALTHY_CONSECUTIVE_FAILURES,
  createNodeStore,
  deriveHealth,
  mergeRecord,
  percentile,
} from "./store/index.js";
export type {
  NodeStore,
  RedisClientFactory,
  RedisClientLike,
  RedisNodeStoreOptions,
  RegistryLogger,
  RequestOutcome,
} from "./store/index.js";

export { DEFAULT_WEIGHTS, NodeSelector, nodePriceAtomic, scoreNode } from "./selector/index.js";
export type {
  NodeSelectorOptions,
  ScoreContext,
  ScoreWeights,
  SelectOptions,
} from "./selector/index.js";

export { RedisAccrualStore, createAccrualStore } from "./store/accruals.js";
export type { AccrualStore, PersistedAccrual } from "./store/accruals.js";

export { RedisLedgerStore, createLedgerStore } from "./store/ledger.js";
export type { LedgerStore } from "./store/ledger.js";
