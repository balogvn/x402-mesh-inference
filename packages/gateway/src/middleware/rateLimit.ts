import { RateLimitError } from "@x402-mesh/shared";
import {
  decodeTransaction,
  getSenderFromTransaction,
  isExactAvmPayload,
  isValidAlgorandAddress,
} from "@x402/avm";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Clock } from "../ports.js";

/**
 * In-memory token bucket rate limiter.
 *
 * Keying strategy — payer address first, client IP second. The payer address is the
 * economically meaningful identity here: it is the account that will be charged, it survives
 * NAT and proxies, and it cannot be spoofed for free because producing a payment header for
 * an address you do not control requires that address's signature. IP is only the fallback
 * for unpaid probes.
 *
 * The clock is injected, so a test can advance time explicitly instead of sleeping. This is
 * an in-process limiter: a multi-replica deployment gets per-replica limits, which is the
 * right trade-off for a defensive limiter (Redis coordination on the hot path would add a
 * network round trip to every request to make an approximation slightly less approximate).
 */

/** Tunables for {@link rateLimit}. */
export interface RateLimitOptions {
  /** Burst size: tokens a fresh key starts with, and the ceiling it refills to. */
  capacity: number;
  /** Steady-state rate, in tokens per second. */
  refillPerSecond: number;
  /** Time source, in milliseconds. */
  now: Clock;
  /** Cap on tracked keys; the least recently used are evicted past this. */
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Default number of distinct keys held before LRU eviction kicks in. */
const DEFAULT_MAX_KEYS = 10_000;

/**
 * Builds the rate limiting middleware.
 *
 * On rejection the client gets a 429 carrying `Retry-After` (whole seconds, at least 1) so
 * a well-behaved agent can back off precisely instead of hammering.
 *
 * @throws {Error} at construction time when the options are not usable.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const { capacity, refillPerSecond, now } = options;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error("rateLimit: capacity must be a positive number");
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new Error("rateLimit: refillPerSecond must be a positive number");
  }
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  // Map preserves insertion order, which is all an LRU needs: re-insert on touch.
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = rateLimitKey(req);
    const at = now();

    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: capacity, updatedAt: at };
    } else {
      buckets.delete(key); // re-inserted below so it moves to the MRU end
      const elapsedSeconds = Math.max(0, at - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
      bucket.updatedAt = at;
    }

    if (bucket.tokens < 1) {
      const waitSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond));
      buckets.set(key, bucket);
      res.setHeader("Retry-After", String(waitSeconds));
      next(
        new RateLimitError("rate limit exceeded", {
          retryAfterSeconds: waitSeconds,
          limit: capacity,
          windowSeconds: Math.round(capacity / refillPerSecond),
        }),
      );
      return;
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);

    if (buckets.size > maxKeys) {
      const oldest = buckets.keys().next();
      if (!oldest.done) buckets.delete(oldest.value);
    }

    res.setHeader("x-ratelimit-limit", String(capacity));
    res.setHeader("x-ratelimit-remaining", String(Math.floor(bucket.tokens)));
    next();
  };
}

/**
 * Derives the bucket key from the remote address.
 *
 * This used to prefer `payer:<algorand address>` read from the x402 payment header, on the
 * reasoning that the value was "used for bucketing only, never for authorization". That
 * reasoning was wrong: bucketing *is* a security decision, and the header is attacker
 * controlled because it is read **before** the facilitator verifies anything. The sender of
 * an *unsigned* transaction decodes perfectly well, so it cost nothing to forge. Two
 * exploits followed, both demonstrated:
 *
 *   - **Targeted denial of service.** Name a paying customer's address in the header and
 *     drain their bucket; their own correctly-signed requests then get 429 indefinitely.
 *   - **Total bypass.** Rotate a fresh random sender per request for an unlimited supply of
 *     full-capacity buckets, leaving the paid route with no effective limit at all.
 *
 * Keying on the socket peer removes both: an attacker cannot choose someone else's bucket,
 * and cannot mint new ones without new addresses. The cost is that payers sharing a NAT
 * share a bucket, which is the correct trade against an unbounded bypass — tune capacity
 * rather than reintroducing an unauthenticated key.
 *
 * Exported for tests.
 */
export function rateLimitKey(req: Request): string {
  return `ip:${req.ip ?? req.socket?.remoteAddress ?? "unknown"}`;
}

/**
 * Best-effort extraction of the paying Algorand address from the x402 payment header.
 *
 * The v2 AVM payload carries the payer only implicitly, as the sender of the ASA transfer
 * leg at `paymentIndex`, so the transaction is decoded to read it. This runs *before*
 * verification, which makes the value unauthenticated: it is used for bucketing only, never
 * for authorization. A malformed header simply yields `undefined` and the request falls back
 * to IP bucketing — the payment middleware will reject it properly a moment later.
 */
export function payerFromRequest(req: Request): string | undefined {
  const header = req.header("payment-signature") ?? req.header("x-payment");
  if (header === undefined || header.length === 0) return undefined;
  try {
    const payload = decodePaymentSignatureHeader(header);
    if (!isExactAvmPayload(payload.payload)) return undefined;
    const leg = payload.payload.paymentGroup[payload.payload.paymentIndex];
    if (typeof leg !== "string" || leg.length === 0) return undefined;
    return senderOf(leg);
  } catch {
    return undefined;
  }
}

/**
 * Reads the sender address out of a base64 msgpack transaction.
 *
 * The client's leg is normally signed, but an unsigned leg is decodable too, so both are
 * attempted before giving up.
 */
function senderOf(encodedTxn: string): string | undefined {
  const bytes = decodeTransaction(encodedTxn);
  for (const isSigned of [true, false]) {
    try {
      const sender = getSenderFromTransaction(bytes, isSigned);
      if (isValidAlgorandAddress(sender)) return sender;
    } catch {
      // Try the other encoding before falling back to IP bucketing.
    }
  }
  return undefined;
}
