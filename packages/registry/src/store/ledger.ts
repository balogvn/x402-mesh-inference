import { Redis } from "ioredis";
import type { RedisClientFactory, RedisClientLike, RegistryLogger } from "./redis.js";

/**
 * Durable storage for the settlement audit ledger.
 *
 * The ledger records every request's three money legs, both transaction ids and a terminal
 * status. It lived only in the gateway process, so a routine deploy erased it: after a
 * restart `/v1/settlements` reported a handful of rows from whatever had happened since boot,
 * and everything before was gone.
 *
 * That is survivable — the chain is the real record, and every payout carries a
 * `x402-mesh/payout/...` note that makes it findable — but an audit trail that resets on
 * deploy is not much of an audit trail. It is also the only place the `inbound - payout =
 * margin` split is written down per request; the chain shows the transfer, not the accounting
 * behind it.
 *
 * Two structures, mirroring how the in-memory ledger already worked:
 *
 *   - `ledger:record:<requestId>` — the record itself.
 *   - `ledger:order` — a capped list of request ids, newest first, so reads are ordered
 *     without sorting and eviction is a trim rather than a scan.
 *
 * Writes are best-effort relative to settling: a Redis outage costs history, never a payout.
 */

/** Storage the settlement service uses for its audit ledger. Absent means memory only. */
export interface LedgerStore {
  /** Inserts or replaces one record, keeping the newest-first order and the entry cap. */
  put(requestId: string, record: unknown, maxEntries: number): Promise<void>;
  /** Newest-first, at most `limit` records. Used to rehydrate at boot. */
  loadRecent(limit: number): Promise<unknown[]>;
  close(): Promise<void>;
}

const DEFAULT_PREFIX = "x402mesh";

/** Redis-backed {@link LedgerStore}. */
export class RedisLedgerStore implements LedgerStore {
  readonly #client: RedisClientLike;
  readonly #prefix: string;
  readonly #logger: RegistryLogger;

  constructor(
    url: string,
    options: {
      keyPrefix?: string;
      logger?: RegistryLogger;
      createClient?: RedisClientFactory;
    } = {},
  ) {
    const factory = options.createClient ?? ((u: string) => new Redis(u, { lazyConnect: true }));
    this.#client = factory(url);
    this.#prefix = options.keyPrefix ?? DEFAULT_PREFIX;
    this.#logger = options.logger ?? console;
    // An unhandled 'error' event on an ioredis client takes the process down. Losing audit
    // history is acceptable; losing the gateway over it is not.
    this.#client.on("error", (() => undefined) as never);
  }

  async connect(): Promise<boolean> {
    try {
      await this.#client.connect();
      return true;
    } catch (error) {
      this.#logger.warn(
        `ledger store: redis unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
      return false;
    }
  }

  #recordKey(requestId: string): string {
    return `${this.#prefix}:ledger:record:${requestId}`;
  }

  #orderKey(): string {
    return `${this.#prefix}:ledger:order`;
  }

  async put(requestId: string, record: unknown, maxEntries: number): Promise<void> {
    const key = this.#recordKey(requestId);
    const existed = (await this.#client.get(key)) !== null;
    await this.#client.set(key, JSON.stringify(record));

    // Only a NEW request extends the order list. An update — a payout reaching a terminal
    // state — rewrites the record in place; pushing again would list the same id twice and
    // evict a genuinely older entry to make room for the duplicate.
    if (existed) return;

    await this.#client.lpush(this.#orderKey(), requestId);

    // Trim to the cap, deleting the records that fall off. `ltrim` does not report what it
    // dropped, so the ids are read before trimming — otherwise every evicted record leaks its
    // key forever and the keyspace grows without bound.
    const overflow = await this.#client.lrange(this.#orderKey(), maxEntries, -1);
    if (overflow.length > 0) {
      await this.#client.ltrim(this.#orderKey(), 0, maxEntries - 1);
      await this.#client.del(...overflow.map((id) => this.#recordKey(id)));
    }
  }

  async loadRecent(limit: number): Promise<unknown[]> {
    const ids = await this.#client.lrange(this.#orderKey(), 0, limit - 1);
    if (ids.length === 0) return [];

    const raw = await this.#client.mget(...ids.map((id) => this.#recordKey(id)));
    const records: unknown[] = [];
    for (const value of raw) {
      if (value === null) continue;
      try {
        records.push(JSON.parse(value));
      } catch {
        // A single corrupt row must not stop the rest of the history loading.
      }
    }
    return records;
  }

  async close(): Promise<void> {
    try {
      await this.#client.quit();
    } catch {
      // Already gone.
    }
  }
}

/**
 * Builds a ledger store, or returns undefined when Redis is absent or unusable.
 *
 * Undefined is the pre-existing in-memory behaviour, not a failure. Constructing the client is
 * inside the try because `new Redis(url)` parses eagerly and throws on a malformed URL — the
 * same trap that crash-looped the gateway when durable accruals were added.
 */
export async function createLedgerStore(
  redisUrl?: string,
  options: { keyPrefix?: string; logger?: RegistryLogger; createClient?: RedisClientFactory } = {},
): Promise<LedgerStore | undefined> {
  const url = redisUrl?.trim() ?? "";
  if (url === "") return undefined;

  let store: RedisLedgerStore;
  try {
    store = new RedisLedgerStore(url, options);
  } catch (error) {
    (options.logger ?? console).warn(
      `ledger store: unusable REDIS_URL (${error instanceof Error ? error.message : String(error)}); settlement history will not survive a restart`,
    );
    return undefined;
  }

  if (await store.connect()) return store;
  await store.close();
  return undefined;
}
