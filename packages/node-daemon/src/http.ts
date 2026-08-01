import { UpstreamError } from "@x402-mesh/shared";
import { DAEMON_USER_AGENT } from "./version.js";

/**
 * Small HTTP helpers shared by the providers, the registration client and the heartbeat.
 *
 * Everything that performs I/O takes a {@link FetchLike} so unit tests can stub it — no test
 * in this package opens a socket.
 */

/** The subset of `fetch` this package depends on. Injected everywhere for testability. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Default per-request deadline for control-plane calls (register, heartbeat, model list). */
export const DEFAULT_CONTROL_TIMEOUT_MS = 10_000;

/** Bytes of an error body echoed back in an {@link UpstreamError}. */
const ERROR_SNIPPET_BYTES = 400;

/** A timeout-bounded signal plus the cleanup that stops its timer from outliving the call. */
export interface ScopedSignal {
  signal: AbortSignal;
  /** Clears the timeout. Always call it, in a `finally`. */
  dispose: () => void;
}

/**
 * Combines a caller's abort signal with a timeout.
 *
 * `AbortSignal.timeout` alone would leave a live timer behind after a fast response; the
 * returned {@link ScopedSignal.dispose} is what keeps a long-running daemon from accumulating
 * one timer per request.
 *
 * @param timeoutMs - Deadline in milliseconds. Non-positive disables the timeout.
 * @param signal - Optional caller signal to honour as well.
 */
export function scopedSignal(timeoutMs: number, signal?: AbortSignal): ScopedSignal {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal: signal ?? new AbortController().signal, dispose: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  // Do not let a pending request deadline keep the process alive on its own.
  timer.unref?.();

  const onOuterAbort = (): void => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    },
  };
}

/** Standard headers on every outbound request. */
export function baseHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "user-agent": DAEMON_USER_AGENT, ...extra };
}

/**
 * Reads a bounded snippet of a failed response body for inclusion in an error.
 *
 * Never throws: a body that is already consumed, still streaming or not text yields `""`
 * rather than masking the original failure.
 */
export async function errorSnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, ERROR_SNIPPET_BYTES);
  } catch {
    return "";
  }
}

/**
 * Converts a non-2xx response into an {@link UpstreamError} carrying the status and a
 * bounded body snippet.
 */
export async function upstreamErrorFrom(
  label: string,
  res: Response,
  what: string,
): Promise<UpstreamError> {
  const body = await errorSnippet(res);
  const details: Record<string, unknown> = { status: res.status, upstream: label };
  if (body.length > 0) details["body"] = body;
  return new UpstreamError(`${label} ${what} failed with HTTP ${res.status}`, details);
}

/**
 * Wraps a transport-level failure (DNS, refused connection, TLS, timeout) as an
 * {@link UpstreamError}, while letting deliberate aborts propagate unchanged.
 *
 * A caller-initiated abort is not an upstream fault — the gateway hanging up must not be
 * recorded as the node's provider misbehaving.
 */
export function transportError(label: string, what: string, cause: unknown): Error {
  if (isAbort(cause)) return cause as Error;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new UpstreamError(`${label} ${what} failed: ${message}`, { upstream: label });
}

/** True when a thrown value is an abort (either `AbortError` or an aborted-signal reason). */
export function isAbort(cause: unknown): boolean {
  if (cause instanceof Error && cause.name === "AbortError") return true;
  if (typeof cause === "object" && cause !== null && "name" in cause) {
    return (cause as { name?: unknown }).name === "AbortError";
  }
  return false;
}

/** Joins a base URL with a path, tolerating a trailing slash on either side. */
export function joinUrl(base: string, path: string): string {
  const left = base.endsWith("/") ? base.slice(0, -1) : base;
  const right = path.startsWith("/") ? path : `/${path}`;
  return `${left}${right}`;
}
