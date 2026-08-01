import { describe, expect, it } from "vitest";
import { ConfigError, type NodeRecord } from "@x402-mesh/shared";
import {
  DEFAULT_WEIGHTS,
  nodePriceAtomic,
  scoreNode,
  type ScoreContext,
  type ScoreWeights,
} from "../src/index.js";
import { makeNode } from "./fixtures.js";

/**
 * Scoring is the mechanism that decides which operator gets paid, so the properties asserted
 * here are the ones the design actually promises: normalization against the candidate set,
 * monotonicity in each dimension, and no arithmetic landmines at the edges.
 */

const MODEL = "llama3.1:8b";

function priceOf(node: NodeRecord, model: string): bigint {
  const price = nodePriceAtomic(node, model);
  if (price === null) throw new Error(`${node.registration.nodeId} has no price for ${model}`);
  return price;
}

/** Reproduces the extrema the selector computes, so scoreNode is exercised as it is called. */
function contextFor(
  nodes: readonly NodeRecord[],
  model = MODEL,
  weights?: ScoreWeights,
): ScoreContext {
  const latencies = nodes.map((n) => n.health.latencyMsP95);
  const prices = nodes.map((n) => priceOf(n, model));
  const ctx: ScoreContext = {
    model,
    minLatencyMs: Math.min(...latencies),
    maxLatencyMs: Math.max(...latencies),
    minPriceAtomic: prices.reduce((a, b) => (b < a ? b : a)),
    maxPriceAtomic: prices.reduce((a, b) => (b > a ? b : a)),
  };
  return weights === undefined ? ctx : { ...ctx, weights };
}

function scoreAll(nodes: readonly NodeRecord[], weights?: ScoreWeights): number[] {
  const ctx = contextFor(nodes, MODEL, weights);
  return nodes.map((n) => scoreNode(n, ctx));
}

/** Scores exactly two candidates against each other, with no `undefined` to reason about. */
function scorePair(a: NodeRecord, b: NodeRecord, weights?: ScoreWeights): [number, number] {
  const [first, second] = scoreAll([a, b], weights);
  if (first === undefined || second === undefined) throw new Error("expected two scores");
  return [first, second];
}

function scoreOnly(node: NodeRecord, weights?: ScoreWeights): number {
  const [score] = scoreAll([node], weights);
  if (score === undefined) throw new Error("expected one score");
  return score;
}

