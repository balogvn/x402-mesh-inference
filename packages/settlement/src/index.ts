/**
 * `@x402-mesh/settlement` — splitting a micropayment between a platform and a
 * supplier, on-chain, and amortizing the transaction fee so the split is
 * economically possible at all.
 *
 * This package contains no reference to inference, HTTP, Algorand or Redis. It
 * knows how to divide a payment, when to hold an accrued balance and when to pay
 * it, and how to record what happened. Everything else arrives through the ports
 * in `./ports.js`.
 *
 * The problem it exists for: a payout costs a flat network fee whatever its size.
 * On a small enough payment that fee exceeds the margin, and below that floor a
 * marketplace cannot exist — only a prepaid account with a reconciliation
 * problem. Batching moves the floor.
 */

export { DoubleSettlementService, DEFAULT_RETRY_POLICY, parseInboundAmount } from "./service.js";
export type { SettlementDeps, RetryPolicy } from "./service.js";
export type { SettlementConfig, Network } from "./config.js";
export type {
  Atomic,
  SettlementRecord,
  Clock,
  InboundSettlement,
  Logger,
  PayoutRequest,
  PendingPayout,
  SettlementServicePort,
  Sleep,
  UsdcPayoutPort,
  WithSpan,
} from "./ports.js";
