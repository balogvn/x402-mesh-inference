import { z } from "zod";
import type { Network } from "@x402/core/types";
import { ConfigError } from "./errors.js";
import type { MeshNetwork } from "./networks.js";
import { normalizeNetwork, toCaip2, toMeshNetwork } from "./networks.js";
import { DEFAULT_INBOUND_USDC, DEFAULT_MARGIN_BPS } from "./pricing.js";
import { AlgorandAddressSchema, UsdcAmountSchema } from "./schemas.js";

/**
 * Environment-driven configuration for the gateway and the node daemon.
 *
 * Every loader validates with zod and re-raises failures as {@link ConfigError} naming the
 * offending environment variables, so a misconfigured deployment fails at startup with an
 * actionable message instead of at the first payment. Raw zod errors never escape, and no
 * loader ever echoes a secret value.
 */

/** Mandatory hackathon discovery tag; goes into the x402 route's `tags`. */
export const CHALLENGE_TAG = "x402-global-challenge";

/** Default facilitator: GoPlausible's live Algorand facilitator (verified reachable). */
export const DEFAULT_FACILITATOR_URL = "https://facilitator.goplausible.xyz";

/** Default gateway listen port. */
export const DEFAULT_GATEWAY_PORT = 8402;

/** Default per-request timeout when proxying to a node, in milliseconds. */
export const DEFAULT_NODE_REQUEST_TIMEOUT_MS = 120_000;

/** Default cap on concurrent in-flight requests per node. */
export const DEFAULT_MAX_CONCURRENT_PER_NODE = 8;

/** Default node daemon heartbeat interval, in milliseconds. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/** Inference backends the node daemon can drive. */
export type DaemonProvider = "ollama" | "vllm" | "openai";

/** Conventional local base URL for each provider, used when none is configured. */
const PROVIDER_DEFAULT_BASE_URL: Record<DaemonProvider, string> = {
  ollama: "http://127.0.0.1:11434",
  vllm: "http://127.0.0.1:8000",
  openai: "https://api.openai.com",
};

/** Bytes in an Algorand secret key: 32-byte Ed25519 seed followed by the 32-byte public key. */
const ALGORAND_SECRET_KEY_BYTES = 64;

/** Missing and blank environment variables are treated identically: absent. */
function envValue(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringField(defaultValue: string, max = 512) {
  return z.preprocess((v) => envValue(v) ?? defaultValue, z.string().min(1).max(max));
}

function optionalStringField(max = 512) {
  return z.preprocess((v) => envValue(v), z.string().min(1).max(max).optional());
}

function urlField(defaultValue: string) {
  return z.preprocess((v) => envValue(v) ?? defaultValue, z.string().url().max(512));
}

function requiredUrlField() {
  return z.preprocess((v) => envValue(v), z.string().url().max(512));
}

function optionalUrlField() {
  return z.preprocess((v) => envValue(v), z.string().url().max(512).optional());
}

/**
 * Integer field. Only exact decimal integers are accepted — `"8.5"` or `"8abc"` become NaN
 * and fail validation rather than being silently truncated.
 */
function intField(defaultValue: number, min: number, max: number) {
  return z.preprocess((v) => {
    const raw = envValue(v);
    if (raw === undefined) return defaultValue;
    return /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  }, z.number().int().min(min).max(max));
}

function boolField(defaultValue: boolean) {
  return z.preprocess((v) => {
    const raw = envValue(v)?.toLowerCase();
    if (raw === undefined) return defaultValue;
    if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
    if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
    return raw; // not a boolean -> zod reports an invalid_type issue for this variable
  }, z.boolean());
}

function enumField<T extends readonly [string, ...string[]]>(values: T, defaultValue: T[number]) {
  return z.preprocess((v) => envValue(v) ?? defaultValue, z.enum(values));
}

function usdcField(defaultValue: string) {
  return z.preprocess((v) => envValue(v) ?? defaultValue, UsdcAmountSchema);
}

const MESH_NETWORK_VALUES = ["mainnet", "testnet"] as const;
const LOG_LEVEL_VALUES = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const PROVIDER_VALUES = ["ollama", "vllm", "openai"] as const;

/**
 * Runs a schema against an environment and converts any failure into a {@link ConfigError}
 * that names the offending variables. The schema is keyed by environment variable name, so
 * zod's issue paths *are* the variable names.
 */
function parseEnv<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  env: NodeJS.ProcessEnv,
  kind: string,
): T {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const flat = result.error.flatten();
  const variables = Object.keys(flat.fieldErrors).sort();
  const named = variables.length > 0 ? variables.join(", ") : "unknown variable";
  throw new ConfigError(`invalid ${kind} configuration: ${named}`, {
    variables,
    // Values are never included; `errors.ts` additionally redacts secret-looking keys.
    issues: flat.fieldErrors,
  });
}

/**
 * Reconciles the two ways a network can be specified.
 *
 * `MESH_NETWORK` is the friendly selector; `X402_NETWORK` is an explicit CAIP-2 override
 * (accepted in either encoding). If both are set and disagree, that is a deployment mistake
 * worth failing on rather than silently preferring one.
 */