function rankingOf(nodes: readonly NodeRecord[]): string[] {
  const scores = scoreAll(nodes);
  return nodes
    .map((n, i) => ({ id: n.registration.nodeId, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .map((e) => e.id);
}

function withPrice(nodeId: string, priceUsdc: string): NodeRecord {
  return makeNode({
    nodeId,
    capabilities: [{ model: MODEL, contextWindow: 8192, pricePer1kTokensUsdc: priceUsdc }],
  });
}

describe("nodePriceAtomic", () => {
  it("returns the advertised price in atomic units", () => {
    expect(nodePriceAtomic(withPrice("node-a", "0.0010"), MODEL)).toBe(1000n);
    expect(nodePriceAtomic(withPrice("node-a", "1.5"), MODEL)).toBe(1_500_000n);
    expect(nodePriceAtomic(withPrice("node-a", "0"), MODEL)).toBe(0n);
  });

  it("returns null for a model the node does not advertise", () => {
    expect(nodePriceAtomic(withPrice("node-a", "0.0010"), "qwen2.5:14b")).toBeNull();
  });

  it("returns null rather than throwing on a malformed quoted price", () => {
    expect(nodePriceAtomic(withPrice("node-a", "not-a-price"), MODEL)).toBeNull();
    expect(nodePriceAtomic(withPrice("node-a", "-0.5"), MODEL)).toBeNull();
    expect(nodePriceAtomic(withPrice("node-a", "0.00000001"), MODEL)).toBeNull();
  });
});

describe("scoreNode normalization", () => {
  it("is invariant to a rescaling of every candidate's latency", () => {
    const base = [
      makeNode({ nodeId: "node-a", latencyMsP95: 120, qualityScore: 1 }),
      makeNode({ nodeId: "node-b", latencyMsP95: 350, qualityScore: 0.8 }),
      makeNode({ nodeId: "node-c", latencyMsP95: 800, qualityScore: 0.6 }),
    ];
    const scaled = base.map((n) =>
      makeNode({
        nodeId: n.registration.nodeId,
        latencyMsP95: n.health.latencyMsP95 * 1000,
        qualityScore: n.health.qualityScore,
      }),
    );

    // The ranking is the thing that routes money, and it must not move.
    expect(rankingOf(base)).toEqual(["node-a", "node-b", "node-c"]);
    expect(rankingOf(scaled)).toEqual(rankingOf(base));

    const before = scoreAll(base);
    const after = scoreAll(scaled);
    for (const [i, score] of before.entries()) {
      expect(after[i]).toBeCloseTo(score, 12);
    }
  });

  it("is invariant to a rescaling of every candidate's price", () => {
    const base = [
      withPrice("node-a", "0.0010"),
      withPrice("node-b", "0.0025"),
      withPrice("node-c", "0.0007"),
    ];
    // The same prices multiplied by 1000; the bigint ratio truncates identically.
    const scaled = [
      withPrice("node-a", "1.000000"),
      withPrice("node-b", "2.500000"),
      withPrice("node-c", "0.700000"),
    ];

    expect(scoreAll(scaled)).toEqual(scoreAll(base));
    expect(rankingOf(scaled)).toEqual(rankingOf(base));
  });

  it("does not divide by zero for a single candidate", () => {
    const score = scoreOnly(makeNode({ nodeId: "node-a", latencyMsP95: 400, qualityScore: 0.5 }));
    expect(Number.isFinite(score)).toBe(true);
    // Degenerate spans stop discriminating: both "lower is better" terms become 1.
    expect(score).toBeCloseTo(0.4 + 0.3 + 0.3 * 0.5, 12);
  });

  it("does not divide by zero when every candidate is identical", () => {
    const [first, second] = scorePair(
      makeNode({ nodeId: "node-a", latencyMsP95: 400, qualityScore: 0.5 }),
      makeNode({ nodeId: "node-b", latencyMsP95: 400, qualityScore: 0.5 }),
    );
    expect(Number.isNaN(first)).toBe(false);
    expect(first).toBe(second);
    expect(first).toBeCloseTo(0.85, 12);
  });

  it("keeps every score inside the unit interval", () => {
    const scores = scoreAll([
      makeNode({ nodeId: "node-a", latencyMsP95: 1, qualityScore: 1 }),
      makeNode({ nodeId: "node-b", latencyMsP95: 100_000, qualityScore: 0 }),
    ]);
    for (const score of scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("tolerates non-finite extrema instead of producing NaN", () => {
    const score = scoreNode(makeNode({ nodeId: "node-a", latencyMsP95: 200 }), {
      model: MODEL,
      minLatencyMs: Number.POSITIVE_INFINITY,
      maxLatencyMs: Number.NEGATIVE_INFINITY,
      minPriceAtomic: 0n,
      maxPriceAtomic: 0n,
    });
    expect(Number.isNaN(score)).toBe(false);
    expect(score).toBeCloseTo(1, 12);
  });
});

describe("scoreNode monotonicity", () => {
  it("raises the score as latency falls, holding price and quality equal", () => {
    const [fast, slow] = scorePair(
      makeNode({ nodeId: "node-a", latencyMsP95: 100 }),
      makeNode({ nodeId: "node-b", latencyMsP95: 500 }),
    );
    expect(fast).toBeGreaterThan(slow);
    expect(fast - slow).toBeCloseTo(DEFAULT_WEIGHTS.latency, 12);
  });

  it("raises the score as price falls, holding latency and quality equal", () => {
    const [cheap, dear] = scorePair(withPrice("node-a", "0.0010"), withPrice("node-b", "0.0090"));
    expect(cheap).toBeGreaterThan(dear);
    expect(cheap - dear).toBeCloseTo(DEFAULT_WEIGHTS.price, 12);
  });

  it("raises the score as quality rises, holding latency and price equal", () => {
    const [good, poor] = scorePair(
      makeNode({ nodeId: "node-a", qualityScore: 1 }),
      makeNode({ nodeId: "node-b", qualityScore: 0.25 }),
    );
    expect(good).toBeGreaterThan(poor);
    expect(good - poor).toBeCloseTo(DEFAULT_WEIGHTS.quality * 0.75, 12);
  });

  it("forfeits only the price term for a node it cannot price", () => {
    const priced = withPrice("node-a", "0.0010");
    const other = withPrice("node-b", "0.0020");
    const ctx = contextFor([priced, other]);
    // Score against a model this node does not advertise: nodePriceAtomic returns null.
    const score = scoreNode(other, { ...ctx, model: "absent-model" });
    expect(score).toBeCloseTo(DEFAULT_WEIGHTS.latency + DEFAULT_WEIGHTS.quality, 12);
  });
});

describe("scoreNode weights", () => {
  it("uses the documented default mix", () => {
    expect(DEFAULT_WEIGHTS).toEqual({ latency: 0.4, price: 0.3, quality: 0.3 });
  });

  it("rescales weights that do not sum to 1", () => {
    const fast = makeNode({ nodeId: "node-a", latencyMsP95: 100, qualityScore: 0.5 });
    const slow = makeNode({ nodeId: "node-b", latencyMsP95: 500, qualityScore: 0.5 });
    const unit = scorePair(fast, slow, { latency: 0.4, price: 0.3, quality: 0.3 });
    const scaled = scorePair(fast, slow, { latency: 40, price: 30, quality: 30 });
    expect(scaled[0]).toBeCloseTo(unit[0], 12);
    expect(scaled[1]).toBeCloseTo(unit[1], 12);
  });

  it("collapses to a single dimension when the other weights are zero", () => {
    const [a, b] = scorePair(
      makeNode({ nodeId: "node-a", latencyMsP95: 100, qualityScore: 0.25 }),
      makeNode({ nodeId: "node-b", latencyMsP95: 500, qualityScore: 0.75 }),
      { latency: 0, price: 0, quality: 1 },
    );
    expect(a).toBeCloseTo(0.25, 12);
    expect(b).toBeCloseTo(0.75, 12);
  });

  it("rejects a weighting that would make the ranking meaningless", () => {
    const node = makeNode({ nodeId: "node-a" });
    const ctx = contextFor([node]);
    const reject = (weights: ScoreWeights): void => {
      expect(() => scoreNode(node, { ...ctx, weights })).toThrow(ConfigError);
    };

    reject({ latency: 0, price: 0, quality: 0 });
    reject({ latency: -1, price: 1, quality: 1 });
    reject({ latency: Number.NaN, price: 1, quality: 1 });
    reject({ latency: Number.POSITIVE_INFINITY, price: 1, quality: 1 });
    reject({ latency: 1, price: -0.0001, quality: 1 });
  });
});
