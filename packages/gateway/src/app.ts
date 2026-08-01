import type { GatewayConfig } from "@x402-mesh/shared";
import { SettlementError } from "@x402-mesh/shared";
import type { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
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
import { createHealthRouter } from "./routes/health.js";
import { createNodeRouter } from "./routes/nodes.js";
import { HttpNodeRouter } from "./services/router.js";
import { parseInboundAmount } from "./services/settlement.js";
import { buildRoutesConfig } from "./x402/routes.js";

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
  // Trust the proxy hop count from the environment rather than blanket-trusting every
  // forwarded header: `trust proxy: true` would let any client spoof `req.ip` and so pick
  // its own rate-limit bucket.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(express.json({ limit: MAX_BODY_SIZE }));
  app.use(requestId());

  // Free surface. Mounted before the paywall so no configuration mistake can start charging
  // for discovery or for a health check.
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

  const routes = buildRoutesConfig(config);
  const paidPath = "/v1/chat/completions";

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
    app.use(
      paymentMiddleware(
        routes,
        deps.resourceServer,
        undefined,
        undefined,
        deps.syncFacilitatorOnStart ?? true,
      ),
    );
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
