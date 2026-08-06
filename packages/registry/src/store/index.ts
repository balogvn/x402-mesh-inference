import { MemoryNodeStore } from "./memory.js";
import { RedisNodeStore, type RedisNodeStoreOptions } from "./redis.js";
import type { NodeStore } from "./types.js";

/**
 * Builds the appropriate {@link NodeStore} for the environment.
 *
 * Redis is used when a URL is supplied *and* the connection succeeds. An unreachable Redis
 * yields a {@link MemoryNodeStore} rather than an error: single-instance and local development
 * runs are first-class, and a cache outage should degrade routing quality, not stop it.
 *
 * @param redisUrl Connection URL, e.g. `redis://localhost:6379`. Blank or absent selects memory.
 * @param options Forwarded to {@link RedisNodeStore}; ignored when memory is selected.
 */
export async function createNodeStore(
  redisUrl?: string,
  options: RedisNodeStoreOptions = {},
): Promise<NodeStore> {
  const url = redisUrl?.trim() ?? "";
  if (url === "") return new MemoryNodeStore();

  const store = new RedisNodeStore(url, options);
  if (await store.connect()) return store;

  // The failed store already logged; release its client before discarding it.
  await store.close();
  return new MemoryNodeStore();
}

export { MemoryNodeStore } from "./memory.js";
export {
  HEALTH_WINDOW_SIZE,
  UNHEALTHY_CONSECUTIVE_FAILURES,
  deriveHealth,
  mergeRecord,
  percentile,
} from "./memory.js";
export { RedisNodeStore } from "./redis.js";
export type {
  RedisClientFactory,
  RedisClientLike,
  RedisNodeStoreOptions,
  RegistryLogger,
} from "./redis.js";
export type { NodeStore, RequestOutcome } from "./types.js";

export { RedisAccrualStore, createAccrualStore } from "./accruals.js";
export type { AccrualStore, PersistedAccrual } from "./accruals.js";

export { RedisLedgerStore, createLedgerStore } from "./ledger.js";
export type { LedgerStore } from "./ledger.js";
