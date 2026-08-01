import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_NODE_PAYOUT_USDC,
  NodeRegistrationSchema,
  SignedNodeRegistrationSchema,
  UpstreamError,
  ValidationError,
  canonicalRegistrationBytes,
  parseOrThrow,
  registrationNonce,
} from "@x402-mesh/shared";
import type {
  DaemonConfig,
  NodeCapability,
  NodeRegistration,
  SignedNodeRegistration,
} from "@x402-mesh/shared";
import {
  DEFAULT_CONTROL_TIMEOUT_MS,
  baseHeaders,
  errorSnippet,
  isAbort,
  joinUrl,
  scopedSignal,
  transportError,
} from "./http.js";
import type { FetchLike } from "./http.js";
import type { OperatorKey } from "./keys.js";
import { DAEMON_VERSION } from "./version.js";

/** Path the gateway exposes for node registration. */
export const REGISTER_PATH = "/v1/nodes/register";

/**
 * Context window advertised for a model when the operator does not state one.
 *
 * 8192 is the smallest window shared by the common 7B-class local models, so a node that
 * takes the default cannot be routed a prompt its backend will refuse.
 */
export const DEFAULT_CONTEXT_WINDOW = 8192;

/**
 * Price a node quotes per 1000 tokens when the operator does not state one.
 *
 * Matches the published per-request operator payout ($0.0017), so a default node's quote is
 * consistent with the mesh's documented economics out of the box.
 */
export const DEFAULT_PRICE_PER_1K_TOKENS_USDC = DEFAULT_NODE_PAYOUT_USDC;

/** Attempts made before {@link registerNode} gives up. */
const DEFAULT_MAX_ATTEMPTS = 4;

/** First retry delay; doubles per attempt with jitter. */
const DEFAULT_RETRY_BASE_MS = 500;

/** Ceiling on a single retry delay. */
const DEFAULT_RETRY_MAX_MS = 8_000;

/** Per-model advertisement inputs an operator may override. */
export interface CapabilityOverrides {
  /** Maximum prompt + completion tokens accepted, per model or as a single default. */
  contextWindow?: number;
  /** Decimal USDC quote per 1000 tokens, per model or as a single default. */
  pricePer1kTokensUsdc?: string;
  /** Optional quantization label applied to every advertised model, e.g. `"q4_K_M"`. */
  quantization?: string;
}

/**
 * Builds the advertised capability list from the configured models.
 *
 * @throws {ValidationError} if `cfg.models` is empty — a node with nothing to serve must not
 * register, because the gateway would score it as routable and then fail every request.
 */
export function buildCapabilities(
  cfg: DaemonConfig,
  overrides: CapabilityOverrides = {},
): NodeCapability[] {
  if (cfg.models.length === 0) {
    throw new ValidationError("a node must advertise at least one model");
  }
  const contextWindow = overrides.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const price = overrides.pricePer1kTokensUsdc ?? DEFAULT_PRICE_PER_1K_TOKENS_USDC;
  return cfg.models.map((model) => {
    const capability: NodeCapability = {
      model,
      contextWindow,
      pricePer1kTokensUsdc: price,
    };
    if (overrides.quantization !== undefined) capability.quantization = overrides.quantization;
    return capability;
  });
}

/** Inputs to {@link buildRegistration} beyond the daemon configuration. */
export interface BuildRegistrationOptions extends CapabilityOverrides {
  /** Overrides `Date.now()`; used by tests. */
  now?: () => number;
  /** Overrides the random nonce; used by tests. */
  nonce?: () => string;
  /** Version string to advertise. Defaults to this daemon's version. */
  version?: string;
}

/**
 * Assembles a validated {@link NodeRegistration}.
 *
 * A **fresh nonce and a current timestamp are minted on every call** — the gateway keeps a
 * seen-nonce set and rejects replays, so reusing either turns a retry into a hard failure.
 * Callers must therefore build inside their retry loop, never above it.
 *
 * The result is run through `NodeRegistrationSchema` before it is returned, so an invalid
 * registration is caught here rather than after it has been signed and sent.
 *
 * @param cfg - Daemon configuration supplying the node id, endpoint, models and network.
 * @param key - Operator key; only its address is read.
 * @throws {ValidationError} if the assembled registration fails schema validation.
 */
export function buildRegistration(
  cfg: DaemonConfig,
  key: OperatorKey,
  options: BuildRegistrationOptions = {},
): NodeRegistration {
  const now = options.now ?? Date.now;
  const nonce = options.nonce ?? registrationNonce;
  const registration: NodeRegistration = {
    nodeId: cfg.nodeId,
    operatorAddress: key.address,
    endpoint: cfg.endpoint,
    capabilities: buildCapabilities(cfg, options),
    network: cfg.network,
    version: options.version ?? DAEMON_VERSION,
    timestamp: Math.floor(now()),
    nonce: nonce(),
  };
  return parseOrThrow(NodeRegistrationSchema, registration, "node registration");
}

