import { Redis } from "ioredis";
import { NodeRecordSchema, type NodeRecord } from "@x402-mesh/shared";
import type { NodeStore, RequestOutcome } from "./types.js";
import {
  HEALTH_WINDOW_SIZE,
  MemoryNodeStore,
  deriveHealth,
  mergeRecord,
  normalizeOutcome,
} from "./memory.js";

/**
 * Redis-backed {@link NodeStore} for multi-instance gateway deployments.
 *
 * The defining property is **graceful degradation**. A registry outage must not become a
 * marketplace outage: if Redis is unreachable the store logs exactly once, flips to a
 * process-local {@link MemoryNodeStore} and keeps serving. Every mutation is also written
 * through to that mirror while Redis is up, so a mid-flight failover inherits warm data for the
 * nodes this instance has touched rather than an empty registry.
 *
 * The mirror only knows about nodes *this* process wrote. After a failover, nodes registered
 * exclusively against other instances are invisible until they heartbeat here — an accepted
 * trade for staying available.
 */

/** Redis commands this store uses. Narrow on purpose, so tests can supply a stub client. */
export interface RedisClientLike {
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  lpush(key: string, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  quit(): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/** Builds the client for a connection URL. Overridable so tests never need a live Redis. */
export type RedisClientFactory = (url: string) => RedisClientLike;

/** Only `warn` is used, so a bare `{ warn }` object satisfies this in tests. */
export type RegistryLogger = Pick<Console, "warn">;

export interface RedisNodeStoreOptions {
  /** Namespace for every key this store owns. Defaults to `x402mesh`. */
  keyPrefix?: string;
  /** Sink for the single degradation warning. Defaults to `console`. */
  logger?: RegistryLogger;
  /** Client constructor. Defaults to `ioredis`. */
  createClient?: RedisClientFactory;
}

const DEFAULT_KEY_PREFIX = "x402mesh";

/** Give up reconnecting after this many attempts and stay in degraded mode. */
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * `enableOfflineQueue: false` is the load-bearing option: without it, ioredis buffers commands
 * while disconnected and every caller hangs until the connect timeout. We would rather fail the
 * command immediately and fall back to memory.
 */
function createIoredisClient(url: string): RedisClientLike {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (times: number) =>
      times > MAX_RECONNECT_ATTEMPTS ? null : Math.min(times * 200, 2_000),
  });
}

/** Redacts credentials so a connection URL can safely appear in the degradation warning. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "***";
    if (parsed.username !== "") parsed.username = "***";
    return parsed.toString();
  } catch {
    return "<malformed redis url>";
  }
}

/** Extracts a loggable message without letting an arbitrary throwable leak its shape. */
function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Validates a stored record against the canonical schema.
 *
 * Reusing `NodeRecordSchema` rather than a hand-rolled check means the registry cannot drift
 * from the wire contract, and it catches the specific corruption that matters here: a
 * `totalPaidAtomic` that came back as a JSON number instead of a decimal string.
 *
 * Unparseable entries return `null` and are skipped rather than throwing, so one poisoned key
 * cannot take down every read.
 */
