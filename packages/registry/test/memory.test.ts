import { describe, expect, it } from "vitest";
import {
  HEALTH_WINDOW_SIZE,
  MemoryNodeStore,
  UNHEALTHY_CONSECUTIVE_FAILURES,
  deriveHealth,
  mergeRecord,
  percentile,
} from "../src/index.js";
import { makeNode, outcome } from "./fixtures.js";

/**
 * The in-memory store is the authoritative health derivation for the whole mesh — the Redis
 * backend reuses these exact functions. Anything wrong here is wrong everywhere.
 */

async function record(
  store: MemoryNodeStore,
  nodeId: string,
  results: ReadonlyArray<{ success: boolean; latencyMs: number }>,
): Promise<void> {
  let at = 1_700_000_000_000;
  for (const r of results) {
    at += 1;
    await store.recordOutcome(nodeId, outcome(r.success, r.latencyMs, at));
  }
}

describe("percentile", () => {
  it("returns 0 rather than NaN for an empty window", () => {
    const p50 = percentile([], 50);
    const p95 = percentile([], 95);
    expect(Number.isNaN(p50)).toBe(false);
    expect(Number.isNaN(p95)).toBe(false);
    expect(p50).toBe(0);
    expect(p95).toBe(0);
  });

  it("returns the only sample for every percentile of a one-element window", () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  it("uses nearest-rank, not linear interpolation", () => {
    // Interpolating p50 of [1,2,3,4] would give 2.5; nearest-rank gives an observed sample.
    // rank = ceil(0.50 * 4) = 2 -> index 1 -> 2.
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    // rank = ceil(0.50 * 5) = 3 -> index 2 -> 30.
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    // rank = ceil(0.95 * 4) = 4 -> index 3 -> 4.
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
  });

  it("computes hand-checked p50/p95 on a 100-sample series", () => {
    const series = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(series, 50)).toBe(50); // rank 50 -> index 49
    expect(percentile(series, 95)).toBe(95); // rank 95 -> index 94
    expect(percentile(series, 99)).toBe(99);
    expect(percentile(series, 1)).toBe(1);
    expect(percentile(series, 100)).toBe(100);
  });

  it("clamps out-of-range and non-finite percentiles instead of indexing out of bounds", () => {
    const series = [10, 20, 30];
    expect(percentile(series, -10)).toBe(10);
    expect(percentile(series, 0)).toBe(10);
    expect(percentile(series, 500)).toBe(30);
    expect(percentile(series, Number.NaN)).toBe(10);
  });
});

