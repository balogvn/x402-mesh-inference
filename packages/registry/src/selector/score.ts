import { ConfigError, usdcToAtomic, type NodeRecord } from "@x402-mesh/shared";

/**
 * Composite routing score.
 *
 * Latency is in milliseconds, price is in atomic USDC units and quality is already a ratio —
 * three quantities whose raw magnitudes differ by orders of magnitude. Summing them directly
 * would let whichever dimension happens to have the largest unit scale decide every route, so
 * each term is first normalized to `[0, 1]` **against the current candidate set**. That makes
 * the score a statement about relative standing among the nodes that can actually serve this
 * request, and makes it scale-invariant: expressing latency in seconds or price in a different
 * denomination cannot change the ranking.
 */

/** Relative importance of each scoring dimension. Need not sum to 1; they are normalized. */
export interface ScoreWeights {
  latency: number;
  price: number;
  quality: number;
}

/**
 * Default mix: latency dominates because a user waiting on a completion feels it immediately,
 * while a fraction of a cent of price difference is invisible to them.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = Object.freeze({
  latency: 0.4,
  price: 0.3,
  quality: 0.3,
});

/** Candidate-set extrema, supplied by the caller so every node is scored on the same basis. */
export interface ScoreContext {
  /** Model being routed. Selects which of the node's quoted prices applies. */
  model: string;
  /** Lowest p95 latency across the candidate set, in milliseconds. */
  minLatencyMs: number;
  /** Highest p95 latency across the candidate set, in milliseconds. */
  maxLatencyMs: number;
  /** Lowest per-1k-token price across the candidate set, in atomic USDC units. */
  minPriceAtomic: bigint;
  /** Highest per-1k-token price across the candidate set, in atomic USDC units. */
  maxPriceAtomic: bigint;
  /** Overrides {@link DEFAULT_WEIGHTS}. */
  weights?: ScoreWeights;
}

/** Precision retained when reducing a `bigint` price ratio to a float. */
const RATIO_SCALE = 1_000_000n;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Rescales weights so they sum to 1, guaranteeing the composite score lands in `[0, 1]`
 * regardless of what the caller passed.
 *
 * @throws {ConfigError} on negative, non-finite or all-zero weights — each is a configuration
 * bug that would silently produce a meaningless ranking if it were tolerated.
 */
function normalizeWeights(w: ScoreWeights): ScoreWeights {
  const entries: ReadonlyArray<readonly [keyof ScoreWeights, number]> = [
    ["latency", w.latency],
    ["price", w.price],
    ["quality", w.quality],
  ];
  for (const [name, value] of entries) {
    if (!Number.isFinite(value) || value < 0) {
      throw new ConfigError(`scoring weight "${name}" must be a non-negative finite number`, {
        weight: name,
        value: String(value),
      });
    }
  }
  const total = w.latency + w.price + w.quality;
  if (total <= 0) {
    throw new ConfigError("scoring weights must not all be zero");
  }
  return { latency: w.latency / total, price: w.price / total, quality: w.quality / total };
}

/**
 * Position of `value` within `[min, max]`, as a ratio in `[0, 1]`.
 *
 * A degenerate span (every candidate identical, or a single candidate) returns 0, which makes
 * the derived "lower is better" term 1 for everyone — the dimension simply stops discriminating
 * instead of arbitrarily favouring someone.
 */
function normalizeNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return 0;
  const span = max - min;
  if (span <= 0) return 0;
  return clamp01((value - min) / span);
}

/**
 * `bigint` counterpart of {@link normalizeNumber}.
 *
 * Money stays in integer atomic units through the division; only the resulting dimensionless
 * ratio becomes a float. Because `(k·offset · SCALE) / (k·span)` truncates identically to
 * `(offset · SCALE) / span`, the result is exactly invariant to a rescaling of the whole set.
 */
function normalizeAtomic(value: bigint, min: bigint, max: bigint): number {
  const span = max - min;
  if (span <= 0n) return 0;
  const offset = value - min;
  if (offset <= 0n) return 0;
  if (offset >= span) return 1;
  return Number((offset * RATIO_SCALE) / span) / Number(RATIO_SCALE);
}

/**
 * The node's quoted price for `model`, in atomic USDC units per 1000 tokens.
 *
 * @returns `null` when the node does not advertise the model, or when its quoted price is
 * malformed. A node that cannot be priced cannot be paid, so it must not be routed to — that is
 * an operator configuration error, not a reason to fail the caller's request.
 */
export function nodePriceAtomic(node: NodeRecord, model: string): bigint | null {
  const capability = node.registration.capabilities.find((c) => c.model === model);
  if (capability === undefined) return null;
  try {
    return usdcToAtomic(capability.pricePer1kTokensUsdc);
  } catch {
    return null;
  }
}

/**
 * Scores one node against the candidate-set extrema in `ctx`.
 *
 * Lower latency, lower price and higher quality all raise the score. The result is in `[0, 1]`.
 *
 * p95 rather than p50 drives the latency term: median latency hides the tail that users
 * actually complain about, and a node with a good median and a terrible tail is a bad route.
 *
 * @throws {ConfigError} if `ctx.weights` is not a valid weighting.
 */
export function scoreNode(n: NodeRecord, ctx: ScoreContext): number {
  const weights = normalizeWeights(ctx.weights ?? DEFAULT_WEIGHTS);

  const latencyTerm =
    1 - normalizeNumber(n.health.latencyMsP95, ctx.minLatencyMs, ctx.maxLatencyMs);

  const price = nodePriceAtomic(n, ctx.model);
  const priceTerm =
    price === null ? 0 : 1 - normalizeAtomic(price, ctx.minPriceAtomic, ctx.maxPriceAtomic);

  const qualityTerm = clamp01(n.health.qualityScore);

  return clamp01(
    weights.latency * latencyTerm + weights.price * priceTerm + weights.quality * qualityTerm,
  );
}
