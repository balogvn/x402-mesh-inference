import type { GatewayConfig } from "@x402-mesh/shared";
import { atomicToUsdc, computeSplit, usdcAssetId, usdcToAtomic } from "@x402-mesh/shared";
import { Router } from "express";
import type { Response } from "express";
import type { Logger } from "../logger.js";
import type { NodeStorePort, SettlementServicePort } from "../ports.js";

/**
 * Operational endpoints: `/healthz`, `/readyz` and `/v1/settlements`.
 *
 * The liveness/readiness split matters in an orchestrator. `/healthz` answers "is this
 * process alive" and must never depend on anything external, or a facilitator outage would
 * make Kubernetes restart-loop a perfectly healthy gateway. `/readyz` answers "should this
 * replica receive traffic" and *does* check dependencies, so a replica with an unfunded
 * wallet or an unreachable facilitator is pulled from the load balancer instead of taking
 * payments it cannot settle.
 */

/** Minimum ALGO (in microAlgos) the gateway wallet should hold to keep paying out. */
export const MIN_WALLET_MICRO_ALGOS = 200_000n;

/** How long a `/readyz` dependency probe may take before it counts as failed. */
const PROBE_TIMEOUT_MS = 3_000;

/** One dependency's contribution to readiness. */
interface CheckResult {
  ok: boolean;
  detail?: string;
}

/** Collaborators the health routes need. */
export interface HealthRouteDeps {
  config: GatewayConfig;
  store: NodeStorePort;
  settlement: SettlementServicePort;
  logger: Logger;
  /** Process start time, used for the uptime field. */
  startedAt?: number;
  /** Facilitator reachability probe. Injected so tests make no network call. */
  probeFacilitator?: () => Promise<CheckResult>;
  /** Gateway wallet funding probe. Undefined when the gateway runs without a wallet. */
  probeWallet?: () => Promise<CheckResult>;
}

/** Builds the operational router. */
export function createHealthRouter(deps: HealthRouteDeps): Router {
  const startedAt = deps.startedAt ?? Date.now();
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "x402-mesh-gateway",
      version: "0.1.0",
      network: deps.config.network,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  router.get("/readyz", (_req, res, next) => {
    handleReady(deps, res).catch(next);
  });

  router.get("/v1/settlements", (req, res) => {
    const limit = parseLimit(req.query["limit"]);
    const ledger = deps.settlement.getSettlementLedger();
    const entries = ledger.slice(0, limit);
    res.status(200).json({
      count: entries.length,
      total: ledger.length,
      economics: economics(deps.config),
      settlements: entries,
    });
  });

  return router;
}

async function handleReady(deps: HealthRouteDeps, res: Response): Promise<void> {
  const [facilitator, store, wallet] = await Promise.all([
    runCheck(deps.probeFacilitator ?? (() => defaultFacilitatorProbe(deps.config))),
    runCheck(async () => {
      const nodes = await deps.store.list();
      const routable = nodes.filter(
        (n) => n.health.healthy && (n.usdcOptedIn || !deps.config.requireUsdcOptIn),
      );
      return {
        ok: true,
        detail: `${routable.length}/${nodes.length} nodes routable`,
      };
    }),
    deps.probeWallet === undefined
      ? Promise.resolve<CheckResult>({ ok: true, detail: "no payout wallet configured" })
      : runCheck(deps.probeWallet),
  ]);

  const ready = facilitator.ok && store.ok && wallet.ok;
  if (!ready) {
    deps.logger.warn(
      { facilitator: facilitator.detail, store: store.detail, wallet: wallet.detail },
      "readiness check failed",
    );
  }

  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    checks: { facilitator, store, wallet },
    network: deps.config.network,
    asset: usdcAssetId(deps.config.network),
  });
}

/** Runs a probe, converting a throw or a hang into a failed check rather than a 500. */
async function runCheck(probe: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await probe();
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Default facilitator probe: `GET /supported` must answer 200.
 *
 * That endpoint is the one the resource server itself calls on first paid request, so it is
 * exactly the dependency worth checking — a reachable host that cannot answer `/supported`
 * is not a usable facilitator.
 */
export async function defaultFacilitatorProbe(config: GatewayConfig): Promise<CheckResult> {
  const url = `${config.facilitatorUrl}/supported`;
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok
      ? { ok: true, detail: `${config.facilitatorUrl} responded ${response.status}` }
      : { ok: false, detail: `${config.facilitatorUrl} responded ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      detail: `${config.facilitatorUrl} unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Publishes the economics the gateway is actually running, computed the same way settlement
 * computes them.
 *
 * Serving these from `computeSplit` rather than from a hand-written constant means the
 * documented split and the paid split cannot drift apart.
 */
export function economics(config: GatewayConfig): Record<string, unknown> {
  const inbound = usdcToAtomic(config.inboundPriceUsdc);
  const split = computeSplit(inbound, config.marginBps);
  return {
    inboundAtomic: split.inbound.toString(10),
    payoutAtomic: split.payout.toString(10),
    marginAtomic: split.margin.toString(10),
    inboundUsdc: atomicToUsdc(split.inbound),
    payoutUsdc: atomicToUsdc(split.payout),
    marginUsdc: atomicToUsdc(split.margin),
    marginBps: config.marginBps,
    invariant: "inbound - payout === margin",
  };
}

/** Clamps the `?limit=` query to a sane window; anything unparseable falls back to 100. */
function parseLimit(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 100;
  return Math.min(1_000, Math.max(1, Number(raw)));
}
