/**
 * Mesh error taxonomy.
 *
 * Every failure that crosses a package boundary is expressed as a {@link MeshError}
 * subclass carrying a stable machine-readable `code` and the HTTP status the gateway
 * should surface. This module has no intra-package imports on purpose — everything else
 * imports it, so it must stay at the bottom of the dependency graph.
 */

/** Keys whose values are redacted before an error ever reaches a log line or a client. */
const SECRET_KEY_PATTERN = /(key|secret|token|password|passphrase|mnemonic|auth|credential)/i;

/** Upper bound on a single detail string, so a leaked buffer cannot flood a response. */
const MAX_DETAIL_STRING = 512;

/** Upper bound on collection sizes echoed back to a client. */
const MAX_DETAIL_ITEMS = 32;

/**
 * Recursively strips secret-looking keys, truncates long strings and drops non-serializable
 * values from an error `details` bag.
 *
 * This runs on the way *out* (in `toJSON`), not on the way in, so callers may attach rich
 * context locally without worrying about what is safe to expose.
 */
function sanitizeDetailValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return value.length > MAX_DETAIL_STRING ? `${value.slice(0, MAX_DETAIL_STRING)}…` : value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString(10);
    case "undefined":
      return undefined;
    default:
      break;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAIL_ITEMS).map((v) => sanitizeDetailValue(v, depth + 1));
  }
  // Errors are never echoed structurally: only their class name survives, never the stack.
  if (value instanceof Error) return `[${value.name}]`;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (count >= MAX_DETAIL_ITEMS) break;
      count += 1;
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      const sanitized = sanitizeDetailValue(v, depth + 1);
      if (sanitized !== undefined) out[k] = sanitized;
    }
    return out;
  }
  return undefined;
}

/** Shape produced by {@link MeshError.toJSON} and by {@link toErrorResponse}. */
export interface MeshErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Base class for every error the mesh raises deliberately.
 *
 * `code` is the stable contract with clients (never change an existing value);
 * `httpStatus` is what the gateway returns; `details` is optional structured context that
 * is sanitized before serialization.
 */
export class MeshError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    httpStatus: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    if (details !== undefined) this.details = details;
    // Preserve the prototype chain when this file is consumed as downlevelled output.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Client-safe JSON body. Never contains a stack trace or a secret-looking value. */
  toJSON(): MeshErrorBody {
    const body: MeshErrorBody = { error: { code: this.code, message: this.message } };
    if (this.details !== undefined) {
      const sanitized = sanitizeDetailValue(this.details) as Record<string, unknown>;
      if (sanitized && Object.keys(sanitized).length > 0) body.error.details = sanitized;
    }
    return body;
  }
}

/** Invalid or missing configuration (environment, network id, price string). */
export class ConfigError extends MeshError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "config_error", 500, details);
  }
}

/** A money split violated the `inbound === payout + margin` invariant. */
export class PricingError extends MeshError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "pricing_error", 500, details);
  }
}

/** Caller-supplied data failed schema or freshness validation. */
export class ValidationError extends MeshError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "validation_error", 400, details);
  }
}

/** The x402 payment leg is missing, malformed or was rejected. */
export class PaymentError extends MeshError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "payment_error", 402, details);
  }
}

/** An on-chain settlement (inbound capture or operator payout) failed. */
export class SettlementError extends MeshError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "settlement_error", 502, details);
  }
}

/** No healthy node could serve the requested model right now. */
export class NoCapacityError extends MeshError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "no_capacity", 503, details);
  }
}

/** A downstream node or the facilitator returned an unusable response. */
export class UpstreamError extends MeshError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "upstream_error", 502, details);
  }
}

/** Signature verification or API-key authentication failed. */
export class AuthError extends MeshError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "auth_error", 401, details);
  }
}

/** The caller exceeded its request budget. */
export class RateLimitError extends MeshError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "rate_limited", 429, details);
  }
}

/** Generic fallback body used for anything that is not a {@link MeshError}. */
const INTERNAL_BODY: MeshErrorBody = {
  error: { code: "internal_error", message: "Internal server error" },
};

/**
 * Maps any thrown value to a client-facing `{ status, body }` pair.
 *
 * Unknown throwables are deliberately collapsed to an opaque 500: their message may embed
 * filesystem paths, connection strings or key material, so it is never forwarded. Only
 * errors we constructed ourselves get to speak to the client.
 */
export function toErrorResponse(e: unknown): { status: number; body: unknown } {
  if (e instanceof MeshError) {
    return { status: e.httpStatus, body: e.toJSON() };
  }
  return { status: 500, body: { error: { ...INTERNAL_BODY.error } } };
}
