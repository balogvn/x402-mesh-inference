import { ConfigError, PricingError } from "./errors.js";
import type { Atomic } from "./money.js";
import { usdcToAtomic } from "./money.js";

/**
 * The three legs of a single routed request, in atomic USDC units.
 *
 * Invariant: `inbound === payout + margin`, and all three are non-negative.
 */
export interface PriceSplit {
  /** Charged to the client by the gateway. */
  inbound: Atomic;
  /** Forwarded to the node operator that served the request. */
  payout: Atomic;
  /** Retained by the gateway. */
  margin: Atomic;
}

/** Basis points denominator. 10000 bps === 100%. */
const BPS_DENOMINATOR = 10_000n;

/** Default price charged to the client per request: $0.0020 USDC. */
export const DEFAULT_INBOUND_USDC = "0.0020";

/** Default payout to the node operator per request: $0.0017 USDC. */
export const DEFAULT_NODE_PAYOUT_USDC = "0.0017";

/** Default gateway margin per request: $0.0003 USDC. */
export const DEFAULT_MARGIN_USDC = "0.0003";

/**
 * Default gateway margin in basis points.
 *
 * 1500 bps === 15%, which on the default 2000 atomic inbound yields exactly 300 atomic
 * margin and 1700 atomic payout — no rounding, matching the published economics.
 */
export const DEFAULT_MARGIN_BPS = 1500;

/**
 * Per-model overrides of the inbound price, keyed by lowercased model id.
 *
 * Absent keys fall back to the flat {@link GatewayConfig.inboundPriceUsdc}, so an operator
 * who never sets `MESH_MODEL_PRICES` keeps exactly the old single-price behaviour.
 */
export type ModelPrices = Readonly<Record<string, string>>;

/**
 * Ceiling on distinct prices a deployment may advertise.
 *
 * Each distinct price costs one `paymentMiddleware` instance (see the gateway's tier
 * dispatch), and every one of those syncs with the facilitator at boot. A typo that turns a
 * price table into hundreds of entries would otherwise become a boot-time thundering herd
 * against the facilitator, so it is rejected at config load instead.
 */
export const MAX_PRICE_TIERS = 16;

/**
 * Normalises a model id for price lookup.
 *
 * Model ids arrive from three uncoordinated places — the operator's env var, the node's
 * advertised capability, and the client's request body — and a case mismatch between them
 * would silently charge the fallback price rather than the configured one. Lowercasing all
 * three at the boundary makes the lookup total.
 */
export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * Parses the `MESH_MODEL_PRICES` JSON object into a validated price table.
 *
 * Every value is run through {@link usdcToAtomic}, so a malformed or over-precise price fails
 * at boot rather than at the moment a client tries to pay for that model. An empty or absent
 * value yields an empty table.
 *
 * @param raw - JSON object mapping model id to decimal USDC string, e.g.
 * `{"llama-3.3-70b-versatile":"0.0040"}`.
 * @throws {ConfigError} on invalid JSON, a non-object, a non-string price, a malformed
 * price, or more than {@link MAX_PRICE_TIERS} distinct prices.
 */
export function parseModelPrices(raw: string | undefined): ModelPrices {
  if (raw === undefined || raw.trim() === "") return {};

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new ConfigError("MESH_MODEL_PRICES must be a JSON object", {
      variables: ["MESH_MODEL_PRICES"],
    });
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new ConfigError("MESH_MODEL_PRICES must be a JSON object of model -> price", {
      variables: ["MESH_MODEL_PRICES"],
    });
  }

  const table: Record<string, string> = {};
  for (const [model, price] of Object.entries(decoded)) {
    const key = normalizeModelId(model);
    if (key === "") {
      throw new ConfigError("MESH_MODEL_PRICES contains an empty model id", {
        variables: ["MESH_MODEL_PRICES"],
      });
    }
    if (typeof price !== "string") {
      throw new ConfigError(`MESH_MODEL_PRICES price for "${model}" must be a string`, {
        variables: ["MESH_MODEL_PRICES"],
        model,
        received: typeof price,
      });
    }
    // Validates format, precision and sign. The parsed value is discarded: the table stores
    // the decimal string, because that is what the x402 `Money` price field consumes.
    usdcToAtomic(price);
    table[key] = price.trim();
  }

  const distinct = new Set(Object.values(table));
  if (distinct.size > MAX_PRICE_TIERS) {
    throw new ConfigError(
      `MESH_MODEL_PRICES declares ${distinct.size} distinct prices, maximum is ${MAX_PRICE_TIERS}`,
      { variables: ["MESH_MODEL_PRICES"], distinct: distinct.size, max: MAX_PRICE_TIERS },
    );
  }
  return table;
}

