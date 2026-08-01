import type { RedisClientLike, RegistryLogger } from "../src/index.js";

/**
 * In-process stand-in for `ioredis`.
 *
 * The registry's Redis path is where money-shaped state (`totalPaidAtomic`) crosses a
 * serialization boundary, so it has to be exercised — but a unit suite must never require a live
 * server. This implements exactly the command surface `RedisClientLike` declares, with the same
 * semantics the store relies on: `LPUSH` pushes to the head, `LTRIM`/`LRANGE` use inclusive
 * indices, `MGET` yields `null` for missing keys, and `DECR` may go negative.
 */

export interface FakeRedisOptions {
  /** When true, `connect()` rejects — the unreachable-server case. */
  failOnConnect?: boolean;
  /** When true, every command rejects from construction onward. */
  broken?: boolean;
}

export class FakeRedis implements RedisClientLike {
  readonly strings = new Map<string, string>();
  readonly lists = new Map<string, string[]>();
  readonly sets = new Map<string, Set<string>>();
  /** Every command name this client was asked to run, in order. */
  readonly calls: string[] = [];
  /** Flip to true to simulate the connection dropping mid-flight. */
  broken: boolean;
  connectCount = 0;
  quitCount = 0;
  errorListeners = 0;

  readonly #failOnConnect: boolean;

  constructor(options: FakeRedisOptions = {}) {
    this.#failOnConnect = options.failOnConnect ?? false;
    this.broken = options.broken ?? false;
  }

  #guard(command: string): void {
    this.calls.push(command);
    if (this.broken) throw new Error(`fake redis: connection lost during ${command.toUpperCase()}`);
  }

  #counter(key: string): number {
    const raw = this.strings.get(key);
    if (raw === undefined) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  }

  /** Translates an inclusive, possibly-negative redis range into a `slice` end index. */
  #end(length: number, stop: number): number {
    return stop < 0 ? length + stop + 1 : stop + 1;
  }

  async connect(): Promise<void> {
    this.connectCount += 1;
    this.calls.push("connect");
    if (this.#failOnConnect) throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
    if (this.broken) throw new Error("fake redis: connection lost during CONNECT");
  }

  async get(key: string): Promise<string | null> {
    this.#guard("get");
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.#guard("set");
    this.strings.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<unknown> {
    this.#guard("del");
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed += 1;
      if (this.lists.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
    }
    return removed;
  }

  async sadd(key: string, member: string): Promise<unknown> {
    this.#guard("sadd");
    const set = this.sets.get(key) ?? new Set<string>();
    const added = set.has(member) ? 0 : 1;
    set.add(member);
    this.sets.set(key, set);
    return added;
  }

  async srem(key: string, member: string): Promise<unknown> {
    this.#guard("srem");
    const set = this.sets.get(key);
    return set !== undefined && set.delete(member) ? 1 : 0;
  }

  async smembers(key: string): Promise<string[]> {
    this.#guard("smembers");
    return [...(this.sets.get(key) ?? [])];
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    this.#guard("mget");
    return keys.map((k) => this.strings.get(k) ?? null);
  }

  async lpush(key: string, value: string): Promise<unknown> {
    this.#guard("lpush");
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<unknown> {
    this.#guard("ltrim");
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(Math.max(0, start), Math.max(0, this.#end(list.length, stop))));
    return "OK";
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.#guard("lrange");
    const list = this.lists.get(key) ?? [];
    return list.slice(Math.max(0, start), Math.max(0, this.#end(list.length, stop)));
  }

  async incr(key: string): Promise<number> {
    this.#guard("incr");
    const next = this.#counter(key) + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async decr(key: string): Promise<number> {
    this.#guard("decr");
    const next = this.#counter(key) - 1;
    this.strings.set(key, String(next));
    return next;
  }

  async quit(): Promise<unknown> {
    this.quitCount += 1;
    return "OK";
  }

  /** Signature is intentionally parameterless: the store only ever attaches an `error` sink. */
  on(): unknown {
    this.errorListeners += 1;
    return this;
  }
}

/** Captures the degradation warning so a test can assert it fires exactly once. */
export function recordingLogger(): RegistryLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    warn: (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(" "));
    },
  };
}