/**
 * Signs a registration with the operator's Ed25519 key.
 *
 * The signature covers `canonicalRegistrationBytes(registration)` — the shared, key-sorted,
 * domain-separated projection — so the gateway can reconstruct the exact bytes from the JSON
 * it receives regardless of key order or of extra properties in transit.
 *
 * The signed envelope is validated before it is returned and the signature is verified
 * against the payload we just built: a key that signs but does not verify is a corrupt key,
 * and finding that out here beats finding it out as a gateway 401 in production.
 *
 * @throws {ValidationError} if the envelope fails schema validation.
 */
export function signRegistration(
  registration: NodeRegistration,
  key: OperatorKey,
): SignedNodeRegistration {
  const message = canonicalRegistrationBytes(registration);
  const envelope: SignedNodeRegistration = {
    registration,
    signature: key.signB64(message),
    publicKey: key.publicKeyB64,
  };
  return parseOrThrow(SignedNodeRegistrationSchema, envelope, "signed node registration");
}

/** Options for {@link registerNode}. */
export interface RegisterNodeOptions extends BuildRegistrationOptions {
  /** Injected `fetch`; defaults to the global. */
  fetchImpl?: FetchLike;
  /** Per-attempt HTTP deadline in milliseconds. */
  timeoutMs?: number;
  /** Total attempts, including the first. Defaults to 4. */
  maxAttempts?: number;
  /** First retry delay in milliseconds; doubles per attempt. */
  retryBaseMs?: number;
  /** Ceiling on a single retry delay in milliseconds. */
  retryMaxMs?: number;
  /** Aborts the whole operation, including the sleeps between attempts. */
  signal?: AbortSignal;
  /** Deterministic jitter source in [0, 1); defaults to `Math.random`. */
  random?: () => number;
  /** Called before each attempt, for logging. */
  onAttempt?: (attempt: number, maxAttempts: number) => void;
}

/** What {@link registerNode} returns on success. */
export interface RegisterNodeResult {
  /** The exact registration the gateway accepted, including its nonce and timestamp. */
  registration: NodeRegistration;
  /** HTTP status the gateway answered with. */
  status: number;
  /** Parsed response body, or `null` when the gateway answered with no JSON. */
  body: unknown;
  /** Attempts made, including the successful one. */
  attempts: number;
}

/**
 * Registers this node with the gateway, retrying transient failures.
 *
 * Retry policy: network errors, HTTP 429 and HTTP 5xx are retried with exponential backoff
 * and full jitter; every other 4xx is fatal, because a rejected signature or a malformed
 * payload will be rejected identically on the next attempt. **Each attempt re-builds and
 * re-signs the registration** so it carries a fresh nonce and a current timestamp — a retry
 * that reused them would be rejected as a replay, and a retry after a long backoff would be
 * rejected as stale.
 *
 * @throws {UpstreamError} when every attempt fails, or immediately on a fatal 4xx.
 */
export async function registerNode(
  cfg: DaemonConfig,
  key: OperatorKey,
  options: RegisterNodeOptions = {},
): Promise<RegisterNodeResult> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const random = options.random ?? Math.random;
  const url = joinUrl(cfg.gatewayUrl, REGISTER_PATH);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.onAttempt?.(attempt, maxAttempts);

    // Fresh every attempt: the gateway rejects a reused nonce and a stale timestamp.
    const registration = buildRegistration(cfg, key, options);
    const envelope = signRegistration(registration, key);

    const scope = scopedSignal(timeoutMs, options.signal);
    let fatal = false;
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: baseHeaders({ "content-type": "application/json", accept: "application/json" }),
        body: JSON.stringify(envelope),
        signal: scope.signal,
      });

      if (res.ok) {
        return { registration, status: res.status, body: await readJson(res), attempts: attempt };
      }

      const snippet = await errorSnippet(res);
      lastError = new UpstreamError(`gateway rejected node registration (HTTP ${res.status})`, {
        status: res.status,
        nodeId: cfg.nodeId,
        ...(snippet.length > 0 ? { body: snippet } : {}),
      });
      // A rejected signature or a malformed payload fails identically next time; stop now.
      fatal = !isRetryableStatus(res.status);
    } catch (cause) {
      // A caller-initiated abort is not a gateway fault and must not be retried.
      if (isAbort(cause) && options.signal?.aborted) throw cause;
      lastError = transportError("gateway", "node registration", cause);
    } finally {
      scope.dispose();
    }

    if (fatal) break;
    if (attempt === maxAttempts) break;
    await sleep(backoffMs(attempt, retryBaseMs, retryMaxMs, random), options.signal);
  }

  throw lastError instanceof Error
    ? lastError
    : new UpstreamError("node registration failed", { nodeId: cfg.nodeId });
}

/** 408, 425, 429 and every 5xx are transient; other 4xx will fail identically on retry. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter (a uniform draw from `[0, cap]`) rather than a fixed delay: when a gateway
 * restarts, every node in the mesh retries at once, and synchronized retries would hammer it
 * back down.
 */
export function backoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * exponential);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await delay(ms, undefined, signal ? { signal } : undefined);
}

/** Reads a JSON body, tolerating an empty or non-JSON success response. */
async function readJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (text.trim().length === 0) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