function parseRecord(raw: string | null): NodeRecord | null {
  if (raw === null) return null;
  try {
    const result = NodeRecordSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** `totalPaidAtomic` is already a decimal string; JSON must never widen it to a number. */
function serializeRecord(record: NodeRecord): string {
  return JSON.stringify(record);
}

function parseWindow(raw: readonly string[]): RequestOutcome[] {
  const out: RequestOutcome[] = [];
  for (const entry of raw) {
    try {
      const parsed: unknown = JSON.parse(entry);
      if (typeof parsed !== "object" || parsed === null) continue;
      const o = parsed as Partial<RequestOutcome>;
      if (typeof o.success !== "boolean") continue;
      out.push(
        normalizeOutcome({
          success: o.success,
          latencyMs: typeof o.latencyMs === "number" ? o.latencyMs : 0,
          at: typeof o.at === "number" ? o.at : 0,
        }),
      );
    } catch {
      continue;
    }
  }
  return out;
}

/** Reads a counter key that may be absent, malformed or (after a race) negative. */
function parseCount(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export class RedisNodeStore implements NodeStore {
  readonly #fallback = new MemoryNodeStore();
  readonly #prefix: string;
  readonly #logger: RegistryLogger;
  readonly #url: string;
  #client: RedisClientLike | null;
  #degraded = false;

  constructor(redisUrl: string, options: RedisNodeStoreOptions = {}) {
    this.#url = redisUrl;
    this.#prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.#logger = options.logger ?? console;
    const factory = options.createClient ?? createIoredisClient;
    try {
      this.#client = factory(redisUrl);
      // An unhandled 'error' event on a Node EventEmitter terminates the process. Swallow it
      // here; command-level rejections are what actually drive degradation.
      this.#client.on("error", () => {});
    } catch (e) {
      this.#client = null;
      this.#degrade(e);
    }
  }

  /** True when this store is serving from the in-memory fallback instead of Redis. */
  get degraded(): boolean {
    return this.#degraded;
  }

  /**
   * Opens the connection.
   *
   * Resolves either way — `false` means the store has already fallen back to memory. It never
   * rejects, because a registry that throws on startup turns a cache outage into a failed deploy.
   */
  async connect(): Promise<boolean> {
    const client = this.#client;
    if (this.#degraded || client === null) return false;
    try {
      await client.connect();
      return true;
    } catch (e) {
      this.#degrade(e);
      return false;
    }
  }

  /** Logs once, then permanently routes reads and writes to the in-memory fallback. */
  #degrade(cause: unknown): void {
    if (this.#degraded) return;
    this.#degraded = true;
    this.#logger.warn(
      `[registry] redis unavailable at ${redactUrl(this.#url)} (${describeError(cause)}); ` +
        `falling back to in-memory node store`,
    );
    const client = this.#client;
    this.#client = null;
    if (client !== null) {
      void Promise.resolve(client.quit()).catch(() => undefined);
    }
  }

  /** Runs `op` against Redis, degrading to `fallback` on the first command failure. */
  async #run<T>(op: (c: RedisClientLike) => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    const client = this.#client;
    if (this.#degraded || client === null) return fallback();
    try {
      return await op(client);
    } catch (e) {
      this.#degrade(e);
      return fallback();
    }
  }

  #recordKey(nodeId: string): string {
    return `${this.#prefix}:node:${nodeId}`;
  }

  #windowKey(nodeId: string): string {
    return `${this.#prefix}:window:${nodeId}`;
  }

  #inFlightKey(nodeId: string): string {
    return `${this.#prefix}:inflight:${nodeId}`;
  }

  #indexKey(): string {
    return `${this.#prefix}:nodes`;
  }

  /**
   * Assembles a record from its JSON blob plus the live in-flight counter.
   *
   * `inFlight` lives in a dedicated `INCR`/`DECR` key rather than inside the blob: concurrency
   * accounting under load is exactly where a read-modify-write on a shared JSON document drifts.
   */
  async #readRecord(c: RedisClientLike, nodeId: string): Promise<NodeRecord | null> {
    const [raw, inFlightRaw] = await Promise.all([
      c.get(this.#recordKey(nodeId)),
      c.get(this.#inFlightKey(nodeId)),
    ]);
    const record = parseRecord(raw);
    if (record === null) return null;
    record.health.inFlight = parseCount(inFlightRaw);
    return record;
  }

  async upsert(record: NodeRecord): Promise<void> {
    const nodeId = record.registration.nodeId;
    await this.#fallback.upsert(record);
    await this.#run(
      async (c) => {
        const [existing, rawWindow] = await Promise.all([
          this.#readRecord(c, nodeId),
          c.lrange(this.#windowKey(nodeId), 0, HEALTH_WINDOW_SIZE - 1),
        ]);
        // LPUSH stores newest-first; the health derivation expects oldest-first.
        const window = parseWindow(rawWindow).reverse();
        const merged = mergeRecord(existing, record, window);
        await c.set(this.#recordKey(nodeId), serializeRecord(merged));
        await c.sadd(this.#indexKey(), nodeId);
      },
      async () => undefined,
    );
  }

  async get(nodeId: string): Promise<NodeRecord | null> {
    return this.#run(
      (c) => this.#readRecord(c, nodeId),
      () => this.#fallback.get(nodeId),
    );
  }

  async list(): Promise<NodeRecord[]> {
    return this.#run(
      async (c) => {
        const ids = await c.smembers(this.#indexKey());
        if (ids.length === 0) return [];
        const [rawRecords, rawInFlight] = await Promise.all([
          c.mget(...ids.map((id) => this.#recordKey(id))),
          c.mget(...ids.map((id) => this.#inFlightKey(id))),
        ]);
        const out: NodeRecord[] = [];
        for (let i = 0; i < ids.length; i += 1) {
          const record = parseRecord(rawRecords[i] ?? null);
          if (record === null) continue;
          record.health.inFlight = parseCount(rawInFlight[i] ?? null);
          out.push(record);
        }
        return out;
      },
      () => this.#fallback.list(),
    );
  }

  async remove(nodeId: string): Promise<void> {
    await this.#fallback.remove(nodeId);
    await this.#run(
      async (c) => {
        await c.del(this.#recordKey(nodeId), this.#windowKey(nodeId), this.#inFlightKey(nodeId));
        await c.srem(this.#indexKey(), nodeId);
      },
      async () => undefined,
    );
  }

  async recordOutcome(nodeId: string, o: RequestOutcome): Promise<void> {
    await this.#fallback.recordOutcome(nodeId, o);
    await this.#run(
      async (c) => {
        const record = await this.#readRecord(c, nodeId);
        if (record === null) return;
        const windowKey = this.#windowKey(nodeId);
        // LPUSH + LTRIM is atomic per command, so the window itself never exceeds its bound
        // even when several gateway instances report outcomes for the same node concurrently.
        await c.lpush(windowKey, JSON.stringify(normalizeOutcome(o)));
        await c.ltrim(windowKey, 0, HEALTH_WINDOW_SIZE - 1);
        const window = parseWindow(await c.lrange(windowKey, 0, HEALTH_WINDOW_SIZE - 1)).reverse();
        record.totalRequests += 1;
        record.health = deriveHealth(record.health, window);
        await c.set(this.#recordKey(nodeId), serializeRecord(record));
      },
      async () => undefined,
    );
  }

  async beginRequest(nodeId: string): Promise<void> {
    await this.#fallback.beginRequest(nodeId);
    await this.#run(
      async (c) => {
        await c.incr(this.#inFlightKey(nodeId));
      },
      async () => undefined,
    );
  }

  async endRequest(nodeId: string): Promise<void> {
    await this.#fallback.endRequest(nodeId);
    await this.#run(
      async (c) => {
        const remaining = await c.decr(this.#inFlightKey(nodeId));
        // An unpaired endRequest (or a crashed peer) can drive the counter negative; clamp it
        // so a node does not become permanently *more* attractive than its real load.
        if (remaining < 0) await c.set(this.#inFlightKey(nodeId), "0");
      },
      async () => undefined,
    );
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    if (client !== null) {
      await Promise.resolve(client.quit()).catch(() => undefined);
    }
    await this.#fallback.close();
  }
}