describe("MemoryNodeStore round-trips", () => {
  it("upserts, gets, lists and removes", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));
    await store.upsert(makeNode({ nodeId: "node-b" }));

    const a = await store.get("node-a");
    expect(a?.registration.nodeId).toBe("node-a");
    expect(a?.registration.endpoint).toBe("https://node-a.example.com");

    const listed = await store.list();
    expect(listed.map((r) => r.registration.nodeId).sort()).toEqual(["node-a", "node-b"]);

    await store.remove("node-a");
    expect(await store.get("node-a")).toBeNull();
    expect((await store.list()).map((r) => r.registration.nodeId)).toEqual(["node-b"]);
  });

  it("returns null for an unknown id", async () => {
    const store = new MemoryNodeStore();
    expect(await store.get("never-registered")).toBeNull();
    await store.upsert(makeNode({ nodeId: "node-a" }));
    expect(await store.get("node-A")).toBeNull();
  });

  it("removing an absent node is a no-op", async () => {
    const store = new MemoryNodeStore();
    await expect(store.remove("ghost")).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("hands out deep copies, so a caller cannot mutate stored state", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a", maxConcurrency: 8 }));

    const first = await store.get("node-a");
    if (first === null) throw new Error("expected node-a to be registered");
    const firstCapability = first.registration.capabilities[0];
    if (firstCapability === undefined) throw new Error("expected a capability");
    first.health.maxConcurrency = 9999;
    first.usdcOptedIn = false;
    firstCapability.pricePer1kTokensUsdc = "99.000000";

    const second = await store.get("node-a");
    expect(second?.health.maxConcurrency).toBe(8);
    expect(second?.usdcOptedIn).toBe(true);
    expect(second?.registration.capabilities[0]?.pricePer1kTokensUsdc).toBe("0.0010");
  });

  it("drops outcomes for unknown nodes instead of throwing", async () => {
    const store = new MemoryNodeStore();
    await expect(store.recordOutcome("ghost", outcome(true, 10))).resolves.toBeUndefined();
    expect(await store.get("ghost")).toBeNull();
  });

  it("discards the health window when a node is removed", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));
    await record(store, "node-a", [
      { success: false, latencyMs: 900 },
      { success: false, latencyMs: 900 },
      { success: false, latencyMs: 900 },
    ]);
    expect((await store.get("node-a"))?.health.healthy).toBe(false);

    await store.remove("node-a");
    await store.upsert(makeNode({ nodeId: "node-a" }));

    const revived = await store.get("node-a");
    expect(revived?.health.healthy).toBe(true);
    expect(revived?.health.consecutiveFailures).toBe(0);
    expect(revived?.totalRequests).toBe(0);
  });

  it("closing clears every node", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));
    await store.close();
    expect(await store.list()).toEqual([]);
    expect(await store.get("node-a")).toBeNull();
  });
});

describe("MemoryNodeStore health window", () => {
  it("keeps a freshly registered node free of NaN percentiles", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a", latencyMsP50: 40, latencyMsP95: 90 }));
    const r = await store.get("node-a");
    expect(Number.isNaN(r?.health.latencyMsP50 ?? Number.NaN)).toBe(false);
    expect(Number.isNaN(r?.health.latencyMsP95 ?? Number.NaN)).toBe(false);
    // An empty window leaves the registrar-supplied health untouched.
    expect(r?.health.latencyMsP50).toBe(40);
    expect(r?.health.latencyMsP95).toBe(90);
  });

  it("derives p50/p95 from a single observed sample", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a", latencyMsP50: 40, latencyMsP95: 90 }));
    await record(store, "node-a", [{ success: true, latencyMs: 123 }]);

    const h = (await store.get("node-a"))?.health;
    expect(h?.latencyMsP50).toBe(123);
    expect(h?.latencyMsP95).toBe(123);
  });

  it("derives hand-computed p50/p95 from a ten-sample series", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));
    // Recorded out of order on purpose: the derivation must sort before ranking.
    const latencies = [50, 10, 100, 30, 80, 20, 90, 40, 70, 60];
    await record(
      store,
      "node-a",
      latencies.map((latencyMs) => ({ success: true, latencyMs })),
    );

    const h = (await store.get("node-a"))?.health;
    // sorted = 10..100; p50 rank = ceil(0.50*10) = 5 -> index 4 -> 50
    expect(h?.latencyMsP50).toBe(50);
    // p95 rank = ceil(0.95*10) = 10 -> index 9 -> 100
    expect(h?.latencyMsP95).toBe(100);
  });

  it("bounds the rolling window at HEALTH_WINDOW_SIZE", async () => {
    expect(HEALTH_WINDOW_SIZE).toBe(100);
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));

    // 250 samples, latency 1..250, pushed well past the bound.
    await record(
      store,
      "node-a",
      Array.from({ length: 250 }, (_, i) => ({ success: true, latencyMs: i + 1 })),
    );

    const r = await store.get("node-a");
    // Only the trailing 100 (151..250) may survive.
    // p50 rank 50 -> index 49 -> 200; p95 rank 95 -> index 94 -> 245.
    // An unbounded window would give 125 and 238 instead.
    expect(r?.health.latencyMsP50).toBe(200);
    expect(r?.health.latencyMsP95).toBe(245);
    // Every outcome still counts toward the lifetime total, only the window is bounded.
    expect(r?.totalRequests).toBe(250);
  });

  it("evicts old failures so uptime reflects only the bounded window", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));

    await record(
      store,
      "node-a",
      Array.from({ length: 120 }, () => ({ success: false, latencyMs: 900 })),
    );
    expect((await store.get("node-a"))?.health.uptimeRatio).toBe(0);

    await record(
      store,
      "node-a",
      Array.from({ length: HEALTH_WINDOW_SIZE }, () => ({ success: true, latencyMs: 100 })),
    );

    const h = (await store.get("node-a"))?.health;
    // With an unbounded window this would be 100/220 ~= 0.4545.
    expect(h?.uptimeRatio).toBe(1);
    expect(h?.consecutiveFailures).toBe(0);
    expect(h?.healthy).toBe(true);
    expect(h?.qualityScore).toBe(1);
  });

  it("normalizes a poisoned latency instead of propagating NaN", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));
    await store.recordOutcome("node-a", outcome(true, Number.NaN));
    await store.recordOutcome("node-a", outcome(true, -50));
    await store.recordOutcome("node-a", outcome(true, Number.POSITIVE_INFINITY));

    const h = (await store.get("node-a"))?.health;
    expect(h?.latencyMsP50).toBe(0);
    expect(h?.latencyMsP95).toBe(0);
    expect(Number.isNaN(h?.qualityScore ?? Number.NaN)).toBe(false);
  });
});

