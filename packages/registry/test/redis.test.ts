import { describe, expect, it } from "vitest";
import {
  HEALTH_WINDOW_SIZE,
  MemoryNodeStore,
  RedisNodeStore,
  createNodeStore,
  type RedisClientLike,
} from "../src/index.js";
import { makeNode, outcome } from "./fixtures.js";
import { FakeRedis, recordingLogger } from "./redisStub.js";

/**
 * The Redis backend has two jobs it must never get wrong: degrade to memory instead of taking
 * the marketplace down, and move `totalPaidAtomic` across the JSON boundary without losing a
 * single atomic unit.
 *
 * No test here opens a socket — every client is a stub.
 */

const PREFIX = "x402mesh";

function connected(): { store: RedisNodeStore; redis: FakeRedis; warnings: string[] } {
  const redis = new FakeRedis();
  const logger = recordingLogger();
  const store = new RedisNodeStore("redis://cache.internal:6379", {
    logger,
    createClient: () => redis,
  });
  return { store, redis, warnings: logger.warnings };
}

describe("RedisNodeStore degradation", () => {
  it("falls back to memory instead of throwing when the server is unreachable", async () => {
    const logger = recordingLogger();
    const redis = new FakeRedis({ failOnConnect: true });
    const store = new RedisNodeStore("redis://127.0.0.1:6379", {
      logger,
      createClient: () => redis,
    });

    expect(store.degraded).toBe(false);
    await expect(store.connect()).resolves.toBe(false);
    expect(store.degraded).toBe(true);

    // Still fully functional, served from the in-memory mirror.
    await store.upsert(makeNode({ nodeId: "node-a" }));
    expect((await store.get("node-a"))?.registration.nodeId).toBe("node-a");
    expect((await store.list()).map((r) => r.registration.nodeId)).toEqual(["node-a"]);
    await store.close();
  });

  it("degrades without throwing when the client constructor itself fails", async () => {
    const logger = recordingLogger();
    const store = new RedisNodeStore("redis://bad-host:6379", {
      logger,
      createClient: () => {
        throw new Error("invalid redis url");
      },
    });

    expect(store.degraded).toBe(true);
    expect(logger.warnings).toHaveLength(1);
    await expect(store.connect()).resolves.toBe(false);
    await store.upsert(makeNode({ nodeId: "node-a" }));
    expect((await store.get("node-a"))?.registration.nodeId).toBe("node-a");
    await store.close();
  });

  it("logs the degradation exactly once, not once per call", async () => {
    const logger = recordingLogger();
    const redis = new FakeRedis({ broken: true });
    const store = new RedisNodeStore("redis://cache.internal:6379", {
      logger,
      createClient: () => redis,
    });

    await store.connect();
    for (let i = 0; i < 25; i += 1) {
      await store.upsert(makeNode({ nodeId: `node-${i}` }));
      await store.get(`node-${i}`);
      await store.list();
      await store.recordOutcome(`node-${i}`, outcome(true, 100));
      await store.beginRequest(`node-${i}`);
      await store.endRequest(`node-${i}`);
      await store.remove(`node-${i}`);
    }

    expect(logger.warnings).toHaveLength(1);
    await store.close();
  });

  it("degrades on the first command failure and keeps serving from the mirror", async () => {
    const { store, redis, warnings } = connected();
    await store.connect();

    await store.upsert(makeNode({ nodeId: "node-a" }));
    await store.beginRequest("node-a");
    expect(store.degraded).toBe(false);

    redis.broken = true;
    // Redis is gone, but the mirror already knows about node-a including its in-flight count.
    const r = await store.get("node-a");
    expect(store.degraded).toBe(true);
    expect(r?.registration.nodeId).toBe("node-a");
    expect(r?.health.inFlight).toBe(1);
    expect(warnings).toHaveLength(1);
    await store.close();
  });

  it("redacts credentials from the degradation warning", async () => {
    const logger = recordingLogger();
    const store = new RedisNodeStore("redis://admin:hunter2@cache.internal:6379", {
      logger,
      createClient: () => new FakeRedis({ failOnConnect: true }),
    });
    await store.connect();

    const warning = logger.warnings[0] ?? "";
    expect(warning).not.toContain("hunter2");
    expect(warning).not.toContain("admin");
    expect(warning).toContain("cache.internal");
    await store.close();
  });

  it("swallows the client's error events so an emitter cannot kill the process", () => {
    const redis = new FakeRedis();
    const store = new RedisNodeStore("redis://cache.internal:6379", {
      logger: recordingLogger(),
      createClient: () => redis,
    });
    expect(redis.errorListeners).toBe(1);
    expect(store.degraded).toBe(false);
  });
});

