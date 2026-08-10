import type { GatewayConfig } from "@x402-mesh/shared";
import { priceTiers, resolveModelPrice, SettlementError } from "@x402-mesh/shared";
import type { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { createPaywall } from "@x402/paywall";
import { avmPaywall } from "@x402/paywall/avm";
import express from "express";
import type { Express } from "express";
import type { Logger } from "./logger.js";
import { silentLogger } from "./logger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { REQUEST_ID_HEADER, requestId } from "./middleware/requestId.js";
import type {
  ChainReaderPort,
  Clock,
  NodeSelectorPort,
  NodeStorePort,
  RouterPort,
  SettlementServicePort,
} from "./ports.js";
import { createChatRouter, NODE_ID_HEADER } from "./routes/chat.js";
import { createDiscoveryRouter } from "./routes/discovery.js";
import { createLandingRouter } from "./routes/landing.js";
import { createChatUiRouter } from "./routes/chat-ui.js";
import { createHealthRouter } from "./routes/health.js";
import { createNodeRouter } from "./routes/nodes.js";
import { createQuickstartRouter } from "./routes/quickstart.js";
import { HttpNodeRouter } from "./services/router.js";
import { parseInboundAmount } from "./services/settlement.js";
import { buildRoutesConfig, PAID_ROUTE_PATHS } from "./x402/routes.js";

/**
 * Assembles the Express application.
 *
 * Everything the gateway touches arrives through {@link GatewayDeps}, which is what makes
 * the whole surface — 402 responses, registration, routing, streaming, settlement — testable
 * with no network, no wallet and no Redis. `server.ts` is the only place that builds the
 * real collaborators.
 *
 * Middleware order is deliberate and load-bearing:
 *
 * ```text
 *   json body parser        the x402 adapter reads req.body, so it must already be parsed
 *   requestId               every later layer, including settlement, keys off this
 *   free routes             health, discovery and node lifecycle must never be paywalled
 *   rateLimit (paid path)   cheap rejection before any facilitator round trip
 *   paymentMiddleware       self-filtering; only the declared route is guarded
 *   chat route              runs having been paid for
 *   errorHandler            terminal, uses toErrorResponse
 * ```
 */

/** Everything `createApp` needs. The first four are required; the rest have defaults. */
export interface GatewayDeps {
  config: GatewayConfig;
  store: NodeStorePort;
  selector: NodeSelectorPort;
  settlement: SettlementServicePort;

  /**
   * The x402 resource server guarding the paid route.
   *
   * Omit it to build an app with the paid route **unguarded** — useful for exercising
   * routing and streaming in isolation, never appropriate in production.
   */
  resourceServer?: x402ResourceServer;
  /** Overrides the default HTTP router; tests inject a stub to avoid an upstream server. */
  router?: RouterPort;
  /** Chain reads for registration opt-in checks. Defaults to "never opted in". */
  chain?: ChainReaderPort;
  logger?: Logger;
  now?: Clock;
  /** Injected upstream fetch, used by the default router. */
  fetchImpl?: typeof fetch;
  /** Directory holding the discovery templates; defaults to the repository's `spec/`. */
  specDir?: string;
  /** `/readyz` facilitator probe. Defaults to a real `GET /supported` call. */
  probeFacilitator?: () => Promise<{ ok: boolean; detail?: string }>;
  /** `/readyz` wallet funding probe. Omitted when no payout wallet is configured. */
  probeWallet?: () => Promise<{ ok: boolean; detail?: string }>;
  /** Whether the payment middleware syncs with the facilitator on first paid request. */
  syncFacilitatorOnStart?: boolean;
  /** Rate limit burst size for the paid route. */
  rateLimitCapacity?: number;
  /** Rate limit steady-state refill, in tokens per second. */
  rateLimitPerSecond?: number;
}

/** Default burst allowance on the paid route, per payer. */
const DEFAULT_RATE_LIMIT_CAPACITY = 60;

/** Default sustained rate on the paid route, per payer. */
const DEFAULT_RATE_LIMIT_PER_SECOND = 2;

/** Largest JSON body accepted; a chat request with 512 messages fits comfortably. */
const MAX_BODY_SIZE = "1mb";

/** Branding the Algorand paywall renders. */
const PAYWALL_CONFIG = {
  appName: "x402 Mesh Inference",
  appLogo: "",
} as const;

/**
 * Builds the browser paywall, memoised.
 *
 * `generateHtml` is pure, but constructing the provider pulls in the paywall bundle, so it is
 * built once per process rather than per app. Only the AVM handler is registered — this
 * gateway settles on Algorand and nothing else, and registering EVM/SVM handlers would let
 * the paywall render a payment UI for a chain we cannot settle.
 */
let paywallProvider: ReturnType<ReturnType<typeof createPaywall>["build"]> | undefined;
function browserPaywall(): NonNullable<Parameters<typeof paymentMiddleware>[3]> {
  paywallProvider ??= createPaywall().withNetwork(avmPaywall).withConfig(PAYWALL_CONFIG).build();
  return paywallProvider as NonNullable<Parameters<typeof paymentMiddleware>[3]>;
}

/**
 * Builds the payment middleware, one instance per distinct price.
 *
 * A single {@link RoutesConfig} carries a single price, and `paymentMiddleware` closes over it
 * at construction. So per-model pricing cannot be done by mutating the shared routes object
 * before each request: the middleware awaits the facilitator between reading the price and
 * issuing the challenge, so two concurrent requests for differently-priced models would
 * interleave and one client would be quoted the other's price. On a payment path that is a
 * money bug, not a cosmetic one.
 *
 * Instead each price gets its own immutable middleware, and the dispatcher below picks one by
 * the model in the request body. Nothing is shared and nothing is mutated, so concurrency is
 * a non-issue by construction.
 *
 * When no per-model prices are configured there is exactly one tier, and this returns that
 * middleware directly — behaviourally identical to the flat-price gateway it replaces.
 */
function priceTierDispatch(deps: GatewayDeps, logger: Logger): express.RequestHandler {
  const config = deps.config;
  const resourceServer = deps.resourceServer as x402ResourceServer;
  const sync = deps.syncFacilitatorOnStart ?? true;

  const build = (priceUsdc: string): express.RequestHandler =>
    paymentMiddleware(
      buildRoutesConfig(config, priceUsdc),
      resourceServer,
      PAYWALL_CONFIG,
      // Browser-facing payment UI. `paymentMiddleware` only reaches for this when the
      // request advertises `Accept: text/html`; an agent sending `application/json` still
      // gets the machine-readable 402 with the `payment-required` header, untouched. So
      // this adds a human path without altering the protocol path at all.
      browserPaywall(),
      sync,
    );

  const tiers = priceTiers(config.modelPricesUsdc, config.inboundPriceUsdc);
  const fallback = build(config.inboundPriceUsdc);
  if (tiers.length === 1) return fallback;

  const byPrice = new Map(tiers.map((price) => [price, build(price)]));
  logger.info(
    { tiers: tiers.length, models: Object.keys(config.modelPricesUsdc).length },
    "per-model pricing enabled",
  );

  return (req, res, next) => {
    const body: unknown = req.body;
    const model =
      typeof body === "object" && body !== null && "model" in body
        ? (body as { model?: unknown }).model
        : undefined;
    const price = resolveModelPrice(
      config.modelPricesUsdc,
      config.inboundPriceUsdc,
      typeof model === "string" ? model : undefined,
    );
    (byPrice.get(price) ?? fallback)(req, res, next);
  };
}

/** A chain reader that reports nothing as opted in. */
const NO_CHAIN: ChainReaderPort = {
  isOptedIn: () => Promise.resolve(false),
  getAlgoBalanceMicro: () => Promise.resolve(0n),
};

/**
 * Builds the configured Express app.
 *
 * @param deps - Injected collaborators. See {@link GatewayDeps}.
 * @returns An app ready to `listen`, or to hand to supertest.
 */
export function createApp(deps: GatewayDeps): Express {
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? Date.now;
  const config = deps.config;

  const app = express();
  // How many reverse-proxy hops to trust when resolving `req.ip`.
  //
  // This was hardcoded to 1, which is only correct when the gateway genuinely sits behind
  // exactly one proxy. On a directly exposed gateway it means any client can set
  // `X-Forwarded-For` to a random value per request, get a fresh rate-limit bucket every
  // time, and bypass the limiter entirely — demonstrated against this very middleware.
  //
  // Zero (the default) trusts nothing and uses the real socket peer, which is always safe.
  // Operators behind N proxies set MESH_TRUST_PROXY_HOPS=N; getting that number right is a
  // deployment fact we cannot infer, and guessing it wrong fails open.
  app.set("trust proxy", config.trustProxyHops);
  app.disable("x-powered-by");

  app.use(express.json({ limit: MAX_BODY_SIZE }));
  app.use(requestId());

  // Free surface. Mounted before the paywall so no configuration mistake can start charging
  // for discovery or for a health check.
  app.use(createLandingRouter({ config }));
  app.use(createChatUiRouter({ config }));
  app.use(createQuickstartRouter({ config, store: deps.store }));
  app.use(createHealthRouter(buildHealthDeps(deps, logger, now)));
  app.use(
    createDiscoveryRouter({ config, logger, ...(deps.specDir ? { specDir: deps.specDir } : {}) }),
  );
  app.use(
    createNodeRouter({
      config,
      store: deps.store,
      chain: deps.chain ?? NO_CHAIN,
      logger,
      now,
    }),
  );

  // Both paid paths get the same rate limiting; the payment middleware self-filters on both.
  const paidPath = [...PAID_ROUTE_PATHS];

  app.use(
    paidPath,
    rateLimit({
      capacity: deps.rateLimitCapacity ?? DEFAULT_RATE_LIMIT_CAPACITY,
      refillPerSecond: deps.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT_PER_SECOND,
      now,
    }),
  );

  if (deps.resourceServer !== undefined) {
    attachSettlementHook(deps.resourceServer, deps.settlement, logger);
    // Deliberately mounted with no path prefix. `paymentMiddleware` matches the route key
    // `POST /v1/chat/completions` against the request path itself, and Express strips a mount
    // path from `req.url` — mounting this at `paidPath` would leave the middleware looking at
    // `/` and silently guarding nothing.
    app.use(priceTierDispatch(deps, logger));
  } else {
    logger.warn({}, "no x402 resource server supplied: the paid route is UNGUARDED");
  }

  app.use(
    createChatRouter({
      config,
      router: deps.router ?? defaultRouter(deps, logger),
      settlement: deps.settlement,
      logger,
    }),
  );

  app.use(errorHandler(logger));
  return app;
}

/** Builds the default HTTP node router when the caller did not supply one. */
function defaultRouter(deps: GatewayDeps, logger: Logger): RouterPort {
  return new HttpNodeRouter({
    config: deps.config,
    selector: deps.selector,
    logger,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
}

function buildHealthDeps(
  deps: GatewayDeps,
  logger: Logger,
  now: Clock,
): Parameters<typeof createHealthRouter>[0] {
  return {
    config: deps.config,
    store: deps.store,
    settlement: deps.settlement,
    logger,
    startedAt: now(),
    ...(deps.probeFacilitator ? { probeFacilitator: deps.probeFacilitator } : {}),
    ...(deps.probeWallet ? { probeWallet: deps.probeWallet } : {}),
  };
}

/**
 * Bridges the x402 inbound settlement to the operator payout.
 *
 * This hook is the join between the two legs. It fires once the facilitator has *confirmed*
 * the client's payment — never merely on verification — so the gateway only ever pays a node
 * out of money it has actually received.
 *
 * The correlation trick worth knowing about: the Express payment middleware hands the
 * response headers set by the route handler into the settlement context. `x-request-id` and
 * `x-mesh-node-id` are therefore readable here, which is how the payout learns which
 * operator earned this particular payment without any shared mutable request state.
 *
 * The hook must not throw — a throw here would surface to the client as a settlement failure
 * on a payment that in fact succeeded.
 */
export function attachSettlementHook(
  resourceServer: x402ResourceServer,
  settlement: SettlementServicePort,
  logger: Logger,
): void {
  // WHY THERE IS NO "paid but not served" GUARD HERE.
  //
  // The obvious worry is that the gateway takes payment and then fails to route, leaving a payer
  // charged for nothing — an inbound settlement is an on-chain transfer, so there is no refund
  // path and it could only be prevented, never corrected.
  //
  // `@x402/express` already prevents it. The middleware buffers the response, runs the handler,
  // waits for the response to end, and then:
  //
  //     if (res.statusCode >= 400) { await cancellationDispatcher.cancel(...); return; }
  //     ...
  //     const settleResult = await httpServer.processSettlement(...)
  //
  // `processSettlement` has exactly one call site and it sits below that guard, so a `503
  // no_capacity` from the router cancels the payment rather than settling it. A handler that
  // throws is cancelled too, under `reason: "handler_threw"`.
  //
  // This was investigated after being wrongly filed as a live bug. It is recorded here rather
  // than in a test because pinning it needs a valid AVM payment payload — a real signed Algorand
  // transaction group matching the declared requirement — which cannot be stubbed cheaply. So the
  // guarantee comes from a DEPENDENCY and is not covered by our suite: if `@x402/express` ever
  // moves settlement above that status check, nothing here will fail. Re-read the middleware on
  // any major upgrade of it.
  resourceServer.onAfterSettle(async (context) => {
    try {
      const headers = responseHeadersOf(context.transportContext);
      const id = headers[REQUEST_ID_HEADER];
      if (id === undefined || id.length === 0) {
        logger.error(
          { nodeId: headers[NODE_ID_HEADER] ?? null },
          "settled payment carried no request id; operator payout skipped",
        );
        return;
      }

      const result = context.result;

      // `onAfterSettle` fires for BOTH outcomes. The facilitator answers HTTP 200 with
      // `success: false` when the atomic group failed on-chain (confirmation timeout, an
      // underflowed asset balance, a rejected transfer), so "after settle" does NOT mean
      // "settled". Paying the operator on that path sends 1700 atomic USDC out of the
      // gateway's own float against money that never arrived — an unbounded drain, one
      // payout per failed settlement, and trivially forced by a payer who lets their
      // payment fail. Gate on the outcome, not on the hook firing.
      if (result.success !== true) {
        logger.error(
          {
            requestId: id,
            nodeId: headers[NODE_ID_HEADER] ?? null,
            errorReason: result.errorReason ?? null,
            errorMessage: result.errorMessage ?? null,
          },
          "facilitator reported settlement failure; operator payout skipped",
        );
        return;
      }

      // A genuinely settled payment carries the on-chain transaction id. An empty one means
      // we cannot evidence that the inbound leg landed, so there is nothing to pay out
      // against and the ledger row would claim a settlement it cannot prove.
      if (typeof result.transaction !== "string" || result.transaction.length === 0) {
        logger.error(
          { requestId: id, nodeId: headers[NODE_ID_HEADER] ?? null },
          "settlement reported success without a transaction id; operator payout skipped",
        );
        return;
      }

      const amount = result.amount ?? context.requirements.amount;
      if (typeof amount !== "string") {
        throw new SettlementError("settlement reported no amount", { requestId: id });
      }

      settlement.settleInbound({
        requestId: id,
        payerAddress: result.payer ?? "",
        inboundTxId: result.transaction,
        inboundAtomic: parseInboundAmount(amount, id),
      });
    } catch (error) {
      // Swallowed on purpose: the inbound leg already succeeded and the client must see it
      // that way. The ledger and this line are the record that the payout did not start.
      logger.error(
        { reason: error instanceof Error ? error.message : String(error) },
        "failed to schedule operator payout after settlement",
      );
    }
    return Promise.resolve();
  });
}

/** Narrows the SDK's `unknown` transport context to the response headers we set. */
function responseHeadersOf(transportContext: unknown): Record<string, string> {
  if (typeof transportContext !== "object" || transportContext === null) return {};
  const headers = (transportContext as { responseHeaders?: unknown }).responseHeaders;
  if (typeof headers !== "object" || headers === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
  }
  return out;
}
