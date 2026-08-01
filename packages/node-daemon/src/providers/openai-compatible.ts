import {
  ChatCompletionChunkSchema,
  ChatCompletionResponseSchema,
  UpstreamError,
  parseOrThrow,
} from "@x402-mesh/shared";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "@x402-mesh/shared";
import {
  DEFAULT_CONTROL_TIMEOUT_MS,
  baseHeaders,
  joinUrl,
  scopedSignal,
  transportError,
  upstreamErrorFrom,
} from "../http.js";
import type { FetchLike } from "../http.js";
import { iterateSseJson } from "../sse.js";
import type { InferenceProvider, ProviderOptions } from "./types.js";

/** Default deadline for a single inference call: generation on a busy GPU is slow. */
export const DEFAULT_INFERENCE_TIMEOUT_MS = 120_000;

/**
 * Base adapter for any backend that speaks the OpenAI chat-completions API.
 *
 * Ollama and vLLM differ only in where they expose the API prefix and how they enumerate
 * models, so the request shaping, SSE handling, response normalization and error mapping all
 * live here. Subclasses override {@link listModels} and, if needed, {@link health}.
 */
export abstract class OpenAiCompatibleProvider implements InferenceProvider {
  abstract readonly name: string;

  readonly baseUrl: string;

  protected readonly fetchImpl: FetchLike;
  protected readonly requestTimeoutMs: number;
  protected readonly controlTimeoutMs: number;
  private readonly apiKey: string | undefined;

  /**
   * @param options - Backend location and timeouts.
   * @param apiPrefix - Path segment the chat API hangs off, e.g. `"/v1"`.
   */
  protected constructor(
    options: ProviderOptions,
    protected readonly apiPrefix: string,
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS;
    this.controlTimeoutMs = options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.apiKey = options.apiKey;
  }

  abstract listModels(): Promise<string[]>;

  /** Absolute URL of the chat-completions endpoint. */
  protected get chatUrl(): string {
    return joinUrl(this.baseUrl, `${this.apiPrefix}/chat/completions`);
  }

