import { REGISTRATION_MAX_SKEW_MS } from "@x402-mesh/shared";
import type { Clock } from "../ports.js";

/**
 * Replay defence for signed node registrations.
 *
 * A registration signature is valid forever, so freshness alone is not enough: an attacker
 * who observes one registration can resubmit the identical bytes for as long as the
 * timestamp window allows and, for instance, revert an operator's endpoint to an old value.
 * Remembering every nonce seen inside that window closes it.
 *
 * The retention window is twice `REGISTRATION_MAX_SKEW_MS`, which is the full width of the
 * accepted timestamp range (`now ± skew`). Once a nonce is older than that, its registration
 * can no longer pass the freshness check, so forgetting it is safe.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: Clock;

  /**
   * @param now - Time source in milliseconds; injected so tests control expiry.
   * @param ttlMs - Retention window. Defaults to the full registration acceptance width.
   * @param maxEntries - Hard cap, so a flood of registrations cannot exhaust memory.
   */
  constructor(now: Clock = Date.now, ttlMs = REGISTRATION_MAX_SKEW_MS * 2, maxEntries = 50_000) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Atomically claims `nonce`.
   *
   * @returns True when the nonce had not been seen (and is now recorded); false when it is a
   * replay. Callers must treat `false` as a hard rejection.
   */
  claim(nonce: string): boolean {
    const at = this.now();
    this.prune(at);
    const previous = this.seen.get(nonce);
    if (previous !== undefined && at - previous < this.ttlMs) return false;
    this.seen.set(nonce, at);
    return true;
  }

  /** Number of nonces currently retained. Exposed for tests and `/readyz` diagnostics. */
  get size(): number {
    return this.seen.size;
  }

  /**
   * Drops expired entries, and — if still over the cap — the oldest ones.
   *
   * `Map` iterates in insertion order and entries are never re-inserted, so the head of the
   * iteration is always the oldest.
   */
  private prune(at: number): void {
    for (const [nonce, recordedAt] of this.seen) {
      if (at - recordedAt < this.ttlMs) break;
      this.seen.delete(nonce);
    }
    while (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}