describe("MemoryNodeStore uptime and failure streaks", () => {
  it("tracks uptimeRatio and consecutiveFailures across a mixed sequence", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));

    await record(store, "node-a", [
      { success: true, latencyMs: 100 },
      { success: false, latencyMs: 900 },
      { success: false, latencyMs: 900 },
    ]);
    let h = (await store.get("node-a"))?.health;
    expect(h?.uptimeRatio).toBeCloseTo(1 / 3, 12);
    expect(h?.consecutiveFailures).toBe(2);
    expect(h?.healthy).toBe(true);
    // quality = uptime * (1 - cf/3) = (1/3) * (1/3)
    expect(h?.qualityScore).toBeCloseTo(1 / 9, 12);

    await record(store, "node-a", [{ success: false, latencyMs: 900 }]);
    h = (await store.get("node-a"))?.health;
    expect(h?.consecutiveFailures).toBe(UNHEALTHY_CONSECUTIVE_FAILURES);
    expect(h?.healthy).toBe(false);
    expect(h?.uptimeRatio).toBeCloseTo(0.25, 12);
    expect(h?.qualityScore).toBe(0);
  });

  it("resets consecutiveFailures on the first success", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));

    await record(store, "node-a", [
      { success: false, latencyMs: 900 },
      { success: false, latencyMs: 900 },
      { success: false, latencyMs: 900 },
      { success: false, latencyMs: 900 },
    ]);
    expect((await store.get("node-a"))?.health.consecutiveFailures).toBe(4);
    expect((await store.get("node-a"))?.health.healthy).toBe(false);

    await record(store, "node-a", [{ success: true, latencyMs: 100 }]);
    const h = (await store.get("node-a"))?.health;
    expect(h?.consecutiveFailures).toBe(0);
    expect(h?.healthy).toBe(true);
    // Only the trailing run resets; the failures still weigh on uptime.
    expect(h?.uptimeRatio).toBeCloseTo(0.2, 12);
    expect(h?.qualityScore).toBeCloseTo(0.2, 12);
  });

  it("counts only the trailing failure run, not the worst historical run", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));
    await record(store, "node-a", [
      { success: false, latencyMs: 900 },
      { success: false, latencyMs: 900 },
      { success: false, latencyMs: 900 },
      { success: false, latencyMs: 900 },
      { success: true, latencyMs: 100 },
      { success: false, latencyMs: 900 },
    ]);
    const h = (await store.get("node-a"))?.health;
    expect(h?.consecutiveFailures).toBe(1);
    expect(h?.healthy).toBe(true);
  });

  it("advances lastSeenAt only on successes", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a", lastSeenAt: 1_000 }));

    await store.recordOutcome("node-a", outcome(true, 100, 5_000));
    expect((await store.get("node-a"))?.health.lastSeenAt).toBe(5_000);

    await store.recordOutcome("node-a", outcome(false, 900, 9_000));
    expect((await store.get("node-a"))?.health.lastSeenAt).toBe(5_000);
  });
});