  /**
   * Request headers. The bearer token, when configured, is attached here and nowhere else so
   * it cannot reach a log line via a spread of the options object.
   */
  protected headers(extra?: Record<string, string>): Record<string, string> {
    const headers = baseHeaders(extra);
    if (this.apiKey !== undefined) headers["authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }

  async chat(req: ChatCompletionRequest, signal: AbortSignal): Promise<ChatCompletionResponse> {
    const scope = scopedSignal(this.requestTimeoutMs, signal);
    try {
      const res = await this.postChat({ ...req, stream: false }, scope.signal);
      if (!res.ok) throw await upstreamErrorFrom(this.name, res, "chat completion");

      let body: unknown;
      try {
        body = await res.json();
      } catch (cause) {
        throw new UpstreamError(`${this.name} returned a non-JSON completion`, {
          upstream: this.name,
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      }
      return normalizeCompletion(body, req.model, this.name);
    } finally {
      scope.dispose();
    }
  }

  async *chatStream(
    req: ChatCompletionRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const scope = scopedSignal(this.requestTimeoutMs, signal);
    try {
      const res = await this.postChat({ ...req, stream: true }, scope.signal);
      if (!res.ok) throw await upstreamErrorFrom(this.name, res, "streaming chat completion");
      if (!res.body) {
        throw new UpstreamError(`${this.name} returned a streaming response with no body`, {
          upstream: this.name,
        });
      }
      for await (const frame of iterateSseJson<unknown>(res.body, this.name)) {
        yield normalizeChunk(frame, req.model, this.name);
      }
    } catch (cause) {
      throw asProviderError(this.name, "streaming chat completion", cause);
    } finally {
      // Runs on `return`/`break` at the consumer too, so abandoning the iterator tears the
      // upstream connection down instead of leaking it for the full request timeout.
      scope.dispose();
    }
  }

  async health(): Promise<boolean> {
    try {
      const models = await this.listModels();
      return Array.isArray(models);
    } catch {
      return false;
    }
  }

  /** Issues the POST, mapping transport failures to `UpstreamError`. */
  private async postChat(body: ChatCompletionRequest, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(this.chatUrl, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json", accept: "text/event-stream" }),
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      throw transportError(this.name, "chat completion", cause);
    }
  }

  /**
   * GETs a control-plane URL and parses JSON, mapping every failure mode to `UpstreamError`.
   *
   * Shared by the subclasses' model-listing implementations.
   */
  protected async getJson(url: string, what: string): Promise<unknown> {
    const scope = scopedSignal(this.controlTimeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: this.headers({ accept: "application/json" }),
          signal: scope.signal,
        });
      } catch (cause) {
        throw transportError(this.name, what, cause);
      }
      if (!res.ok) throw await upstreamErrorFrom(this.name, res, what);
      try {
        return await res.json();
      } catch {
        throw new UpstreamError(`${this.name} returned a non-JSON ${what} response`, {
          upstream: this.name,
        });
      }
    } finally {
      scope.dispose();
    }
  }
}

/**
 * Re-raises anything thrown inside a provider call as an `UpstreamError`, leaving deliberate
 * aborts and already-classified mesh errors alone.
 */
function asProviderError(label: string, what: string, cause: unknown): unknown {
  if (cause instanceof UpstreamError) return cause;
  return transportError(label, what, cause);
}

/**
 * Coerces a backend completion into the mesh's `ChatCompletionResponse`.
 *
 * Backends are inconsistent about the optional bits: some omit `usage` entirely, some send
 * `total_tokens` but not its parts, some return `content: null` for a tool-only turn, and
 * Ollama omits `created` on occasion. Filling these in here — rather than loosening the
 * schema — keeps the gateway's contract exact while still accepting real-world servers.
 *
 * @throws {UpstreamError} if the body is still unusable after normalization.
 */
export function normalizeCompletion(
  body: unknown,
  requestedModel: string,
  label: string,
): ChatCompletionResponse {
  if (typeof body !== "object" || body === null) {
    throw new UpstreamError(`${label} returned a completion that is not an object`, {
      upstream: label,
    });
  }
  const raw = body as Record<string, unknown>;
  const candidate = {
    id: asNonEmptyString(raw["id"]) ?? `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: asEpochSeconds(raw["created"]),
    model: asNonEmptyString(raw["model"]) ?? requestedModel,
    choices: normalizeChoices(raw["choices"]),
    usage: normalizeUsage(raw["usage"]),
  };

  try {
    return parseOrThrow(ChatCompletionResponseSchema, candidate, "chat completion");
  } catch (cause) {
    throw new UpstreamError(`${label} returned an unusable completion`, {
      upstream: label,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * Coerces one streamed frame into the mesh's `ChatCompletionChunk`.
 *
 * @throws {UpstreamError} if the frame cannot be made to fit the contract.
 */
export function normalizeChunk(
  frame: unknown,
  requestedModel: string,
  label: string,
): ChatCompletionChunk {
  if (typeof frame !== "object" || frame === null) {
    throw new UpstreamError(`${label} sent a stream frame that is not an object`, {
      upstream: label,
    });
  }
  const raw = frame as Record<string, unknown>;
  // Some backends surface mid-stream failures as `{ "error": { ... } }` with HTTP 200.
  const embedded = raw["error"];
  if (embedded !== undefined && embedded !== null) {
    throw new UpstreamError(`${label} reported an error mid-stream`, {
      upstream: label,
      detail: typeof embedded === "string" ? embedded : JSON.stringify(embedded).slice(0, 200),
    });
  }

  const candidate = {
    id: asNonEmptyString(raw["id"]) ?? `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion.chunk",
    created: asEpochSeconds(raw["created"]),
    model: asNonEmptyString(raw["model"]) ?? requestedModel,
    choices: normalizeChunkChoices(raw["choices"]),
  };

  try {
    return parseOrThrow(ChatCompletionChunkSchema, candidate, "chat completion chunk");
  } catch (cause) {
    throw new UpstreamError(`${label} sent an unusable stream frame`, {
      upstream: label,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Non-negative integer coercion; anything else becomes `undefined`. */
function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** `created` is unix *seconds* in the OpenAI contract; fall back to now when absent. */
function asEpochSeconds(value: unknown): number {
  return asCount(value) ?? Math.floor(Date.now() / 1000);
}

function normalizeRole(value: unknown): "system" | "user" | "assistant" {
  return value === "system" || value === "user" ? value : "assistant";
}

function normalizeChoices(value: unknown): unknown[] {
  const list = Array.isArray(value) ? value : [];
  return list.map((entry, index) => {
    const raw = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const message = (
      typeof raw["message"] === "object" && raw["message"] !== null ? raw["message"] : {}
    ) as Record<string, unknown>;
    return {
      index: asCount(raw["index"]) ?? index,
      message: {
        role: normalizeRole(message["role"]),
        // `content: null` is legal upstream but meaningless to a text relay; flatten to "".
        content: typeof message["content"] === "string" ? message["content"] : "",
      },
      finish_reason: typeof raw["finish_reason"] === "string" ? raw["finish_reason"] : null,
    };
  });
}

function normalizeChunkChoices(value: unknown): unknown[] {
  const list = Array.isArray(value) ? value : [];
  return list.map((entry, index) => {
    const raw = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const rawDelta = (
      typeof raw["delta"] === "object" && raw["delta"] !== null ? raw["delta"] : {}
    ) as Record<string, unknown>;
    const delta: Record<string, unknown> = {};
    if (typeof rawDelta["role"] === "string") delta["role"] = normalizeRole(rawDelta["role"]);
    if (typeof rawDelta["content"] === "string") delta["content"] = rawDelta["content"];
    return {
      index: asCount(raw["index"]) ?? index,
      delta,
      finish_reason: typeof raw["finish_reason"] === "string" ? raw["finish_reason"] : null,
    };
  });
}

/**
 * Fills in a usage block.
 *
 * Token counts are integers, not money, so ordinary arithmetic is fine here — but they are
 * still derived rather than guessed: `total` is recomputed from its parts when absent, and
 * the parts are back-filled from `total` when only the total is reported.
 */
function normalizeUsage(value: unknown): unknown {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const prompt = asCount(raw["prompt_tokens"]);
  const completion = asCount(raw["completion_tokens"]);
  const total = asCount(raw["total_tokens"]);

  if (prompt !== undefined && completion !== undefined) {
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total ?? prompt + completion,
    };
  }
  if (total !== undefined) {
    return {
      prompt_tokens: prompt ?? Math.max(0, total - (completion ?? 0)),
      completion_tokens: completion ?? Math.max(0, total - (prompt ?? 0)),
      total_tokens: total,
    };
  }
  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: (prompt ?? 0) + (completion ?? 0),
  };
}
