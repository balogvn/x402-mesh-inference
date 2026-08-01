import { MeshError, loadDaemonConfig, toMeshNetwork, usdcAssetId } from "@x402-mesh/shared";
import type { DaemonConfig } from "@x402-mesh/shared";
import { AlgodReader } from "./algod.js";
import type { AlgodReaderOptions } from "./algod.js";
import {
  DEFAULT_CONTROL_TIMEOUT_MS,
  baseHeaders,
  joinUrl,
  scopedSignal,
  transportError,
} from "./http.js";
import type { FetchLike } from "./http.js";
import { loadOperatorKey } from "./keys.js";
import type { OperatorKey } from "./keys.js";
import { createProvider } from "./providers/index.js";
import type { InferenceProvider } from "./providers/index.js";

/**
 * Pre-flight diagnostics.
 *
 * Every check here corresponds to a failure that is otherwise invisible until the first paid
 * request: an unreachable backend, a model the operator advertised but never pulled, a key
 * that derives an address nobody funded, an account that cannot receive USDC because it never
 * opted in. Each one is reported independently — a failing chain check must not hide a
 * failing provider check — and the command's exit code is the conjunction.
 */

/** Outcome of a single diagnostic. */
export type CheckStatus = "pass" | "fail" | "warn" | "skip";

/** One line of the `doctor` checklist. */
export interface CheckResult {
  /** Short check name, e.g. `"provider reachable"`. */
  name: string;
  status: CheckStatus;
  /** One-line explanation, always safe to print (never contains key material). */
  detail: string;
}

/** Full `doctor` report. */
export interface DoctorReport {
  checks: CheckResult[];
  /** True when no check failed. Warnings do not fail the report. */
  ok: boolean;
}

/** Overrides for {@link runDoctor}; every one exists so the checks can be unit tested. */
export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Pre-built provider; defaults to one derived from the loaded configuration. */
  provider?: InferenceProvider;
  /** Algod overrides (base URL, token). */
  algod?: AlgodReaderOptions;
  /** Skips every network-touching check. Used to diagnose configuration alone. */
  offline?: boolean;
  /**
   * Bearer token for the inference backend, from `MESH_PROVIDER_API_KEY`.
   *
   * Without this, `doctor` probes an authenticated backend anonymously and reports it
   * unreachable — while `start`, which does send the token, works fine. Since `doctor` is the
   * command an operator runs *first*, that sends them chasing a problem that does not exist.
   */
  providerApiKey?: string;
}

/** Base Algorand minimum balance requirement, in microALGO. */
const BASE_MBR_MICRO_ALGOS = 100_000n;

/** Additional minimum balance requirement per opted-in ASA, in microALGO. */
const PER_ASSET_MBR_MICRO_ALGOS = 100_000n;

/**
 * Runs every diagnostic and returns the checklist.
 *
 * Never throws: a failure to even load the configuration is itself reported as a failed
 * check, because a `doctor` that crashes tells an operator less than one that says which
 * variable is wrong.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  let config: DaemonConfig;
  try {
    config = loadDaemonConfig(options.env ?? process.env);
    checks.push({
      name: "configuration",
      status: "pass",
      detail: `node ${config.nodeId} -> gateway ${config.gatewayUrl} on ${toMeshNetwork(config.network)}`,
    });
  } catch (cause) {
    checks.push({
      name: "configuration",
      status: "fail",
      detail: describe(cause),
    });
    // Nothing downstream can run without configuration.
    return finish(checks);
  }

  let key: OperatorKey | null = null;
  try {
    key = loadOperatorKey(config.privateKeyB64);
    checks.push({
      name: "operator key",
      status: "pass",
      detail: `valid Ed25519 key; address ${key.address}`,
    });
  } catch (cause) {
    checks.push({ name: "operator key", status: "fail", detail: describe(cause) });
  }

  if (options.offline === true) {
    for (const name of [
      "provider reachable",
      "models present",
      "gateway reachable",
      "account funded",
      "USDC opt-in",
    ]) {
      checks.push({ name, status: "skip", detail: "skipped (offline)" });
    }
    return finish(checks);
  }

  const providerOverrides: { fetchImpl?: FetchLike; apiKey?: string } = {};
  if (options.fetchImpl !== undefined) providerOverrides.fetchImpl = options.fetchImpl;
  // Must match what `start` sends, or doctor diagnoses a different system than the one that
  // will actually run.
  if (options.providerApiKey !== undefined && options.providerApiKey.length > 0) {
    providerOverrides.apiKey = options.providerApiKey;
  }
  const provider = options.provider ?? createProvider(config, providerOverrides);

  let available: string[] | null = null;
  try {
    available = await provider.listModels();
    checks.push({
      name: "provider reachable",
      status: "pass",
      detail: `${provider.name} at ${provider.baseUrl} listed ${available.length} model(s)`,
    });
  } catch (cause) {
    checks.push({
      name: "provider reachable",
      status: "fail",
      detail: `${provider.name} at ${provider.baseUrl}: ${describe(cause)}`,
    });
  }

  checks.push(modelsCheck(config, available));
  checks.push(await gatewayCheck(config, options.fetchImpl));

  if (key === null) {
    for (const name of ["account funded", "USDC opt-in"]) {
      checks.push({ name, status: "skip", detail: "skipped (no valid operator key)" });
    }
    return finish(checks);
  }

  const algodOptions: AlgodReaderOptions = { ...options.algod };
  if (algodOptions.fetchImpl === undefined && options.fetchImpl !== undefined) {
    algodOptions.fetchImpl = options.fetchImpl;
  }
  const algod = new AlgodReader(config.network, algodOptions);
  const assetId = usdcAssetId(config.network);

  const funded = await fundingCheck(algod, key.address);
  checks.push(funded);
  checks.push(await optInCheck(algod, key.address, assetId));

  return finish(checks);
}

/** Every configured model must actually exist on the backend, or routing will 404 at run time. */
function modelsCheck(config: DaemonConfig, available: string[] | null): CheckResult {
  if (available === null) {
    return { name: "models present", status: "skip", detail: "skipped (provider unreachable)" };
  }
  const have = new Set(available);
  const missing = config.models.filter((model) => !have.has(model));
  if (missing.length === 0) {
    return {
      name: "models present",
      status: "pass",
      detail: `all ${config.models.length} advertised model(s) available: ${config.models.join(", ")}`,
    };
  }
  return {
    name: "models present",
    status: "fail",
    detail: `not available on the backend: ${missing.join(", ")}`,
  };
}

