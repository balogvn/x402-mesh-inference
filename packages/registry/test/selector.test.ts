import { describe, expect, it } from "vitest";
import {
  ALGORAND_MAINNET,
  ALGORAND_TESTNET,
  NoCapacityError,
  type NodeRecord,
} from "@x402-mesh/shared";
import { MemoryNodeStore, NodeSelector, type NodeSelectorOptions } from "../src/index.js";
import { makeNode, pinnedRng, type NodeFixtureOverrides } from "./fixtures.js";

/**
 * Selection is two stages: a hard eligibility filter, then a weighted draw. Both are asserted
 * separately — the filter with single-cause fixtures, the draw with a pinned rng so the
 * distribution is a pure function of the scores.
 */

const MODEL = "llama3.1:8b";
const OTHER_MODEL = "qwen2.5:14b";

/** A node that serves MODEL at `priceUsdc`, plus whatever else the case needs. */
function node(nodeId: string, priceUsdc: string, overrides: NodeFixtureOverrides = {}): NodeRecord {
  return makeNode({
    nodeId,
    capabilities: [{ model: MODEL, contextWindow: 8192, pricePer1kTokensUsdc: priceUsdc }],
    ...overrides,
  });
}

async function storeWith(...nodes: readonly NodeRecord[]): Promise<MemoryNodeStore> {
  const store = new MemoryNodeStore();
  for (const n of nodes) await store.upsert(n);
  return store;
}

async function selectorWith(
  nodes: readonly NodeRecord[],
  options: NodeSelectorOptions = {},
): Promise<NodeSelector> {
  return new NodeSelector(await storeWith(...nodes), options);
}

/** Uniform sweep of `n` unit draws — the distribution becomes exactly reproducible. */
function sweep(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i + 0.5) / n);
}

