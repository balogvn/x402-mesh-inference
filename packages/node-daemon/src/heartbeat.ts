import {
  HEARTBEAT_DOMAIN,
  UpstreamError,
  canonicalHeartbeatBytes,
  registrationNonce,
} from "@x402-mesh/shared";
import type { NodeHeartbeat, SignedNodeHeartbeat } from "@x402-mesh/shared";
import type { DaemonConfig } from "@x402-mesh/shared";
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

/**
 * The heartbeat signing scheme now lives in `@x402-mesh/shared`, because the gateway has to
 * verify exactly what this daemon signs. It was defined here first, alongside a second copy
 * of the canonical-JSON serializer — and a signing scheme implemented twice is a scheme that
 * only has to disagree once to break authentication in production while every test passes.
 * Re-exported so existing importers keep working.
 */
export { HEARTBEAT_DOMAIN, canonicalHeartbeatBytes };
export type { NodeHeartbeat, SignedNodeHeartbeat };

/** Signs a heartbeat with the operator key. */
export function signHeartbeat(heartbeat: NodeHeartbeat, key: OperatorKey): SignedNodeHeartbeat {
  return {
    heartbeat,
    signature: key.signB64(canonicalHeartbeatBytes(heartbeat)),
    publicKey: key.publicKeyB64,
  };
}

/** Default heartbeat path builder: `POST /v1/nodes/{nodeId}/heartbeat`. */
export function defaultHeartbeatPath(nodeId: string): string {
  return `/v1/nodes/${encodeURIComponent(nodeId)}/heartbeat`;
}

/** Live load figures the loop samples immediately before each beat. */
export interface HeartbeatSnapshot {
  /** False when the inference backend is unreachable. */
  healthy: boolean;
  /** Requests currently executing. */
  inFlight: number;
}

/** Outcome of a single beat, returned by {@link HeartbeatLoop.tick} for tests and logging. */
export interface HeartbeatTickResult {
  /** True when the gateway accepted the beat. */
  ok: boolean;
  /** HTTP status, or `null` when the request never got a response. */
  status: number | null;
  /** True when the gateway had forgotten this node and re-registration was triggered. */
  reregistered: boolean;
  /** Failure cause when `ok` is false. */
  error?: Error;
}

/** Minimal timer surface, so tests can drive the loop without real time passing. */
export interface Scheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_SCHEDULER: Scheduler = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // The heartbeat must not by itself keep the process alive: the HTTP server is what holds
    // the event loop open, and an unref'd timer lets `stop()` plus a closed server exit
    // cleanly instead of hanging for one more interval.
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Construction options for {@link HeartbeatLoop}. */
export interface HeartbeatOptions {
  config: DaemonConfig;
  key: OperatorKey;
  /** Sampled immediately before each beat. */
  snapshot: () => HeartbeatSnapshot | Promise<HeartbeatSnapshot>;
  /**
   * Re-registers the node. Invoked when the gateway answers 404 or 410, which means it
   * restarted and lost this node's record.
   */
  reregister: () => Promise<void>;
  /** Injected `fetch`; defaults to the global. */
  fetchImpl?: FetchLike;
  /** Per-beat HTTP deadline in milliseconds. */
  timeoutMs?: number;
  /** Ceiling on the jittered backoff delay after repeated failures. */
  maxBackoffMs?: number;
  /** Overrides the heartbeat path builder. */
  heartbeatPath?: (nodeId: string) => string;
  /** Injected timers; tests substitute a controllable scheduler. */
  scheduler?: Scheduler;
  /** Overrides `Date.now()`; used by tests. */
  now?: () => number;
  /** Deterministic jitter source in [0, 1); defaults to `Math.random`. */
  random?: () => number;
  /** Called after every beat, for logging. */
  onResult?: (result: HeartbeatTickResult) => void;
}

/** Ceiling on the backoff delay after repeated heartbeat failures. */
const DEFAULT_MAX_BACKOFF_MS = 120_000;

/** Jitter band applied to the scheduled delay: ±20%. */
const JITTER_FRACTION = 0.2;

/**
 * Periodic signed heartbeat.
 *
 * Steady state beats every `config.heartbeatIntervalMs`. Consecutive failures back off
 * exponentially up to {@link HeartbeatOptions.maxBackoffMs}, and every delay carries ±20%
 * jitter so a fleet of nodes that all lost the gateway at the same moment does not come back
 * in lockstep and knock it over again.
 *
 * A 404 or 410 means the gateway no longer knows this node — almost always because it
 * restarted with an in-memory registry. That is recoverable, so the loop re-registers and
 * resumes rather than requiring an operator to notice and restart the daemon.
 *
 * The loop owns exactly one timer at a time and {@link stop} clears it, so a stopped loop
 * leaves nothing behind.
 */
export class HeartbeatLoop {
  private readonly options: HeartbeatOptions;
  private readonly fetchImpl: FetchLike;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly url: string;