describe("MemoryNodeStore in-flight accounting", () => {
  it("moves inFlight symmetrically", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));

    await store.beginRequest("node-a");
    await store.beginRequest("node-a");
    await store.beginRequest("node-a");
    expect((await store.get("node-a"))?.health.inFlight).toBe(3);

    await store.endRequest("node-a");
    expect((await store.get("node-a"))?.health.inFlight).toBe(2);

    await store.endRequest("node-a");
    await store.endRequest("node-a");
    expect((await store.get("node-a"))?.health.inFlight).toBe(0);
  });

  it("never drives inFlight negative on an unpaired endRequest", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a", inFlight: 0 }));

    await store.endRequest("node-a");
    await store.endRequest("node-a");
    await store.endRequest("node-a");
    expect((await store.get("node-a"))?.health.inFlight).toBe(0);

    // A later begin must still land on 1, not on a negative-carried value.
    await store.beginRequest("node-a");
    expect((await store.get("node-a"))?.health.inFlight).toBe(1);
  });

  it("ignores begin/end for unknown nodes", async () => {
    const store = new MemoryNodeStore();
    await expect(store.beginRequest("ghost")).resolves.toBeUndefined();
    await expect(store.endRequest("ghost")).resolves.toBeUndefined();
    expect(await store.get("ghost")).toBeNull();
  });

  it("preserves inFlight across a heartbeat", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));
    await store.beginRequest("node-a");
    await store.beginRequest("node-a");

    // The heartbeat self-reports zero load; the store owns that field.
    await store.upsert(makeNode({ nodeId: "node-a", inFlight: 0 }));
    expect((await store.get("node-a"))?.health.inFlight).toBe(2);
  });
});