async function tally(selector: NodeSelector, draws: number): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let i = 0; i < draws; i += 1) {
    const chosen = await selector.select(MODEL);
    const id = chosen.node.registration.nodeId;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

async function expectNoCapacity(selector: NodeSelector, model = MODEL): Promise<NoCapacityError> {
  const outcome = await selector.select(model).then(
    () => null,
    (e: unknown) => e,
  );
  if (!(outcome instanceof NoCapacityError)) {
    throw new Error(`expected NoCapacityError, got ${String(outcome)}`);
  }
  return outcome;
}

describe("NodeSelector eligibility filter", () => {
  it("selects the single eligible node", async () => {
    const selector = await selectorWith([node("node-a", "0.0010")]);
    const chosen = await selector.select(MODEL);
    expect(chosen.node.registration.nodeId).toBe("node-a");
    expect(Number.isFinite(chosen.score)).toBe(true);
  });

  it("skips unhealthy nodes", async () => {
    const selector = await selectorWith([
      node("node-a", "0.0010", { healthy: false }),
      node("node-b", "0.0090"),
    ]);
    for (let i = 0; i < 20; i += 1) {
      expect((await selector.select(MODEL)).node.registration.nodeId).toBe("node-b");
    }
  });

  it("skips nodes that do not serve the requested model", async () => {
    const wrongModel = makeNode({
      nodeId: "node-a",
      capabilities: [{ model: OTHER_MODEL, contextWindow: 8192, pricePer1kTokensUsdc: "0.0001" }],
    });
    const selector = await selectorWith([wrongModel, node("node-b", "0.0090")]);
    for (let i = 0; i < 20; i += 1) {
      expect((await selector.select(MODEL)).node.registration.nodeId).toBe("node-b");
    }
  });

  it("skips nodes that have not opted in to USDC", async () => {
    const selector = await selectorWith([
      node("node-a", "0.0001", { usdcOptedIn: false }),
      node("node-b", "0.0090"),
    ]);
    for (let i = 0; i < 20; i += 1) {
      expect((await selector.select(MODEL)).node.registration.nodeId).toBe("node-b");
    }
  });

  it("skips nodes that are at their concurrency cap", async () => {
    const selector = await selectorWith([
      node("node-a", "0.0001", { inFlight: 4, maxConcurrency: 4 }),
      node("node-b", "0.0090"),
    ]);
    for (let i = 0; i < 20; i += 1) {
      expect((await selector.select(MODEL)).node.registration.nodeId).toBe("node-b");
    }
  });

  it("still routes to a node one request below its cap", async () => {
    const selector = await selectorWith([
      node("node-a", "0.0010", { inFlight: 3, maxConcurrency: 4 }),
    ]);
    expect((await selector.select(MODEL)).node.registration.nodeId).toBe("node-a");
  });

  it("skips nodes whose quoted price cannot be parsed", async () => {
    const selector = await selectorWith([
      node("node-a", "definitely-not-a-price"),
      node("node-b", "0.0090"),
    ]);
    for (let i = 0; i < 20; i += 1) {
      expect((await selector.select(MODEL)).node.registration.nodeId).toBe("node-b");
    }
  });

  it("honours excludeNodeIds, which is what the gateway retry path depends on", async () => {
    const selector = await selectorWith(
      [node("node-a", "0.0001"), node("node-b", "0.0090")],
      { rng: pinnedRng([0]) }, // always the first candidate in nodeId order
    );
    expect((await selector.select(MODEL)).node.registration.nodeId).toBe("node-a");

    const retry = await selector.select(MODEL, { excludeNodeIds: ["node-a"] });
    expect(retry.node.registration.nodeId).toBe("node-b");
  });

  it("excludes every listed id, not just the first", async () => {
    const selector = await selectorWith([
      node("node-a", "0.0010"),
      node("node-b", "0.0020"),
      node("node-c", "0.0030"),
    ]);
    for (let i = 0; i < 20; i += 1) {
      const chosen = await selector.select(MODEL, { excludeNodeIds: ["node-a", "node-b"] });
      expect(chosen.node.registration.nodeId).toBe("node-c");
    }
  });

  it("ignores exclusions for ids that are not registered", async () => {
    const selector = await selectorWith([node("node-a", "0.0010")]);
    const chosen = await selector.select(MODEL, { excludeNodeIds: ["ghost", "node-z"] });
    expect(chosen.node.registration.nodeId).toBe("node-a");
  });

  it("reflects live capacity changes made through the store", async () => {
    const store = await storeWith(
      node("node-a", "0.0001", { maxConcurrency: 1 }),
      node("node-b", "0.0090"),
    );
    const selector = new NodeSelector(store, { rng: pinnedRng([0]) });
    expect((await selector.select(MODEL)).node.registration.nodeId).toBe("node-a");

    await store.beginRequest("node-a");
    expect((await selector.select(MODEL)).node.registration.nodeId).toBe("node-b");

    await store.endRequest("node-a");
    expect((await selector.select(MODEL)).node.registration.nodeId).toBe("node-a");
  });
});

describe("NodeSelector no-capacity reporting", () => {
  it("throws NoCapacityError for an empty pool", async () => {
    const selector = await selectorWith([]);
    const err = await expectNoCapacity(selector);
    expect(err.code).toBe("no_capacity");
    expect(err.httpStatus).toBe(503);
    expect(err.details?.registeredNodes).toBe(0);
    expect(err.details?.model).toBe(MODEL);
  });

  it("throws NoCapacityError when every node is rejected, and says why", async () => {
    const wrongModel = makeNode({
      nodeId: "node-model",
      capabilities: [{ model: OTHER_MODEL, contextWindow: 8192, pricePer1kTokensUsdc: "0.0001" }],
    });
    const selector = await selectorWith([
      node("node-sick", "0.0010", { healthy: false }),
      wrongModel,
      node("node-noopt", "0.0010", { usdcOptedIn: false }),
      node("node-full", "0.0010", { inFlight: 8, maxConcurrency: 8 }),
      node("node-badprice", "nope"),
    ]);

    const err = await expectNoCapacity(selector);
    expect(err.details?.registeredNodes).toBe(5);
    expect(err.details?.rejected).toEqual({
      wrongNetwork: 0,
      stale: 0,
      unhealthy: 1,
      wrongModel: 1,
      notOptedIn: 1,
      saturated: 1,
      excluded: 0,
      unpriceable: 1,
    });
  });

  it("throws NoCapacityError when every candidate is excluded", async () => {
    const selector = await selectorWith([node("node-a", "0.0010"), node("node-b", "0.0020")]);
    const outcome = await selector.select(MODEL, { excludeNodeIds: ["node-a", "node-b"] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(outcome).toBeInstanceOf(NoCapacityError);
    if (!(outcome instanceof NoCapacityError)) throw new Error("unreachable");
    expect(outcome.details?.rejected).toEqual({
      wrongNetwork: 0,
      stale: 0,
      unhealthy: 0,
      wrongModel: 0,
      notOptedIn: 0,
      saturated: 0,
      excluded: 2,
      unpriceable: 0,
    });
  });

  it("throws for a model nobody serves", async () => {
    const selector = await selectorWith([node("node-a", "0.0010")]);
    const err = await expectNoCapacity(selector, "gpt-nonexistent");
    expect(err.message).toContain("gpt-nonexistent");
  });
});

describe("NodeSelector weighted draw", () => {
  /**
   * node-a is best on all three dimensions and node-b is worst, so the exact draw weights are
   * (score + floor): 1.05 vs 0.20. Over a uniform sweep the split must land near 84 / 16.
   */
  const twoNodes = [
    node("node-a", "0.0010", { latencyMsP95: 100, qualityScore: 1 }),
    node("node-b", "0.0050", { latencyMsP95: 500, qualityScore: 0.5 }),
  ];

  it("spreads load across candidates instead of pinning the argmax", async () => {
    const selector = await selectorWith(twoNodes, { rng: pinnedRng(sweep(1000)) });
    const counts = await tally(selector, 1000);

    expect(counts.size).toBe(2);
    const a = counts.get("node-a") ?? 0;
    const b = counts.get("node-b") ?? 0;
    expect(a + b).toBe(1000);
    expect(a).toBeGreaterThan(b);
    // Weight share is 1.05 / 1.25 = 0.84; allow a little slack for float accumulation.
    expect(a).toBeGreaterThan(820);
    expect(a).toBeLessThan(860);
    expect(b).toBeGreaterThan(140);
    expect(b).toBeLessThan(180);
  });

  it("orders the split by score across three candidates", async () => {
    const selector = await selectorWith(
      [
        node("node-a", "0.0010", { latencyMsP95: 100, qualityScore: 1 }),
        node("node-b", "0.0030", { latencyMsP95: 300, qualityScore: 0.8 }),
        node("node-c", "0.0050", { latencyMsP95: 500, qualityScore: 0.5 }),
      ],
      { rng: pinnedRng(sweep(1000)) },
    );
    const counts = await tally(selector, 1000);

    const a = counts.get("node-a") ?? 0;
    const b = counts.get("node-b") ?? 0;
    const c = counts.get("node-c") ?? 0;
    expect(a + b + c).toBe(1000);
    // Every node must see traffic — a starved node never proves it recovered.
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(c).toBeGreaterThan(0);
    // Scores are 1.00 / 0.59 / 0.15, so weights are 1.05 / 0.64 / 0.20 of a 1.89 total.
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(a / 1000).toBeCloseTo(1.05 / 1.89, 1);
    expect(b / 1000).toBeCloseTo(0.64 / 1.89, 1);
    expect(c / 1000).toBeCloseTo(0.2 / 1.89, 1);
  });

  it("keeps a zero-scoring node reachable through the weight floor", async () => {
    const selector = await selectorWith(
      [
        node("node-a", "0.0010", { latencyMsP95: 100, qualityScore: 1 }),
        node("node-b", "0.0050", { latencyMsP95: 500, qualityScore: 0 }),
      ],
      { rng: pinnedRng(sweep(1000)) },
    );
    const counts = await tally(selector, 1000);

    // Weights are 1.05 and 0.05: the loser is rare, but never starved.
    const b = counts.get("node-b") ?? 0;
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(100);
  });

  it("widens the split when the weight floor is raised", async () => {
    const selector = await selectorWith(
      [
        node("node-a", "0.0010", { latencyMsP95: 100, qualityScore: 1 }),
        node("node-b", "0.0050", { latencyMsP95: 500, qualityScore: 0 }),
      ],
      { rng: pinnedRng(sweep(1000)), weightFloor: 1 },
    );
    const counts = await tally(selector, 1000);

    // Weights become 2.0 and 1.0, so the loser should take roughly a third of the traffic.
    const b = counts.get("node-b") ?? 0;
    expect(b / 1000).toBeCloseTo(1 / 3, 1);
  });

  it("falls back to the default floor for a nonsensical weightFloor", async () => {
    const nodes = [
      node("node-a", "0.0010", { latencyMsP95: 100, qualityScore: 1 }),
      node("node-b", "0.0050", { latencyMsP95: 500, qualityScore: 0 }),
    ];
    const bad = await selectorWith(nodes, { rng: pinnedRng(sweep(1000)), weightFloor: 0 });
    const good = await selectorWith(nodes, { rng: pinnedRng(sweep(1000)) });
    expect(await tally(bad, 1000)).toEqual(await tally(good, 1000));
  });

  it("clamps a misbehaving rng instead of failing the request", async () => {
    const nodes = [node("node-a", "0.0010"), node("node-b", "0.0090")];
    const first = async (rng: () => number): Promise<string> => {
      const selector = await selectorWith(nodes, { rng });
      return (await selector.select(MODEL)).node.registration.nodeId;
    };

    expect(await first(pinnedRng([0]))).toBe("node-a");
    expect(await first(pinnedRng([Number.NaN]))).toBe("node-a");
    expect(await first(pinnedRng([-5]))).toBe("node-a");
    expect(await first(pinnedRng([1]))).toBe("node-b");
    expect(await first(pinnedRng([5]))).toBe("node-b");
  });

  it("is reproducible for a given rng sequence regardless of registration order", async () => {
    const nodes = [
      node("node-a", "0.0010", { latencyMsP95: 100 }),
      node("node-b", "0.0030", { latencyMsP95: 300 }),
      node("node-c", "0.0050", { latencyMsP95: 500 }),
    ];
    const forward = await selectorWith(nodes, { rng: pinnedRng(sweep(50)) });
    const reversed = await selectorWith([...nodes].reverse(), { rng: pinnedRng(sweep(50)) });

    const a: string[] = [];
    const b: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      a.push((await forward.select(MODEL)).node.registration.nodeId);
      b.push((await reversed.select(MODEL)).node.registration.nodeId);
    }
    expect(a).toEqual(b);
  });
});

describe("NodeSelector output", () => {
  it("reports the winning score and an operator-readable reason", async () => {
    const selector = await selectorWith([
      node("node-a", "0.0010", { latencyMsP50: 80, latencyMsP95: 100, qualityScore: 1 }),
      node("node-b", "0.0050", { latencyMsP95: 500, qualityScore: 0.5 }),
    ]);
    const chosen = await selector.select(MODEL);

    expect(chosen.score).toBeGreaterThanOrEqual(0);
    expect(chosen.score).toBeLessThanOrEqual(1);
    expect(chosen.reason).toContain(chosen.node.registration.nodeId);
    expect(chosen.reason).toContain(MODEL);
    expect(chosen.reason).toContain("2 candidates");
    expect(chosen.reason.length).toBeLessThanOrEqual(512);
  });

  it("singularizes the candidate count", async () => {
    const selector = await selectorWith([node("node-a", "0.0010")]);
    const chosen = await selector.select(MODEL);
    expect(chosen.reason).toContain("from 1 candidate:");
    expect(chosen.reason).not.toContain("candidates");
  });

  it("keeps the reason within the NodeSelection schema bound", async () => {
    // Longest identifiers the wire schema permits: a 128-char nodeId and a 200-char model.
    const maxNodeId = `node-${"a".repeat(123)}`;
    const maxModel = "m".repeat(200);
    const maxed = makeNode({
      nodeId: maxNodeId,
      capabilities: [{ model: maxModel, contextWindow: 8192, pricePer1kTokensUsdc: "0.0010" }],
      latencyMsP50: 999_999,
      latencyMsP95: 999_999,
    });
    const withinSchema = new NodeSelector(await storeWith(maxed));
    expect((await withinSchema.select(maxModel)).reason.length).toBeLessThanOrEqual(512);

    // And the hard slice still holds for an identifier no schema would have let through.
    const oversized = await selectorWith([node(`node-${"a".repeat(500)}`, "0.0010")]);
    expect((await oversized.select(MODEL)).reason.length).toBe(512);
  });

  it("lets custom weights change who wins", async () => {
    const nodes = [
      // Cheapest but slowest and least reliable.
      node("node-a", "0.0001", { latencyMsP95: 900, qualityScore: 0.2 }),
      // Fastest and most reliable but dearest.
      node("node-b", "0.0090", { latencyMsP95: 100, qualityScore: 1 }),
    ];
    const priceOnly = await selectorWith(nodes, {
      rng: pinnedRng([0.5]),
      weights: { latency: 0, price: 1, quality: 0 },
      weightFloor: 0.000_001,
    });
    const latencyOnly = await selectorWith(nodes, {
      rng: pinnedRng([0.5]),
      weights: { latency: 1, price: 0, quality: 0 },
      weightFloor: 0.000_001,
    });

    expect((await priceOnly.select(MODEL)).node.registration.nodeId).toBe("node-a");
    expect((await latencyOnly.select(MODEL)).node.registration.nodeId).toBe("node-b");
  });
});

describe("a registration outlives the network it was made on", () => {
  /**
   * Registrations are validated at registration time and then persisted, so flipping a
   * gateway from TestNet to MainNet leaves the old ones in the store — healthy, advertising
   * their models, and routable. Observed for real during the MainNet flip: a TestNet node
   * stayed listed as healthy on a gateway that had moved to MainNet. Routing to one takes the
   * client's money and then pays, or fails to pay, an operator on a chain we no longer settle.
   */
  it("refuses to route to a node registered on a different network", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "stale-testnet", network: ALGORAND_TESTNET }));

    const selector = new NodeSelector(store, { network: ALGORAND_MAINNET });
    await expect(selector.select("llama3.1:8b")).rejects.toThrow(NoCapacityError);
  });

  it("reports it as wrongNetwork, not unhealthy", async () => {
    // "unhealthy" would send an operator chasing a node that is working perfectly.
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "stale-testnet", network: ALGORAND_TESTNET }));
    const selector = new NodeSelector(store, { network: ALGORAND_MAINNET });

    await expect(selector.select("llama3.1:8b")).rejects.toMatchObject({
      details: { rejected: { wrongNetwork: 1, unhealthy: 0 } },
    });
  });

  it("routes normally to a node on the matching network", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "mainnet-ok", network: ALGORAND_MAINNET }));

    const selector = new NodeSelector(store, { network: ALGORAND_MAINNET });
    const chosen = await selector.select("llama3.1:8b");
    expect(chosen.node.registration.nodeId).toBe("mainnet-ok");
  });

  it("skips the check when no network is configured, preserving old behaviour", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "whatever", network: ALGORAND_TESTNET }));

    await expect(new NodeSelector(store).select("llama3.1:8b")).resolves.toBeDefined();
  });
});