/**
 * Confirms the gateway answers at all.
 *
 * Any HTTP status counts as reachable — the daemon does not own the gateway's routes, and a
 * 404 on `/health` still proves the process is up and the URL is right. Only a transport
 * failure is a real problem here.
 */
async function gatewayCheck(config: DaemonConfig, fetchImpl?: FetchLike): Promise<CheckResult> {
  const doFetch = fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const url = joinUrl(config.gatewayUrl, "/health");
  const scope = scopedSignal(DEFAULT_CONTROL_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: baseHeaders({ accept: "application/json" }),
      signal: scope.signal,
    });
    await res.text().catch(() => "");
    return {
      name: "gateway reachable",
      status: res.ok ? "pass" : "warn",
      detail: `${config.gatewayUrl} answered HTTP ${res.status}`,
    };
  } catch (cause) {
    return {
      name: "gateway reachable",
      status: "fail",
      detail: describe(transportError("gateway", "health probe", cause)),
    };
  } finally {
    scope.dispose();
  }
}

/**
 * Checks the operator account exists and holds enough ALGO for its minimum balance plus one
 * more ASA opt-in.
 */
async function fundingCheck(algod: AlgodReader, address: string): Promise<CheckResult> {
  try {
    const summary = await algod.accountSummary(address);
    if (!summary.exists) {
      return {
        name: "account funded",
        status: "fail",
        detail: `${address} does not exist on chain — fund it with at least 0.2 ALGO`,
      };
    }
    // Headroom for one more opt-in, so an operator who has not opted in yet is told now
    // rather than after the opt-in transaction fails.
    const required = summary.minBalanceMicroAlgos + PER_ASSET_MBR_MICRO_ALGOS;
    const algos = microAlgosToAlgos(summary.microAlgos);
    if (summary.microAlgos < required) {
      return {
        name: "account funded",
        status: "fail",
        detail: `${algos} ALGO is below the ${microAlgosToAlgos(required)} ALGO needed (base ${microAlgosToAlgos(BASE_MBR_MICRO_ALGOS)} + 0.1 per ASA)`,
      };
    }
    return {
      name: "account funded",
      status: "pass",
      detail: `${algos} ALGO available, min balance ${microAlgosToAlgos(summary.minBalanceMicroAlgos)} ALGO`,
    };
  } catch (cause) {
    return { name: "account funded", status: "fail", detail: describe(cause) };
  }
}

async function optInCheck(
  algod: AlgodReader,
  address: string,
  assetId: string,
): Promise<CheckResult> {
  try {
    const optedIn = await algod.isOptedIn(address, assetId);
    return optedIn
      ? { name: "USDC opt-in", status: "pass", detail: `opted in to USDC (ASA ${assetId})` }
      : {
          name: "USDC opt-in",
          status: "fail",
          detail: `not opted in to USDC (ASA ${assetId}) — payouts will fail until you opt in`,
        };
  } catch (cause) {
    return { name: "USDC opt-in", status: "fail", detail: describe(cause) };
  }
}

/** Renders microALGO as a decimal ALGO string using integer arithmetic only. */
function microAlgosToAlgos(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const fraction = (micro % 1_000_000n).toString(10).padStart(6, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString(10) : `${whole.toString(10)}.${fraction}`;
}

function finish(checks: CheckResult[]): DoctorReport {
  return { checks, ok: checks.every((check) => check.status !== "fail") };
}

/** Turns any throwable into a single safe line. Mesh errors already redact their details. */
function describe(cause: unknown): string {
  if (cause instanceof MeshError) return `${cause.code}: ${cause.message}`;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Formats a report as a fixed-width pass/fail checklist.
 *
 * @param report - Result of {@link runDoctor}.
 */
export function formatReport(report: DoctorReport): string {
  const width = report.checks.reduce((max, check) => Math.max(max, check.name.length), 0);
  const lines = report.checks.map((check) => {
    const label = check.status.toUpperCase().padEnd(4);
    return `[${label}] ${check.name.padEnd(width)}  ${check.detail}`;
  });
  const failures = report.checks.filter((c) => c.status === "fail").length;
  lines.push("");
  lines.push(
    report.ok
      ? "doctor: all checks passed — this node is ready to register."
      : `doctor: ${failures} check(s) failed — fix the FAIL lines above before registering.`,
  );
  return lines.join("\n");
}
