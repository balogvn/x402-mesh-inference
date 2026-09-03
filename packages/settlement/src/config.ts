import type { Network } from "@x402/core/types";

import type { Atomic } from "@x402-mesh/shared";

/**
 * Everything the settlement core needs to know about its host.
 *
 * Five fields, and that is the point. The service used to take the whole
 * `GatewayConfig` — around forty fields covering providers, ports, log levels and
 * model prices — of which it read exactly these. Narrowing it is what makes the
 * package depend on a contract rather than on an application.
 *
 * `GatewayConfig` satisfies this structurally, so the gateway passes its own
 * config unchanged and TypeScript checks the fit.
 */
export interface SettlementConfig {
  /**
   * Chain the payout leg settles on, CAIP-2 (`algorand:<genesis-hash>`).
   *
   * The full identifier rather than a "mainnet"/"testnet" selector on purpose: a
   * stored node record carrying the wrong genesis hash is how paid MainNet
   * traffic once routed to a TestNet address that could not receive it.
   */
  readonly network: Network;

  /**
   * Platform margin in basis points, applied to the inbound payment.
   *
   * The split is `margin = inbound * bps / 10_000`, `payout = inbound - margin`,
   * in integer atomic units — never floats, and the invariant
   * `inbound - payout === margin` is asserted before funds move.
   */
  readonly marginBps: number;

  /**
   * Accrue operator payouts until this much USDC is owed, then pay once.
   *
   * This is the fee-amortization knob, and it is the reason the marketplace is
   * economically possible at all: a payout costs a flat network fee whatever its
   * size, so below some threshold paying a supplier costs more than the payment
   * is worth. Zero disables batching and pays every request individually.
   */
  readonly payoutBatchMinUsdc: string;

  /** Pay out once this many requests have accrued, whatever the balance. */
  readonly payoutBatchMaxRequests: number;

  /**
   * Hard ceiling on how long an accrued payout may wait, however small.
   *
   * Batching means the platform is holding funds it owes. This bounds that, and
   * it is a promise to operators rather than a tuning parameter.
   */
  readonly payoutBatchMaxDelayMs: number;
}

/** Re-exported so callers can type amounts without reaching for `@x402-mesh/shared`. */
export type { Atomic, Network };