/**
 * Resolves what a client is charged for one request against `model`.
 *
 * @param prices - The configured per-model table.
 * @param fallback - Price for any model not named in the table.
 * @param model - Model id from the request body; may be absent on a malformed request.
 */
export function resolveModelPrice(
  prices: ModelPrices,
  fallback: string,
  model: string | undefined,
): string {
  if (model === undefined) return fallback;
  return prices[normalizeModelId(model)] ?? fallback;
}

/**
 * Every distinct price the deployment can quote, fallback first.
 *
 * The gateway builds one payment middleware per entry, so this is deliberately deduplicated:
 * two models at the same price share a tier.
 */
export function priceTiers(prices: ModelPrices, fallback: string): readonly string[] {
  return [...new Set([fallback, ...Object.values(prices)])];
}

/**
 * Splits an inbound charge into an operator payout and a gateway margin using integer
 * arithmetic only.
 *
 * The margin floors (bigint division truncates toward zero for non-negative operands), so
 * any sub-atomic remainder accrues to the operator rather than the gateway. The invariant
 * `inbound === payout + margin` is asserted, not assumed: a violation throws instead of
 * quietly minting or burning value.
 *
 * @param inbound - Total charged to the client, in atomic USDC units.
 * @param marginBps - Gateway margin in basis points, an integer in [0, 10000].
 * @throws {PricingError} on a non-bigint or negative `inbound`, an out-of-range
 * `marginBps`, or a broken invariant.
 */
export function computeSplit(inbound: Atomic, marginBps: number): PriceSplit {
  if (typeof inbound !== "bigint") {
    throw new PricingError("inbound amount must be a bigint of atomic units", {
      received: typeof inbound,
    });
  }
  if (inbound < 0n) {
    throw new PricingError("inbound amount must be non-negative", {
      inbound: inbound.toString(10),
    });
  }
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps > 10_000) {
    throw new PricingError("marginBps must be an integer in [0, 10000]", { marginBps });
  }

  const margin = (inbound * BigInt(marginBps)) / BPS_DENOMINATOR;
  const payout = inbound - margin;

  if (margin < 0n || payout < 0n) {
    throw new PricingError("price split produced a negative leg", {
      inbound: inbound.toString(10),
      payout: payout.toString(10),
      margin: margin.toString(10),
      marginBps,
    });
  }
  if (payout + margin !== inbound) {
    throw new PricingError("price split violates inbound === payout + margin", {
      inbound: inbound.toString(10),
      payout: payout.toString(10),
      margin: margin.toString(10),
      marginBps,
    });
  }

  return { inbound, payout, margin };
}

/**
 * Re-checks the economic invariant on a split that came from elsewhere (a stored settlement
 * record, an RPC payload) before any funds move on the back of it.
 *
 * @throws {PricingError} if any leg is negative or the legs do not sum.
 */
export function assertSplitInvariant(split: PriceSplit): void {
  const { inbound, payout, margin } = split;
  if (typeof inbound !== "bigint" || typeof payout !== "bigint" || typeof margin !== "bigint") {
    throw new PricingError("price split legs must all be bigint atomic units");
  }
  if (inbound < 0n || payout < 0n || margin < 0n) {
    throw new PricingError("price split legs must all be non-negative", {
      inbound: inbound.toString(10),
      payout: payout.toString(10),
      margin: margin.toString(10),
    });
  }
  if (inbound - payout !== margin) {
    throw new PricingError("price split violates inbound - payout === margin", {
      inbound: inbound.toString(10),
      payout: payout.toString(10),
      margin: margin.toString(10),
    });
  }
}
