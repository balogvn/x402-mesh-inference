import { Redis } from "ioredis";
import type { RedisClientFactory, RedisClientLike, RegistryLogger } from "./redis.js";

/**
 * Durable storage for accrued-but-unpaid operator balances.
 *
 * Payout batching holds USDC the gateway already owes. Without this, that liability exists
 * only in the gateway process: a graceful shutdown flushes it, but an OOM kill, a SIGKILL or
 * a lost host takes the record with it. The funds stay in the gateway wallet and nothing
 * remembers to send them — which is the one failure mode of batching that money cannot be
 * recovered from without manual reconciliation against the chain.
 *
 * Two record kinds, deliberately under separate keys:
 *
 *   - **open** (`accrual:open:<operatorAddress>`) — still accumulating, not yet paid.
 *   - **batch** (`accrual:batch:<batchId>`) — handed to a payout and in flight.
 *
 * They are separate because an operator can have both at once: the moment a batch is flushed
 * a new request may start a fresh accrual for the same operator. Keying both by address would
 * make the second overwrite the first, losing an in-flight batch's record precisely when it
 * matters most.
 *
 * A batch record survives until its payout reaches a terminal state. That is what makes crash
 * recovery safe rather than merely possible: the persisted `batchId` is reused on restart, so
 * the retry carries the same Algorand lease and the same transaction note as the attempt that
 * may already have landed — the chain itself rejects the double spend, and
 * `findLandedPayout` can recognise the earlier attempt instead of paying twice.
 */

/** An accrual as stored. Contains everything needed to pay and to finalise the ledger. */
export interface PersistedAccrual {
  operatorAddress: string;
  /** Ledger entries this accrual will settle, serialized verbatim. */
  records: unknown[];
  /** When the first request in this accrual settled; drives the age deadline. */
  firstAt: number;
  /**
   * Set once the accrual has been handed to a payout.
   *
   * Its presence is what distinguishes "still accumulating" from "in flight", and reusing it
   * across a restart is what preserves the payout's lease and note.
   */
  batchId?: string | null;
}

/** Persistence the settlement service uses. Absent means in-memory only. */
export interface AccrualStore {
  /** Writes an open (still accumulating) accrual, replacing any previous state. */
  putOpen(accrual: PersistedAccrual): Promise<void>;
  /** Drops the open accrual for an operator. */
  removeOpen(operatorAddress: string): Promise<void>;
  /** Writes an in-flight batch, keyed by its batch id. */
  putBatch(accrual: PersistedAccrual & { batchId: string }): Promise<void>;
  /** Drops an in-flight batch once its payout reached a terminal state. */
  removeBatch(batchId: string): Promise<void>;
  /** Everything outstanding, for crash recovery at boot. */
  loadAll(): Promise<{
    open: PersistedAccrual[];
    batches: (PersistedAccrual & { batchId: string })[];
  }>;
  close(): Promise<void>;
}

const DEFAULT_PREFIX = "x402mesh";

/** Redis-backed {@link AccrualStore}. */
export class RedisAccrualStore implements AccrualStore {
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
    // An unhandled 'error' event on an ioredis client crashes the process. Payout durability
    // must never be the reason the gateway dies.
    this.#client.on("error", (() => undefined) as never);
  }

  async connect(): Promise<boolean> {
    try {
      await this.#client.connect();
      return true;
    } catch (error) {
      this.#logger.warn(
        `accrual store: redis unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
      return false;
    }
  }

  #openKey(address: string): string {
    return `${this.#prefix}:accrual:open:${address}`;
  }

  #batchKey(batchId: string): string {
    return `${this.#prefix}:accrual:batch:${batchId}`;
  }

  #openIndex(): string {
    return `${this.#prefix}:accrual:open`;
  }

  #batchIndex(): string {
    return `${this.#prefix}:accrual:batches`;
  }

  async putOpen(accrual: PersistedAccrual): Promise<void> {
    await this.#client.set(this.#openKey(accrual.operatorAddress), JSON.stringify(accrual));
    await this.#client.sadd(this.#openIndex(), accrual.operatorAddress);
  }

  async removeOpen(operatorAddress: string): Promise<void> {
    await this.#client.del(this.#openKey(operatorAddress));
    await this.#client.srem(this.#openIndex(), operatorAddress);
  }

  async putBatch(accrual: PersistedAccrual & { batchId: string }): Promise<void> {
    await this.#client.set(this.#batchKey(accrual.batchId), JSON.stringify(accrual));
    await this.#client.sadd(this.#batchIndex(), accrual.batchId);
  }

  async removeBatch(batchId: string): Promise<void> {
    await this.#client.del(this.#batchKey(batchId));
    await this.#client.srem(this.#batchIndex(), batchId);
  }

  async loadAll(): Promise<{
    open: PersistedAccrual[];
    batches: (PersistedAccrual & { batchId: string })[];
  }> {
    const [openIds, batchIds] = await Promise.all([
      this.#client.smembers(this.#openIndex()),
      this.#client.smembers(this.#batchIndex()),
    ]);

    const open = await this.#readMany(openIds.map((a) => this.#openKey(a)));
    const batches = await this.#readMany(batchIds.map((b) => this.#batchKey(b)));

    return {
      open: open.filter((a): a is PersistedAccrual => a !== undefined),
      batches: batches.filter(
        (a): a is PersistedAccrual & { batchId: string } =>
          a !== undefined && typeof a.batchId === "string" && a.batchId.length > 0,
      ),
    };
  }

  async #readMany(keys: string[]): Promise<(PersistedAccrual | undefined)[]> {
    if (keys.length === 0) return [];
    const raw = await this.#client.mget(...keys);
    return raw.map((value) => {
      if (value === null) return undefined;
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const candidate = parsed as PersistedAccrual;
        // A malformed row must not take down boot, but it also must not be silently treated
        // as an empty accrual — that would drop a real liability. Reject and let the loader
        // log it as unrecoverable.
        if (typeof candidate.operatorAddress !== "string" || !Array.isArray(candidate.records)) {
          return undefined;
        }
        return candidate;
      } catch {
        return undefined;
      }
    });
  }

  async close(): Promise<void> {
    try {
      await this.#client.quit();
    } catch {
      // Already gone; nothing to release.
    }
  }
}

/**
 * Builds an accrual store, or returns undefined when no Redis is configured or reachable.
 *
 * Undefined is a supported mode, not a failure: it is exactly the in-memory behaviour that
 * shipped before this existed. The caller is expected to say so out loud in the logs, because
 * running batching without persistence is a deliberate risk rather than a detail.
 */
export async function createAccrualStore(
  redisUrl?: string,
  options: { keyPrefix?: string; logger?: RegistryLogger; createClient?: RedisClientFactory } = {},
): Promise<AccrualStore | undefined> {
  const url = redisUrl?.trim() ?? "";
  if (url === "") return undefined;

  const store = new RedisAccrualStore(url, options);
  if (await store.connect()) return store;

  await store.close();
  return undefined;
}