function resolveNetwork(
  env: NodeJS.ProcessEnv,
  selector: MeshNetwork,
  override: string | undefined,
): { network: Network; meshNetwork: MeshNetwork } {
  if (override === undefined) {
    return { network: toCaip2(selector), meshNetwork: selector };
  }
  let network: Network;
  try {
    network = normalizeNetwork(override);
  } catch {
    throw new ConfigError("X402_NETWORK is not a supported Algorand CAIP-2 network", {
      variables: ["X402_NETWORK"],
      value: override,
    });
  }
  const derived = toMeshNetwork(network);
  if (envValue(env["MESH_NETWORK"]) !== undefined && derived !== selector) {
    throw new ConfigError(`MESH_NETWORK (${selector}) and X402_NETWORK (${derived}) disagree`, {
      variables: ["MESH_NETWORK", "X402_NETWORK"],
    });
  }
  return { network, meshNetwork: derived };
}

/** Fully resolved gateway configuration. */
export interface GatewayConfig {
  port: number;
  host: string;
  /** Canonical CAIP-2 network the gateway settles on. */
  network: Network;
  /** Friendly selector matching `network`. */
  meshNetwork: MeshNetwork;
  facilitatorUrl: string;
  /** Algorand address the client pays. Must be opted in to USDC. */
  payToAddress: string;
  /** Price charged to the client per request, as a decimal USDC string. */
  inboundPriceUsdc: string;
  /** Gateway margin in basis points. */
  marginBps: number;
  /** Externally reachable base URL, used in x402 resource declarations. */
  publicBaseUrl: string;
  /** Optional Redis connection string; the registry falls back to memory when absent. */
  redisUrl?: string;
  /** When true, nodes whose operator address has not opted in to USDC are not routable. */
  requireUsdcOptIn: boolean;
  /**
   * Reverse-proxy hops to trust when resolving the client IP.
   *
   * 0 (default) trusts no `X-Forwarded-For` header and uses the real socket peer. Anything
   * higher lets that many proxy hops set the apparent client address, so it must match the
   * deployment exactly — an over-count lets clients spoof their own rate-limit bucket.
   */
  trustProxyHops: number;
  /**
   * When true, node endpoints may point at private, loopback or link-local addresses.
   *
   * Defaults to false: an operator-supplied endpoint is attacker-controlled input that the
   * gateway makes outbound requests to, so allowing private address space turns node
   * registration into an SSRF primitive. Local development and the docker-compose demo set
   * this to true deliberately, since their nodes live on private addresses.
   */
  allowPrivateNodeEndpoints: boolean;
  nodeRequestTimeoutMs: number;
  maxConcurrentPerNode: number;
  logLevel: string;
  otelEnabled: boolean;
  otelExporterUrl?: string;
  /** Discovery tag advertised on the paid route. */
  challengeTag: string;
}

const GatewayEnvSchema = z.object({
  PORT: intField(DEFAULT_GATEWAY_PORT, 1, 65_535),
  HOST: stringField("0.0.0.0", 255),
  MESH_NETWORK: enumField(MESH_NETWORK_VALUES, "testnet"),
  X402_NETWORK: optionalStringField(128),
  X402_FACILITATOR_URL: urlField(DEFAULT_FACILITATOR_URL),
  X402_PAY_TO_ADDRESS: z.preprocess((v) => envValue(v), AlgorandAddressSchema),
  MESH_INBOUND_PRICE_USDC: usdcField(DEFAULT_INBOUND_USDC),
  MESH_MARGIN_BPS: intField(DEFAULT_MARGIN_BPS, 0, 10_000),
  MESH_PUBLIC_BASE_URL: optionalUrlField(),
  REDIS_URL: optionalStringField(),
  MESH_REQUIRE_USDC_OPT_IN: boolField(true),
  MESH_ALLOW_PRIVATE_NODE_ENDPOINTS: boolField(false),
  MESH_TRUST_PROXY_HOPS: intField(0, 0, 10),
  MESH_NODE_REQUEST_TIMEOUT_MS: intField(DEFAULT_NODE_REQUEST_TIMEOUT_MS, 1_000, 600_000),
  MESH_MAX_CONCURRENT_PER_NODE: intField(DEFAULT_MAX_CONCURRENT_PER_NODE, 1, 1_024),
  LOG_LEVEL: enumField(LOG_LEVEL_VALUES, "info"),
  OTEL_ENABLED: boolField(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrlField(),
  X402_CHALLENGE_TAG: stringField(CHALLENGE_TAG, 64),
});

/**
 * Loads and validates gateway configuration.
 *
 * Required: `X402_PAY_TO_ADDRESS`. Everything else has a documented default —
 * port 8402, TestNet, the GoPlausible facilitator, $0.0020 inbound and 1500 bps margin.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @throws {ConfigError} naming the offending variables.
 */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = parseEnv(GatewayEnvSchema, env, "gateway");
  const { network, meshNetwork } = resolveNetwork(env, parsed.MESH_NETWORK, parsed.X402_NETWORK);
  const port = parsed.PORT;

  const config: GatewayConfig = {
    port,
    host: parsed.HOST,
    network,
    meshNetwork,
    facilitatorUrl: stripTrailingSlash(parsed.X402_FACILITATOR_URL),
    payToAddress: parsed.X402_PAY_TO_ADDRESS,
    inboundPriceUsdc: parsed.MESH_INBOUND_PRICE_USDC,
    marginBps: parsed.MESH_MARGIN_BPS,
    publicBaseUrl: stripTrailingSlash(parsed.MESH_PUBLIC_BASE_URL ?? `http://localhost:${port}`),
    requireUsdcOptIn: parsed.MESH_REQUIRE_USDC_OPT_IN,
    allowPrivateNodeEndpoints: parsed.MESH_ALLOW_PRIVATE_NODE_ENDPOINTS,
    trustProxyHops: parsed.MESH_TRUST_PROXY_HOPS,
    nodeRequestTimeoutMs: parsed.MESH_NODE_REQUEST_TIMEOUT_MS,
    maxConcurrentPerNode: parsed.MESH_MAX_CONCURRENT_PER_NODE,
    logLevel: parsed.LOG_LEVEL,
    otelEnabled: parsed.OTEL_ENABLED,
    challengeTag: parsed.X402_CHALLENGE_TAG,
  };
  if (parsed.REDIS_URL !== undefined) config.redisUrl = parsed.REDIS_URL;
  if (parsed.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined) {
    config.otelExporterUrl = parsed.OTEL_EXPORTER_OTLP_ENDPOINT;
  }
  return config;
}