describe("RedisNodeStore totalPaidAtomic precision", () => {
  const HUGE = "9007199254740993000001"; // far beyond Number.MAX_SAFE_INTEGER

  it("round-trips a payout larger than MAX_SAFE_INTEGER as an exact string", async () => {
    const { store, redis } = connected();
    await store.connect();

    await store.upsert(makeNode({ nodeId: "node-a", totalPaidAtomic: HUGE }));

    // The stored blob must carry a JSON *string*, never a number.
    const raw = redis.strings.get(`${PREFIX}:node:node-a`) ?? "";
    expect(raw).toContain(`"totalPaidAtomic":"${HUGE}"`);
    expect(raw).not.toContain(`"totalPaidAtomic":${HUGE}`);

    const read = await store.get("node-a");
    expect(read?.totalPaidAtomic).toBe(HUGE);
    expect(BigInt(read?.totalPaidAtomic ?? "0")).toBe(BigInt(HUGE));
    expect(BigInt(read?.totalPaidAtomic ?? "0")).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    // Proof the string form is load-bearing: a float round-trip would have mangled it.
    expect(String(Number(HUGE))).not.toBe(HUGE);
    await store.close();
  });

  it("keeps the payout exact through list() as well as get()", async () => {
    const { store } = connected();
    await store.connect();
    await store.upsert(makeNode({ nodeId: "node-a", totalPaidAtomic: HUGE }));

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.totalPaidAtomic).toBe(HUGE);
    await store.close();
  });

  it("survives the read-modify-write of recordOutcome without truncating the payout", async () => {
    const { store } = connected();
    await store.connect();
    await store.upsert(makeNode({ nodeId: "node-a", totalPaidAtomic: HUGE }));

    for (let i = 0; i < 5; i += 1) {
      await store.recordOutcome("node-a", outcome(true, 100 + i, 1_700_000_000_000 + i));
    }

    const read = await store.get("node-a");
    expect(read?.totalPaidAtomic).toBe(HUGE);
    expect(read?.totalRequests).toBe(5);
    await store.close();
  });

  it("never rolls the payout backwards, even between two indistinguishable doubles", async () => {
    const { store } = connected();
    await store.connect();

    await store.upsert(makeNode({ nodeId: "node-a", totalPaidAtomic: "10000000000000000001" }));
    await store.upsert(makeNode({ nodeId: "node-a", totalPaidAtomic: "10000000000000000000" }));

    const read = await store.get("node-a");
    // Both parse to 1e19 as doubles; only bigint comparison keeps the larger.
    expect(Number("10000000000000000001")).toBe(Number("10000000000000000000"));
    expect(read?.totalPaidAtomic).toBe("10000000000000000001");
    await store.close();
  });

  it("rejects a blob whose payout came back as a JSON number", async () => {
    const { store, redis } = connected();
    await store.connect();
    await store.upsert(makeNode({ nodeId: "node-a" }));

    // Simulate corruption written by some other, sloppier writer.
    const raw = redis.strings.get(`${PREFIX}:node:node-a`) ?? "";
    redis.strings.set(
      `${PREFIX}:node:node-a`,
      raw.replace('"totalPaidAtomic":"0"', '"totalPaidAtomic":0'),
    );

    expect(await store.get("node-a")).toBeNull();
    expect(await store.list()).toEqual([]);
    // One poisoned key must not take down reads of a healthy sibling.
    await store.upsert(makeNode({ nodeId: "node-b" }));
    expect((await store.list()).map((r) => r.registration.nodeId)).toEqual(["node-b"]);
    await store.close();
  });
});

