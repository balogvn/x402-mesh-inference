/**
 * `@x402-mesh/gateway` — the stateless x402 control plane.
 *
 * The gateway holds no durable state of its own: node records live behind
 * {@link NodeStorePort}, money moves through a facilitator and an Algorand wallet, and the
 * settlement ledger is an in-memory audit view of what already happened on chain. That is
 * what makes it horizontally scalable and what makes it testable.
 *
 * `server.ts` is the executable entrypoint and is deliberately not re-exported here.
 */
export { createApp, attachSettlementHook } from "./app.js";
export type { GatewayDeps } from "./app.js";

export { createLogger, silentLogger } from "./logger.js";
export type { Logger } from "./logger.js";

export type {
  ChainReaderPort,
  Clock,
  InboundSettlement,
  NodeOutcome,
  NodeSelectionCriteria,
  NodeSelectorPort,
  NodeStorePort,
  PayoutRequest,
  RouteInput,
  RouteResult,
  RouterPort,
  SettlementServicePort,
  Sleep,
  StreamSink,
  UsdcPayoutPort,
} from "./ports.js";

export { createChatRouter, createResponseSink, NODE_ID_HEADER } from "./routes/chat.js";
export {
  buildLlmsTxt,
  buildManifest,
  createDiscoveryRouter,
  findSpecDir,
  paymentRequirements,
} from "./routes/discovery.js";
export { createHealthRouter, economics, MIN_WALLET_MICRO_ALGOS } from "./routes/health.js";
export { createNodeRouter, verifyRegistrationSignature } from "./routes/nodes.js";

export {
  AlgokitChainReader,
  AlgokitUsdcPayer,
  attachGatewayWallet,
  createAlgorandClient,
  payoutLease,
  readAlgodOverrides,
} from "./services/algorand.js";
export { NonceCache } from "./services/nonceCache.js";
export { RegistrySelectorAdapter, RegistryStoreAdapter } from "./services/registryAdapter.js";
export { HttpNodeRouter } from "./services/router.js";
export { DEFAULT_RETRY_POLICY, DoubleSettlementService } from "@x402-mesh/settlement";
export type { RetryPolicy, SettlementDeps } from "@x402-mesh/settlement";

export { initTelemetry, withSpan } from "./telemetry/otel.js";

export { errorHandler } from "./middleware/errorHandler.js";
export { createChatUiRouter, renderChatUi } from "./routes/chat-ui.js";
export { createLandingRouter, renderLanding, landingEconomics } from "./routes/landing.js";
export { payerFromRequest, rateLimit, rateLimitKey } from "./middleware/rateLimit.js";
export { getRequestId, REQUEST_ID_HEADER, requestId } from "./middleware/requestId.js";

export {
  buildPaymentOption,
  buildRoutesConfig,
  discoveryTags,
  EXAMPLE_REQUEST,
  EXAMPLE_RESPONSE,
  maxTimeoutSeconds,
  PAID_ROUTE_KEY,
  PAID_ROUTE_PATH,
  unpaidPreview,
} from "./x402/routes.js";
export { buildResourceServer } from "./x402/server.js";