describe("mergeRecord", () => {
  it("stores a first registration verbatim", () => {
    const incoming = makeNode({ nodeId: "node-a", totalRequests: 7, totalPaidAtomic: "500" });
    const merged = mergeRecord(null, incoming, []);
    expect(merged).toEqual(incoming);
    expect(merged).not.toBe(incoming);
  });

  it("keeps lifetime counters monotonic across a stale heartbeat", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(
      makeNode({
        nodeId: "node-a",
        totalRequests: 100,
        totalPaidAtomic: "10000000000000000000",
        registeredAt: 1_000,
      }),
    );
    await store.upsert(
      makeNode({
        nodeId: "node-a",
        totalRequests: 3,
        totalPaidAtomic: "9999999999999999999",
        registeredAt: 2_000,
      }),
    );

    const r = await store.get("node-a");
    expect(r?.totalRequests).toBe(100);
    // Both amounts are 1e19 as doubles; only a bigint comparison distinguishes them.
    expect(r?.totalPaidAtomic).toBe("10000000000000000000");
    expect(r?.registeredAt).toBe(1_000);
  });

  it("treats a malformed lifetime payout as zero rather than adopting it", () => {
    const existing = makeNode({ nodeId: "node-a", totalPaidAtomic: "not-a-number" });
    const incoming = makeNode({ nodeId: "node-a", totalPaidAtomic: "also-bad" });
    expect(mergeRecord(existing, incoming, []).totalPaidAtomic).toBe("0");

    const good = makeNode({ nodeId: "node-a", totalPaidAtomic: "42" });
    expect(mergeRecord(existing, good, []).totalPaidAtomic).toBe("42");
    expect(mergeRecord(good, incoming, []).totalPaidAtomic).toBe("42");
  });

  it("re-derives health from the retained window, so an operator cannot self-certify", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));
    await record(store, "node-a", [
      { success: false, latencyMs: 900 },
      { success: false, latencyMs: 900 },
      { success: false, latencyMs: 900 },
    ]);

    await store.upsert(
      makeNode({
        nodeId: "node-a",
        healthy: true,
        qualityScore: 1,
        uptimeRatio: 1,
        consecutiveFailures: 0,
        latencyMsP95: 1,
      }),
    );

    const h = (await store.get("node-a"))?.health;
    expect(h?.healthy).toBe(false);
    expect(h?.consecutiveFailures).toBe(3);
    expect(h?.qualityScore).toBe(0);
    expect(h?.latencyMsP95).toBe(900);
  });

  it("lets an explicit unhealthy heartbeat win over a clean window", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));
    await record(store, "node-a", [{ success: true, latencyMs: 100 }]);
    expect((await store.get("node-a"))?.health.healthy).toBe(true);

    await store.upsert(makeNode({ nodeId: "node-a", healthy: false }));
    expect((await store.get("node-a"))?.health.healthy).toBe(false);

    // A subsequent observed success re-derives it back to healthy.
    await record(store, "node-a", [{ success: true, latencyMs: 100 }]);
    expect((await store.get("node-a"))?.health.healthy).toBe(true);
  });

  it("advances lastSeenAt to the newer of stored and heartbeat", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a", lastSeenAt: 5_000 }));
    await store.upsert(makeNode({ nodeId: "node-a", lastSeenAt: 1_000 }));
    expect((await store.get("node-a"))?.health.lastSeenAt).toBe(5_000);

    await store.upsert(makeNode({ nodeId: "node-a", lastSeenAt: 9_000 }));
    expect((await store.get("node-a"))?.health.lastSeenAt).toBe(9_000);
  });

  it("adopts a re-registration's capabilities and endpoint", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "node-a" }));
    await store.upsert(
      makeNode({
        nodeId: "node-a",
        capabilities: [
          { model: "qwen2.5:14b", contextWindow: 32768, pricePer1kTokensUsdc: "0.0040" },
        ],
      }),
    );
    const r = await store.get("node-a");
    expect(r?.registration.capabilities.map((c) => c.model)).toEqual(["qwen2.5:14b"]);
  });
});

describe("deriveHealth", () => {
  it("returns the base untouched for an empty window", () => {
    const base = makeNode({ nodeId: "node-a", latencyMsP50: 11, latencyMsP95: 22 }).health;
    const derived = deriveHealth(base, []);
    expect(derived).toEqual(base);
    expect(derived).not.toBe(base);
  });

  it("carries nodeId, inFlight and maxConcurrency through from the base", () => {
    const base = makeNode({ nodeId: "node-z", inFlight: 4, maxConcurrency: 12 }).health;
    const derived = deriveHealth(base, [outcome(true, 10, 1), outcome(true, 20, 2)]);
    expect(derived.nodeId).toBe("node-z");
    expect(derived.inFlight).toBe(4);
    expect(derived.maxConcurrency).toBe(12);
  });

  it("clamps derived ratios into the unit interval", () => {
    const base = makeNode({ nodeId: "node-a" }).health;
    const derived = deriveHealth(base, [outcome(true, 1, 1), outcome(false, 2, 2)]);
    expect(derived.uptimeRatio).toBeGreaterThanOrEqual(0);
    expect(derived.uptimeRatio).toBeLessThanOrEqual(1);
    expect(derived.qualityScore).toBeGreaterThanOrEqual(0);
    expect(derived.qualityScore).toBeLessThanOrEqual(1);
  });
});