describe("RedisNodeStore against a stub server", () => {
  it("round-trips upsert / get / list / remove", async () => {
    const { store, redis } = connected();
    await store.connect();

    await store.upsert(makeNode({ nodeId: "node-a" }));
    await store.upsert(makeNode({ nodeId: "node-b" }));
    expect((await store.list()).map((r) => r.registration.nodeId).sort()).toEqual([
      "node-a",
      "node-b",
    ]);

    await store.remove("node-a");
    expect(await store.get("node-a")).toBeNull();
    expect((await store.list()).map((r) => r.registration.nodeId)).toEqual(["node-b"]);
    expect(redis.strings.has(`${PREFIX}:node:node-a`)).toBe(false);
    expect(redis.lists.has(`${PREFIX}:window:node-a`)).toBe(false);
    await store.close();
  });

  it("returns null for an unknown id", async () => {
    const { store } = connected();
    await store.connect();
    expect(await store.get("ghost")).toBeNull();
    await store.close();
  });

  it("keeps inFlight in a dedicated counter key and clamps it at zero", async () => {
    const { store, redis } = connected();
    await store.connect();
    await store.upsert(makeNode({ nodeId: "node-a" }));

    await store.beginRequest("node-a");
    await store.beginRequest("node-a");
    expect((await store.get("node-a"))?.health.inFlight).toBe(2);
    expect(redis.strings.get(`${PREFIX}:inflight:node-a`)).toBe("2");

    await store.endRequest("node-a");
    await store.endRequest("node-a");
    await store.endRequest("node-a");
    expect(redis.strings.get(`${PREFIX}:inflight:node-a`)).toBe("0");
    expect((await store.get("node-a"))?.health.inFlight).toBe(0);
    await store.close();
  });

  it("derives the same health from the Redis window as the memory store does", async () => {
    const { store } = connected();
    await store.connect();
    const memory = new MemoryNodeStore();

    await store.upsert(makeNode({ nodeId: "node-a" }));
    await memory.upsert(makeNode({ nodeId: "node-a" }));

    const latencies = [50, 10, 100, 30, 80, 20, 90, 40, 70, 60];
    for (const [i, latencyMs] of latencies.entries()) {
      const o = outcome(true, latencyMs, 1_700_000_000_000 + i);
      await store.recordOutcome("node-a", o);
      await memory.recordOutcome("node-a", o);
    }

    const fromRedis = await store.get("node-a");
    const fromMemory = await memory.get("node-a");
    expect(fromRedis?.health).toEqual(fromMemory?.health);
    expect(fromRedis?.health.latencyMsP50).toBe(50);
    expect(fromRedis?.health.latencyMsP95).toBe(100);
    await store.close();
    await memory.close();
  });

  it("bounds the Redis-side window with LTRIM", async () => {
    const { store, redis } = connected();
    await store.connect();
    await store.upsert(makeNode({ nodeId: "node-a" }));

    for (let i = 1; i <= 250; i += 1) {
      await store.recordOutcome("node-a", outcome(true, i, 1_700_000_000_000 + i));
    }

    expect(redis.lists.get(`${PREFIX}:window:node-a`)).toHaveLength(HEALTH_WINDOW_SIZE);
    const h = (await store.get("node-a"))?.health;
    // Trailing 100 samples are 151..250: p50 -> index 49 -> 200, p95 -> index 94 -> 245.
    expect(h?.latencyMsP50).toBe(200);
    expect(h?.latencyMsP95).toBe(245);
    await store.close();
  });

  it("orders the window oldest-first when deriving the failure streak", async () => {
    const { store } = connected();
    await store.connect();
    await store.upsert(makeNode({ nodeId: "node-a" }));

    // Failures first, then a success: the trailing run is 0, so the node is healthy.
    await store.recordOutcome("node-a", outcome(false, 900, 1_700_000_000_001));
    await store.recordOutcome("node-a", outcome(false, 900, 1_700_000_000_002));
    await store.recordOutcome("node-a", outcome(true, 100, 1_700_000_000_003));

    const h = (await store.get("node-a"))?.health;
    expect(h?.consecutiveFailures).toBe(0);
    expect(h?.healthy).toBe(true);
    expect(h?.uptimeRatio).toBeCloseTo(1 / 3, 12);
    await store.close();
  });

  it("drops outcomes for nodes Redis has never heard of", async () => {
    const { store, redis } = connected();
    await store.connect();
    await expect(store.recordOutcome("ghost", outcome(true, 100))).resolves.toBeUndefined();
    expect(redis.lists.has(`${PREFIX}:window:ghost`)).toBe(false);
    await store.close();
  });

  it("honours a custom key prefix", async () => {
    const redis = new FakeRedis();
    const store = new RedisNodeStore("redis://cache.internal:6379", {
      logger: recordingLogger(),
      createClient: () => redis,
      keyPrefix: "mesh-test",
    });
    await store.connect();
    await store.upsert(makeNode({ nodeId: "node-a" }));

    expect(redis.strings.has("mesh-test:node:node-a")).toBe(true);
    expect([...(redis.sets.get("mesh-test:nodes") ?? [])]).toEqual(["node-a"]);
    await store.close();
  });

  it("closes the client exactly once", async () => {
    const { store, redis } = connected();
    await store.connect();
    await store.close();
    await store.close();
    expect(redis.quitCount).toBe(1);
  });
});