  private timer: unknown = null;
  private running = false;
  private consecutiveFailures = 0;
  private inFlightTick: Promise<HeartbeatTickResult> | null = null;

  constructor(options: HeartbeatOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.scheduler = options.scheduler ?? REAL_SCHEDULER;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const path = (options.heartbeatPath ?? defaultHeartbeatPath)(options.config.nodeId);
    this.url = joinUrl(options.config.gatewayUrl, path);
  }

  /** True between {@link start} and {@link stop}. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Consecutive failed beats; resets to zero on the first success. */
  get failureStreak(): number {
    return this.consecutiveFailures;
  }

  /** Absolute URL each beat is POSTed to. */
  get endpoint(): string {
    return this.url;
  }

  /** Starts beating. Idempotent — a second call while running does nothing. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.consecutiveFailures = 0;
    this.schedule(this.options.config.heartbeatIntervalMs);
  }

  /**
   * Stops beating and clears the pending timer.
   *
   * A beat already in flight is allowed to finish (its result is simply not rescheduled);
   * await {@link drain} if you need it settled before exiting.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Resolves once any in-flight beat has settled. Safe to call when idle. */
  async drain(): Promise<void> {
    const pending = this.inFlightTick;
    if (pending) await pending.catch(() => undefined);
  }

  /**
   * Sends one heartbeat now.
   *
   * Never throws: every failure is reported through the returned {@link HeartbeatTickResult}
   * so a transient gateway outage cannot produce an unhandled rejection inside a timer.
   */
  async tick(): Promise<HeartbeatTickResult> {
    const pending = this.sendOnce();
    this.inFlightTick = pending;
    try {
      return await pending;
    } finally {
      if (this.inFlightTick === pending) this.inFlightTick = null;
    }
  }

  private async sendOnce(): Promise<HeartbeatTickResult> {
    const { config, key, snapshot, reregister, onResult } = this.options;
    let result: HeartbeatTickResult;

    try {
      const live = await snapshot();
      const heartbeat: NodeHeartbeat = {
        nodeId: config.nodeId,
        healthy: live.healthy,
        inFlight: live.inFlight,
        maxConcurrency: config.maxConcurrency,
        version: DAEMON_VERSION,
        timestamp: Math.floor(this.now()),
        // Fresh per beat: the gateway rejects a replayed nonce.
        nonce: registrationNonce(),
      };
      const envelope = signHeartbeat(heartbeat, key);

      const scope = scopedSignal(this.timeoutMs);
      let status: number;
      let snippet: string;
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: baseHeaders({ "content-type": "application/json", accept: "application/json" }),
          body: JSON.stringify(envelope),
          signal: scope.signal,
        });
        status = res.status;
        snippet = res.ok ? "" : await errorSnippet(res);
      } finally {
        scope.dispose();
      }

      if (status >= 200 && status < 300) {
        result = { ok: true, status, reregistered: false };
      } else if (status === 404 || status === 410) {
        // The gateway forgot us — recover by registering again rather than beating into a void.
        let reregistered = true;
        let error: Error | undefined;
        try {
          await reregister();
        } catch (cause) {
          reregistered = false;
          error = cause instanceof Error ? cause : new Error(String(cause));
        }
        result = {
          ok: reregistered,
          status,
          reregistered,
          ...(error ? { error } : {}),
        };
      } else {
        result = {
          ok: false,
          status,
          reregistered: false,
          error: new UpstreamError(`gateway rejected heartbeat (HTTP ${status})`, {
            status,
            nodeId: config.nodeId,
            ...(snippet.length > 0 ? { body: snippet } : {}),
          }),
        };
      }
    } catch (cause) {
      const error = isAbort(cause)
        ? new UpstreamError("heartbeat timed out", { nodeId: config.nodeId })
        : transportError("gateway", "heartbeat", cause);
      result = {
        ok: false,
        status: null,
        reregistered: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }

    this.consecutiveFailures = result.ok ? 0 : this.consecutiveFailures + 1;
    onResult?.(result);
    return result;
  }

  /** Arms the next beat. Only ever one timer is outstanding. */
  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      void this.tick().then(
        () => this.scheduleNext(),
        // `tick` never rejects; this arm exists so a future change cannot silently stop the
        // loop by throwing inside the timer callback.
        () => this.scheduleNext(),
      );
    }, this.jitter(delayMs));
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.schedule(this.nextDelayMs());
  }

  /** Steady interval on success; exponential backoff, capped, after failures. */
  private nextDelayMs(): number {
    const base = this.options.config.heartbeatIntervalMs;
    if (this.consecutiveFailures === 0) return base;
    const exponential = base * 2 ** Math.min(this.consecutiveFailures, 16);
    return Math.min(this.maxBackoffMs, exponential);
  }

  /** Applies ±20% jitter, never returning less than 1 ms. */
  private jitter(delayMs: number): number {
    const spread = delayMs * JITTER_FRACTION;
    const offset = (this.random() * 2 - 1) * spread;
    return Math.max(1, Math.round(delayMs + offset));
  }
}
