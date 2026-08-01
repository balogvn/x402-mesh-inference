import { ValidationError } from "@x402-mesh/shared";

/**
 * Releases a permit previously taken from a {@link Semaphore}.
 *
 * Idempotent: calling it more than once releases exactly one permit. That matters because
 * release lives in a `finally` block that can run alongside an error path which already
 * released — a double release would silently raise the effective concurrency ceiling.
 */
export type Release = () => void;

interface Waiter {
  resolve: (release: Release) => void;
  reject: (reason: unknown) => void;
  detach: () => void;
}

/**
 * Counting semaphore that caps how many inference requests run at once.
 *
 * A GPU box has a hard capacity; admitting more work than it can serve turns one slow
 * request into a queue of slow requests and makes the whole node look unhealthy to the
 * gateway. The HTTP server therefore uses {@link tryAcquire} and answers 503 immediately on
 * saturation, so the gateway can route to another node instead of waiting. {@link acquire}
 * exists for callers that legitimately want to queue.
 */
export class Semaphore {
  /** Maximum number of permits held simultaneously. */
  readonly permits: number;

  private active = 0;
  private readonly waiters: Waiter[] = [];

  /**
   * @param permits - Maximum concurrent holders; must be a positive integer.
   * @throws {ValidationError} if `permits` is not a positive integer.
   */
  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits <= 0) {
      throw new ValidationError("semaphore permits must be a positive integer", { permits });
    }
    this.permits = permits;
  }

  /** Permits currently held. */
  get inFlight(): number {
    return this.active;
  }

  /** Permits available right now. Zero means the next {@link tryAcquire} fails. */
  get available(): number {
    return this.permits - this.active;
  }

  /** Callers queued in {@link acquire}, waiting for a permit. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Takes a permit if one is free.
   *
   * @returns A release function, or `null` when saturated. Never blocks.
   */
  tryAcquire(): Release | null {
    if (this.active >= this.permits) return null;
    this.active += 1;
    return this.makeRelease();
  }

  /**
   * Waits for a permit.
   *
   * @param signal - Optional abort signal; aborting removes the waiter from the queue and
   * rejects with the signal's reason.
   */
  acquire(signal?: AbortSignal): Promise<Release> {
    const immediate = this.tryAcquire();
    if (immediate) return Promise.resolve(immediate);

    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, detach: () => {} };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.detach = () => signal.removeEventListener("abort", onAbort);
      }
      this.waiters.push(waiter);
    });
  }

  /**
   * Runs `fn` while holding a permit, releasing it whether `fn` resolves or throws.
   *
   * @param signal - Optional abort signal forwarded to {@link acquire}.
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Builds a single-use release closure and hands the permit to the next waiter, if any. */
  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) {
        // The permit moves straight to the waiter; `active` stays put.
        waiter.detach();
        waiter.resolve(this.makeRelease());
        return;
      }
      this.active -= 1;
    };
  }
}
