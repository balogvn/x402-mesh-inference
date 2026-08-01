import { loadDaemonConfig } from "@x402-mesh/shared";
import type { DaemonConfig } from "@x402-mesh/shared";
import { HeartbeatLoop } from "../heartbeat.js";
import { loadOperatorKey } from "../keys.js";
import { createLogger } from "../logger.js";
import type { Logger } from "../logger.js";
import { createProvider } from "../providers/index.js";
import type { CapabilityOverrides } from "../registration.js";
import { registerNode } from "../registration.js";
import { DEFAULT_NODE_PORT, NodeServer } from "../server.js";

/** Options for {@link startCommand}. */
export interface StartCommandOptions extends CapabilityOverrides {
  env?: NodeJS.ProcessEnv;
  /** Listen port. Defaults to the port in `MESH_NODE_ENDPOINT`, else 8403. */
  port?: number;
  /** Listen host. Defaults to `0.0.0.0`. */
  host?: string;
  /** Shared secret the gateway must present on `POST /infer`. Never logged. */
  authToken?: string;
  /** Bearer token for the inference backend, if it sits behind an auth proxy. Never logged. */
  providerApiKey?: string;
  /** Skip the initial registration (the node is already registered). */
  skipRegister?: boolean;
  /** Pino level name. */
  logLevel?: string;
}

/** Handle to a running daemon, so callers (and tests) can shut it down deterministically. */
export interface RunningDaemon {
  config: DaemonConfig;
  server: NodeServer;
  heartbeat: HeartbeatLoop;
  /** Bound listen port. */
  port: number;
  /** Stops the heartbeat, drains an in-flight beat and closes the listener. */
  stop: () => Promise<void>;
}

/**
 * Derives the listen port from the advertised endpoint.
 *
 * An operator sets `MESH_NODE_ENDPOINT` to the URL the gateway will call; binding the same
 * port by default removes the most common misconfiguration — advertising one port and
 * listening on another.
 */
export function portFromEndpoint(endpoint: string): number {
  try {
    const url = new URL(endpoint);
    if (url.port.length > 0) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return DEFAULT_NODE_PORT;
  }
}

/**
 * Registers, starts the heartbeat and serves inference.
 *
 * Ordering matters: the HTTP listener comes up *before* registration, so the node can already
 * answer the moment the gateway learns about it. If registration fails the listener is closed
 * again rather than left orphaned.
 *
 * The returned {@link RunningDaemon.stop} is what an operator's `SIGTERM` handler calls; it
 * clears the heartbeat timer, so nothing keeps the event loop alive after shutdown.
 */
export async function startCommand(options: StartCommandOptions = {}): Promise<RunningDaemon> {
  const config = loadDaemonConfig(options.env ?? process.env);
  const key = loadOperatorKey(config.privateKeyB64);
  const log: Logger = createLogger(options.logLevel ?? "info");

  const provider = createProvider(
    config,
    options.providerApiKey !== undefined ? { apiKey: options.providerApiKey } : {},
  );

  const serverOptions: ConstructorParameters<typeof NodeServer>[0] = {
    provider,
    maxConcurrency: config.maxConcurrency,
    nodeId: config.nodeId,
    models: config.models,
    port: options.port ?? portFromEndpoint(config.endpoint),
    host: options.host ?? "0.0.0.0",
    log: (event) => log.info(event),
  };
  if (options.authToken !== undefined) serverOptions.authToken = options.authToken;

  const server = new NodeServer(serverOptions);
  const port = await server.listen();
  log.info({ msg: "listening", port, host: serverOptions.host, provider: provider.name });

  const capabilityOverrides: CapabilityOverrides = {};
  if (options.contextWindow !== undefined)
    capabilityOverrides.contextWindow = options.contextWindow;
  if (options.pricePer1kTokensUsdc !== undefined) {
    capabilityOverrides.pricePer1kTokensUsdc = options.pricePer1kTokensUsdc;
  }
  if (options.quantization !== undefined) capabilityOverrides.quantization = options.quantization;

  const doRegister = async (): Promise<void> => {
    const result = await registerNode(config, key, capabilityOverrides);
    log.info({
      msg: "registered with gateway",
      nodeId: config.nodeId,
      operatorAddress: key.address,
      status: result.status,
      attempts: result.attempts,
    });
  };

  if (options.skipRegister !== true) {
    try {
      await doRegister();
    } catch (cause) {
      // A half-started daemon that is listening but unknown to the gateway is worse than no
      // daemon: it looks healthy locally while serving nothing.
      await server.close();
      throw cause;
    }
  }

  const heartbeat = new HeartbeatLoop({
    config,
    key,
    snapshot: async () => ({
      healthy: await server.healthy(),
      inFlight: server.load.inFlight,
    }),
    reregister: doRegister,
    onResult: (result) => {
      if (result.ok && !result.reregistered) {
        log.debug({ msg: "heartbeat ok", status: result.status });
        return;
      }
      if (result.reregistered) {
        log.warn({ msg: "gateway had forgotten this node; re-registered", status: result.status });
        return;
      }
      log.warn({
        msg: "heartbeat failed",
        status: result.status,
        reason: result.error?.message,
      });
    },
  });
  heartbeat.start();
  log.info({ msg: "heartbeat started", intervalMs: config.heartbeatIntervalMs });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    heartbeat.stop();
    await heartbeat.drain();
    await server.close();
    log.info({ msg: "stopped" });
  };

  return { config, server, heartbeat, port, stop };
}