describe("a node that stopped heartbeating stops being routable", () => {
  /**
   * Health is only recomputed from request outcomes, so a node that is switched off keeps its
   * last-known `healthy: true` and keeps winning selection. The mesh only learns otherwise by
   * losing real requests to it — each one a client charged for a completion that failed.
   *
   * Observed: a decommissioned node still listed healthy and routable 105 minutes after its
   * last heartbeat.
   */
  const NOW = 1_000_000_000;

  it("rejects a node whose last heartbeat is older than the window", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "gone", lastSeenAt: NOW - 200_000 }));

    const selector = new NodeSelector(store, { staleAfterMs: 90_000, now: () => NOW });
    await expect(selector.select("llama3.1:8b")).rejects.toMatchObject({
      // Reported as stale, not unhealthy: the last health reading was fine, it is just old.
      details: { rejected: { stale: 1, unhealthy: 0 } },
    });
  });

  it("keeps a node that heartbeated within the window", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "alive", lastSeenAt: NOW - 30_000 }));

    const selector = new NodeSelector(store, { staleAfterMs: 90_000, now: () => NOW });
    await expect(selector.select("llama3.1:8b")).resolves.toMatchObject({
      node: { registration: { nodeId: "alive" } },
    });
  });

  it("tolerates a brief blip rather than evicting on one missed beat", async () => {
    // The default window is six beats at the daemon's 15s interval; a restart must not cost a
    // healthy node its place.
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "blip", lastSeenAt: NOW - 20_000 }));

    const selector = new NodeSelector(store, { staleAfterMs: 90_000, now: () => NOW });
    await expect(selector.select("llama3.1:8b")).resolves.toBeDefined();
  });

  it("skips the check when no window is configured", async () => {
    const store = new MemoryNodeStore();
    await store.upsert(makeNode({ nodeId: "ancient", lastSeenAt: 1 }));
    await expect(new NodeSelector(store).select("llama3.1:8b")).resolves.toBeDefined();
  });
});
