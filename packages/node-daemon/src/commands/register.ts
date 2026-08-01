import { loadDaemonConfig } from "@x402-mesh/shared";
import type { DaemonConfig } from "@x402-mesh/shared";
import type { CapabilityOverrides, RegisterNodeResult } from "../registration.js";
import { registerNode } from "../registration.js";
import { loadOperatorKey } from "../keys.js";
import type { OperatorKey } from "../keys.js";

/** Options for {@link registerCommand}. */
export interface RegisterCommandOptions extends CapabilityOverrides {
  env?: NodeJS.ProcessEnv;
  /** Total attempts, including the first. */
  maxAttempts?: number;
  /** Where to write progress. Defaults to `console.log`. */
  write?: (line: string) => void;
}

/** What {@link registerCommand} returns, so `start` can reuse it without re-parsing config. */
export interface RegisterCommandResult {
  config: DaemonConfig;
  key: OperatorKey;
  result: RegisterNodeResult;
}

/**
 * One-shot registration.
 *
 * Registers the node and exits; it does not start the heartbeat, so a node registered this
 * way will be aged out by the gateway once its heartbeats stop arriving. Use it to verify
 * that a freshly configured operator key and endpoint are accepted.
 *
 * @throws {UpstreamError} if the gateway rejects the registration or is unreachable.
 */
export async function registerCommand(
  options: RegisterCommandOptions = {},
): Promise<RegisterCommandResult> {
  const write = options.write ?? ((line: string) => console.log(line));
  const config = loadDaemonConfig(options.env ?? process.env);
  const key = loadOperatorKey(config.privateKeyB64);

  write(`registering ${config.nodeId} (${key.address}) with ${config.gatewayUrl}`);
  write(`  endpoint: ${config.endpoint}`);
  write(`  models:   ${config.models.join(", ")}`);

  const registerOptions: Parameters<typeof registerNode>[2] = {
    onAttempt: (attempt, max) => {
      if (attempt > 1) write(`  attempt ${attempt}/${max}`);
    },
  };
  if (options.maxAttempts !== undefined) registerOptions.maxAttempts = options.maxAttempts;
  if (options.contextWindow !== undefined) registerOptions.contextWindow = options.contextWindow;
  if (options.pricePer1kTokensUsdc !== undefined) {
    registerOptions.pricePer1kTokensUsdc = options.pricePer1kTokensUsdc;
  }
  if (options.quantization !== undefined) registerOptions.quantization = options.quantization;

  const result = await registerNode(config, key, registerOptions);
  write(`registered: gateway answered HTTP ${result.status} after ${result.attempts} attempt(s)`);
  return { config, key, result };
}
