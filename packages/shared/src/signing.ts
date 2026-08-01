import { randomBytes } from "node:crypto";
import { ValidationError } from "./errors.js";
import { normalizeNetwork } from "./networks.js";
import type { NodeCapability, NodeHeartbeat, NodeRegistration } from "./types.js";

/**
 * Domain separator prefixed to every registration signing payload.
 *
 * Without it, a signature produced for some other x402 message could in principle be
 * replayed as a registration. Bump the version suffix if the payload layout ever changes.
 */
const REGISTRATION_DOMAIN = "x402-mesh/node-registration/v1";

/**
 * Serializes a JSON-compatible value deterministically.
 *
 * Rules:
 * 1. Object keys are emitted in ascending order of their UTF-16 code units (`Array#sort`
 *    default), so insertion order cannot change the output.
 * 2. Array order is preserved — it is semantically meaningful.
 * 3. Keys whose value is `undefined` are omitted entirely.
 * 4. Numbers must be finite; `NaN`/`Infinity` throw rather than serialize as `null`.
 * 5. No insignificant whitespace is emitted.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new ValidationError("cannot canonicalize a non-finite number", {
          value: String(value),
        });
      }
      // JSON.stringify uses the shortest round-tripping representation, which is
      // deterministic across V8 versions and platforms.
      return JSON.stringify(value);
    case "bigint":
      return JSON.stringify(value.toString(10));
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",");
    return `{${body}}`;
  }
  throw new ValidationError("cannot canonicalize value", { type: typeof value });
}

/** Projects a capability onto exactly the fields that are covered by the signature. */
function projectCapability(c: NodeCapability): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    model: c.model,
    contextWindow: c.contextWindow,
    pricePer1kTokensUsdc: c.pricePer1kTokensUsdc,
  };
  if (c.quantization !== undefined) projected["quantization"] = c.quantization;
  return projected;
}

/**
 * Produces the exact byte sequence an operator signs to prove ownership of a registration.
 *
 * Scheme (stable — both the daemon that signs and the gateway that verifies depend on it):
 *
 * ```text
 * bytes = UTF-8( "x402-mesh/node-registration/v1" + "\n" + canonicalJson(projection) )
 * ```
 *
 * `projection` contains exactly the eight {@link NodeRegistration} fields (plus each
 * capability's three or four fields) — any extra property on the input object is ignored, so
 * a permissive parse upstream cannot change the payload. `network` is passed through
 * {@link normalizeNetwork} first, which makes the signature independent of whether the
 * signer used the truncated or the full-genesis-hash CAIP-2 encoding. `canonicalJson` sorts
 * object keys, so key insertion order is irrelevant.
 *
 * @throws {ValidationError} if the registration contains non-finite numbers.
 */
export function canonicalRegistrationBytes(r: NodeRegistration): Uint8Array {
  const projection = {
    nodeId: r.nodeId,
    operatorAddress: r.operatorAddress,
    endpoint: r.endpoint,
    capabilities: (r.capabilities ?? []).map(projectCapability),
    network: normalizeNetwork(r.network),
    version: r.version,
    timestamp: r.timestamp,
    nonce: r.nonce,
  };
  return new TextEncoder().encode(`${REGISTRATION_DOMAIN}\n${canonicalJson(projection)}`);
}

/**
 * Builds the exact bytes a signer covers: a domain separator, a newline, then canonical JSON.
 *
 * The domain separator is what stops a signature minted for one message kind from being
 * replayed as another — a captured registration signature must never verify as a heartbeat,
 * or an attacker could re-use one legitimate registration to keep a node "alive" forever.
 *
 * Exported so every message kind in the mesh shares ONE canonical-JSON implementation. A
 * second, independently written serializer only has to disagree on one edge case (key
 * ordering, a `-0`, a non-finite number) for signatures to stop verifying in production
 * while every unit test still passes.
 *
 * @param domain - Stable domain-separation string, versioned.
 * @param payload - The projection to serialize.
 * @returns UTF-8 bytes to sign or verify.
 */
export function domainSeparatedBytes(domain: string, payload: unknown): Uint8Array {
  return new TextEncoder().encode(`${domain}\n${canonicalJson(payload)}`);
}

/**
 * Domain separator for heartbeats. Distinct from {@link REGISTRATION_DOMAIN} on purpose.
 */
export const HEARTBEAT_DOMAIN = "x402-mesh/node-heartbeat/v1";

/**
 * Produces the exact byte sequence signed for a heartbeat.
 *
 * ```text
 * bytes = UTF-8( "x402-mesh/node-heartbeat/v1" + "\n" + canonicalJson(projection) )
 * ```
 *
 * The projection contains exactly the seven {@link NodeHeartbeat} fields, so a property added
 * in transit cannot change what was signed.
 *
 * @param h - The heartbeat to serialize.
 * @returns UTF-8 bytes covered by the signature.
 */
export function canonicalHeartbeatBytes(h: NodeHeartbeat): Uint8Array {
  return domainSeparatedBytes(HEARTBEAT_DOMAIN, {
    nodeId: h.nodeId,
    healthy: h.healthy,
    inFlight: h.inFlight,
    maxConcurrency: h.maxConcurrency,
    version: h.version,
    timestamp: h.timestamp,
    nonce: h.nonce,
  });
}

/** Generates a 128-bit cryptographically random nonce as 32 lowercase hex characters. */
export function registrationNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Maximum clock skew tolerated between a registration's timestamp and the gateway's clock.
 *
 * Two minutes is generous enough for an unsynchronized operator box and short enough that a
 * captured registration cannot be replayed indefinitely.
 */
export const REGISTRATION_MAX_SKEW_MS = 120_000;

/**
 * Rejects registration timestamps that are too old or too far in the future.
 *
 * The window is inclusive: a timestamp exactly `REGISTRATION_MAX_SKEW_MS` from `now` is
 * still accepted. Future timestamps are bounded too — otherwise an operator could mint a
 * registration that stays replayable for a year.
 *
 * @param ts - Registration timestamp, unix epoch milliseconds.
 * @param now - Reference time, defaults to `Date.now()`.
 * @throws {ValidationError} when `ts` is not a finite integer or falls outside the window.
 */
export function assertFreshTimestamp(ts: number, now: number = Date.now()): void {
  if (typeof ts !== "number" || !Number.isFinite(ts) || !Number.isInteger(ts)) {
    throw new ValidationError("timestamp must be an integer number of milliseconds", {
      timestamp: String(ts),
    });
  }
  const skew = ts - now;
  if (Math.abs(skew) > REGISTRATION_MAX_SKEW_MS) {
    throw new ValidationError(
      skew > 0
        ? "registration timestamp is too far in the future"
        : "registration timestamp is too old",
      { skewMs: skew, maxSkewMs: REGISTRATION_MAX_SKEW_MS },
    );
  }
}
