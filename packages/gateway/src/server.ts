import type { Server } from "node:http";
import type { GatewayConfig } from "@x402-mesh/shared";
import { loadGatewayConfig, toErrorResponse } from "@x402-mesh/shared";
import { createAccrualStore, createNodeStore, NodeSelector } from "@x402-mesh/registry";
import { createApp } from "./app.js";
import type { GatewayDeps } from "./app.js";
import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import type { ChainReaderPort, UsdcPayoutPort } from "./ports.js";
import { MIN_WALLET_MICRO_ALGOS } from "./routes/health.js";
import {
  AlgokitChainReader,
  AlgokitUsdcPayer,
  attachGatewayWallet,
  createAlgorandClient,
  readAlgodOverrides,
} from "./services/algorand.js";
import { RegistrySelectorAdapter, RegistryStoreAdapter } from "./services/registryAdapter.js";
import { DoubleSettlementService } from "./services/settlement.js";
import { initTelemetry } from "./telemetry/otel.js";
import { buildResourceServer } from "./x402/server.js";

/**
 * Executable entrypoint.
 *
 * Nothing here is importable by tests on purpose: this file's whole job is to turn
 * environment variables into real collaborators — an algod connection, a funded wallet, a
 * facilitator client — and hand them to `createApp`. Keeping that separation is what lets
 * the application be exercised without any of them.
 */

/**
 * Grace period for in-flight requests and the accrued-payout flush during shutdown.
 *
 * Must comfortably exceed the payout retry span (~21s, see DEFAULT_RETRY_POLICY), because
 * shutdown now pays out accrued balances and cutting that off mid-retry-chain is how a
 * routine deploy turns into an operator not being paid. `kill_timeout` in fly.toml must be
 * at least this long or the platform SIGKILLs before the flush finishes — Fly's default is
 * 5 seconds, which is far too short.
 */
const SHUTDOWN_GRACE_MS = 30_000;

/**
 * Builds production dependencies from configuration and the environment.
 *
 * The payout wallet is optional so the gateway can be brought up in a read-only,
 * routing-only mode (useful for a first deploy, or a replica dedicated to discovery). When
 * `AVM_PRIVATE_KEY` is absent the gateway still routes and still takes payment, but it
 * cannot pay operators — which is loud in the logs and visible in `/readyz`.
 */
async function buildDeps(
  config: GatewayConfig,
  logger: Logger,
  env: NodeJS.ProcessEnv,
): Promise<GatewayDeps> {
  // Redis when configured and reachable, in-process memory otherwise. `createNodeStore`
  // degrades rather than throwing, so a cache outage costs routing quality across replicas,
  // not availability.
  const nodeStore = await createNodeStore(config.redisUrl);
  const store = new RegistryStoreAdapter(nodeStore);
  const selector = new RegistrySelectorAdapter(new NodeSelector(nodeStore), nodeStore);

  const algorand = createAlgorandClient(config, readAlgodOverrides(env));
  const chain: ChainReaderPort = new AlgokitChainReader(algorand);

  const privateKey = env["AVM_PRIVATE_KEY"]?.trim();
  let payer: UsdcPayoutPort;
  let walletAddress: string | undefined;
  if (privateKey === undefined || privateKey.length === 0) {
    logger.warn(
      {},
      "AVM_PRIVATE_KEY is not set: operator payouts are disabled and will be recorded as failed",
    );
    payer = disabledPayer();
  } else {
    const wallet = attachGatewayWallet(privateKey, algorand);
    walletAddress = wallet.address;
    payer = new AlgokitUsdcPayer(wallet.address, algorand);
    logger.info({ payoutAddress: wallet.address }, "payout wallet ready");
  }

  // Durable accrual storage, so a crash cannot lose the record of what the gateway owes.
  // Absent when REDIS_URL is unset or unreachable; the settlement service says so loudly.
  const accrualStore = await createAccrualStore(config.redisUrl, { logger: console });
  const settlement = new DoubleSettlementService({
    config,
    payer,
    logger,
    ...(accrualStore !== undefined ? { accrualStore } : {}),
  });
  // Before the listener opens: money owed by a previous process is paid first, and doing it
  // here means the ledger already reflects it by the time anyone can query /v1/settlements.
  await settlement.recoverAccruals();
  const resourceServer = buildResourceServer(config);

  const deps: GatewayDeps = {
    config,
    store,
    selector,
    settlement,
    resourceServer,
    chain,
    logger,
  };

  if (walletAddress !== undefined) {
    deps.probeWallet = async () => {
      const balance = await chain.getAlgoBalanceMicro(walletAddress);
      return balance >= MIN_WALLET_MICRO_ALGOS
        ? { ok: true, detail: `${balance} microAlgo` }
        : {
            ok: false,
            detail: `payout wallet holds ${balance} microAlgo, below the ${MIN_WALLET_MICRO_ALGOS} minimum`,
          };
    };
  }

  return deps;
}

/**
 * A payer that always fails, used when no wallet is configured.
 *
 * Failing loudly beats silently skipping: the settlement ledger records `failed` with an
 * actionable reason, so the missing key is visible in `/v1/settlements` rather than only in
 * a startup log line nobody re-reads.
 */
function disabledPayer(): UsdcPayoutPort {
  return {
    senderAddress: "",
    pay: () =>
      Promise.reject(
        new Error("payouts are disabled: AVM_PRIVATE_KEY is not configured on this gateway"),
      ),
  };
}

/** Boots the gateway: config, telemetry, dependencies, listener, signal handling. */
async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const logger = createLogger(config.logLevel);
  const telemetry = await initTelemetry(config, logger);

  // Kept in scope rather than inlined: the shutdown handler needs the settlement service to
  // flush accrued payouts before the process exits.
  const deps = await buildDeps(config, logger, process.env);
  const app = createApp(deps);

  const server: Server = app.listen(config.port, config.host, () => {
    logger.info(
      {
        host: config.host,
        port: config.port,
        network: config.network,
        facilitator: config.facilitatorUrl,
        price: config.inboundPriceUsdc,
        marginBps: config.marginBps,
        publicBaseUrl: config.publicBaseUrl,
      },
      "gateway listening",
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const force = setTimeout(() => {
      logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, "grace period elapsed; forcing exit");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    server.close(() => {
      // Pay out everything accrued BEFORE exiting. With batching enabled the gateway is
      // holding USDC it already owes operators, and the record of who is owed what lives in
      // memory — so exiting without this turns every routine deploy into an operator not
      // being paid. Bounded by the same grace timer as the rest of shutdown.
      void deps.settlement
        .flushPayouts()
        .catch((error: unknown) => {
          logger.error(
            { alert: "shutdown_flush_failed", reason: String(error) },
            "OPERATOR ALERT: accrued payouts could not be flushed before shutdown",
          );
        })
        .finally(() => {
          void telemetry.shutdown().finally(() => {
            clearTimeout(force);
            process.exit(0);
          });
        });
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  // Startup failures are almost always configuration; `toErrorResponse` gives the same
  // sanitized shape the HTTP layer would, so no secret reaches the console.
  const { body } = toErrorResponse(error);
  console.error(JSON.stringify(body));
  process.exit(1);
});