/** Fully resolved node daemon configuration. */
export interface DaemonConfig {
  /** Base URL of the mesh gateway this node registers with. */
  gatewayUrl: string;
  nodeId: string;
  /** Absolute URL the gateway will forward inference requests to. */
  endpoint: string;
  provider: DaemonProvider;
  providerBaseUrl: string;
  /** Models this node advertises. */
  models: string[];
  network: Network;
  heartbeatIntervalMs: number;
  maxConcurrency: number;
  /** Base64 of the 64-byte Algorand secret key. Never log this value. */
  privateKeyB64: string;
}

const DaemonEnvSchema = z.object({
  MESH_GATEWAY_URL: requiredUrlField(),
  MESH_NODE_ID: z.preprocess(
    (v) => envValue(v),
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "nodeId contains illegal characters"),
  ),
  MESH_NODE_ENDPOINT: requiredUrlField(),
  MESH_PROVIDER: enumField(PROVIDER_VALUES, "ollama"),
  MESH_PROVIDER_BASE_URL: optionalUrlField(),
  MESH_MODELS: z.preprocess(
    (v) => {
      const raw = envValue(v);
      if (raw === undefined) return undefined;
      return raw
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0);
    },
    z.array(z.string().min(1).max(200)).min(1, "at least one model is required").max(64),
  ),
  MESH_NETWORK: enumField(MESH_NETWORK_VALUES, "testnet"),
  X402_NETWORK: optionalStringField(128),
  MESH_HEARTBEAT_INTERVAL_MS: intField(DEFAULT_HEARTBEAT_INTERVAL_MS, 1_000, 600_000),
  MESH_MAX_CONCURRENCY: intField(DEFAULT_MAX_CONCURRENT_PER_NODE, 1, 1_024),
  AVM_PRIVATE_KEY: z.preprocess(
    (v) => envValue(v),
    z
      .string()
      .refine(
        (value) => Buffer.from(value, "base64").length === ALGORAND_SECRET_KEY_BYTES,
        `must be base64 of a ${ALGORAND_SECRET_KEY_BYTES}-byte Algorand secret key`,
      ),
  ),
});

/**
 * Loads and validates node daemon configuration.
 *
 * Required: `MESH_GATEWAY_URL`, `MESH_NODE_ID`, `MESH_NODE_ENDPOINT`, `MESH_MODELS`
 * (comma-separated) and `AVM_PRIVATE_KEY`. The private key is validated by decoded length
 * only — its value is never placed in an error message or in error details.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @throws {ConfigError} naming the offending variables.
 */
export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const parsed = parseEnv(DaemonEnvSchema, env, "node daemon");
  const { network } = resolveNetwork(env, parsed.MESH_NETWORK, parsed.X402_NETWORK);
  const provider = parsed.MESH_PROVIDER;

  return {
    gatewayUrl: stripTrailingSlash(parsed.MESH_GATEWAY_URL),
    nodeId: parsed.MESH_NODE_ID,
    endpoint: stripTrailingSlash(parsed.MESH_NODE_ENDPOINT),
    provider,
    providerBaseUrl: stripTrailingSlash(
      parsed.MESH_PROVIDER_BASE_URL ?? PROVIDER_DEFAULT_BASE_URL[provider],
    ),
    models: parsed.MESH_MODELS,
    network,
    heartbeatIntervalMs: parsed.MESH_HEARTBEAT_INTERVAL_MS,
    maxConcurrency: parsed.MESH_MAX_CONCURRENCY,
    privateKeyB64: parsed.AVM_PRIVATE_KEY,
  };
}

/** URLs are stored without a trailing slash so path joins never produce `//`. */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.replace(/\/+$/, "") : url;
}
