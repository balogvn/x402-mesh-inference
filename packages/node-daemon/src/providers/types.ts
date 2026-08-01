import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "@x402-mesh/shared";
import type { FetchLike } from "../http.js";

/**
 * The inference backend a node daemon drives.
 *
 * Implementations are thin adapters over a local model server. They never decide *whether*
 * to serve a request (that is the semaphore's job) and never touch payment state — they only
 * translate between the mesh's OpenAI-compatible wire types and whatever the backend speaks.
 *
 * Every method maps backend failures to `UpstreamError` from `@x402-mesh/shared`, except
 * {@link InferenceProvider.health} which reports failure as `false`.
 */
export interface InferenceProvider {
  /** Stable identifier for logs and diagnostics, e.g. `"ollama"`. */
  readonly name: string;

  /** Base URL the adapter talks to. Safe to log; contains no credentials. */
  readonly baseUrl: string;

  /**
   * Lists the models the backend currently has loaded or available.
   *
   * @throws {UpstreamError} if the backend is unreachable or answers unusably.
   */
  listModels(): Promise<string[]>;

  /**
   * Runs a non-streaming completion.
   *
   * @param req - Validated OpenAI-compatible request. `stream` is ignored.
   * @param signal - Aborts the upstream call when the gateway hangs up.
   * @throws {UpstreamError} on transport failure, a non-2xx status or an unparseable body.
   */
  chat(req: ChatCompletionRequest, signal: AbortSignal): Promise<ChatCompletionResponse>;

  /**
   * Runs a streaming completion, yielding one chunk per SSE frame.
   *
   * The iterable completes at the backend's `[DONE]` sentinel. Abandoning it early (via
   * `break` or `return`) aborts the upstream request rather than leaking the connection.
   *
   * @param req - Validated OpenAI-compatible request. `stream` is forced to `true`.
   * @param signal - Aborts the upstream call when the gateway hangs up.
   * @throws {UpstreamError} on transport failure, a non-2xx status or a malformed frame.
   */
  chatStream(req: ChatCompletionRequest, signal: AbortSignal): AsyncIterable<ChatCompletionChunk>;

  /**
   * Cheap liveness probe. Never throws — an unreachable backend is `false`, which is exactly
   * what the heartbeat needs to report.
   */
  health(): Promise<boolean>;
}

/** Construction options common to every provider adapter. */
export interface ProviderOptions {
  /** Backend base URL, without a trailing slash. */
  baseUrl: string;
  /** Injected `fetch`; defaults to the global. Tests always pass a stub. */
  fetchImpl?: FetchLike;
  /** Deadline for a single inference call, in milliseconds. */
  requestTimeoutMs?: number;
  /** Deadline for control-plane calls (model listing, health), in milliseconds. */
  controlTimeoutMs?: number;
  /** Optional bearer token, for backends deployed behind an auth proxy. Never logged. */
  apiKey?: string;
}