describe("createNodeStore", () => {
  it("selects memory when no url is supplied", async () => {
    expect(await createNodeStore()).toBeInstanceOf(MemoryNodeStore);
    expect(await createNodeStore("")).toBeInstanceOf(MemoryNodeStore);
    expect(await createNodeStore("   ")).toBeInstanceOf(MemoryNodeStore);
  });

  it("selects Redis when the connection succeeds", async () => {
    const redis = new FakeRedis();
    const store = await createNodeStore("redis://cache.internal:6379", {
      logger: recordingLogger(),
      createClient: () => redis,
    });
    expect(store).toBeInstanceOf(RedisNodeStore);
    expect(redis.connectCount).toBe(1);
    await store.close();
  });

  it("returns a usable memory store when Redis is unreachable", async () => {
    const logger = recordingLogger();
    const redis = new FakeRedis({ failOnConnect: true });
    const store = await createNodeStore("redis://127.0.0.1:6379", {
      logger,
      createClient: () => redis,
    });

    expect(store).toBeInstanceOf(MemoryNodeStore);
    expect(logger.warnings).toHaveLength(1);
    await store.upsert(makeNode({ nodeId: "node-a" }));
    expect((await store.get("node-a"))?.registration.nodeId).toBe("node-a");
    await store.close();
  });

  it("does not leave the failed client dangling", async () => {
    const redis = new FakeRedis({ failOnConnect: true });
    await createNodeStore("redis://127.0.0.1:6379", {
      logger: recordingLogger(),
      createClient: () => redis,
    });
    expect(redis.quitCount).toBeGreaterThanOrEqual(1);
  });

  it("accepts any client that satisfies the narrow command surface", async () => {
    const redis: RedisClientLike = new FakeRedis();
    const store = new RedisNodeStore("redis://cache.internal:6379", {
      logger: recordingLogger(),
      createClient: () => redis,
    });
    await expect(store.connect()).resolves.toBe(true);
    await store.close();
  });
});
