import { PricingError } from "./errors.js";
import type { Atomic } from "./money.js";

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
