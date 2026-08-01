import type { ChatCompletionRequest, GatewayConfig, NodeRecord } from "@x402-mesh/shared";
import { assertRoutableEndpoint, NoCapacityError, UpstreamError } from "@x402-mesh/shared";
import type { Logger } from "../logger.js";
import type {
  NodeSelectorPort,
  RouteInput,
  RouteResult,
  RouterPort,
  StreamSink,
} from "../ports.js";
import { withSpan } from "../telemetry/otel.js";

/**
 * Forwards a paid request to a mesh node and streams the answer back.
 *
 * Three things this has to get right, all of which are easy to get subtly wrong:
 *
 * 1. **Health accounting is exact.** `beginRequest` / `endRequest` are paired in a
 *    `try`/`finally` so a thrown error, a timeout or a client disconnect can never leak an
 *    in-flight slot and slowly starve a healthy node out of the rotation. `recordOutcome`
 *    fires on both the success and the failure path.
 * 2. **A hung node cannot leak a socket.** The upstream fetch is driven by an
 *    `AbortController` fed from both the client's disconnect signal and a hard
 *    `nodeRequestTimeoutMs` deadline, so the connection is torn down either way.
 * 3. **Retry only before the first byte.** A failure on the first node is retried against a
 *    *different* node. Once a byte of a stream has reached the client, retrying would splice
 *    two different completions together, so from that point a failure is terminal.
 */

/** Chat completions path appended to a node's advertised endpoint. */
const NODE_CHAT_PATH = "/v1/chat/completions";

/** SSE frame every OpenAI-compatible stream terminates with. */
const DONE_FRAME = "data: [DONE]\n\n";

/** Cap on a buffered (non-streaming) upstream body, guarding against a hostile node. */
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

/** Cap on a streamed body, so an endless SSE stream cannot pin the gateway indefinitely. */
const MAX_STREAM_BODY_BYTES = 64 * 1024 * 1024;

/** Bytes of an upstream error body kept for diagnostics. */
const ERROR_SNIPPET_BYTES = 256;

/** Collaborators {@link HttpNodeRouter} needs. */
export interface RouterDeps {
  config: GatewayConfig;
  selector: NodeSelectorPort;
  logger: Logger;
  /** Injected so tests can stub the upstream without a server. */
  fetchImpl?: typeof fetch;
  /** Time source for latency measurement. */
  now?: () => number;
}

export class HttpNodeRouter implements RouterPort {
  private readonly config: GatewayConfig;
  private readonly selector: NodeSelectorPort;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(deps: RouterDeps) {
    this.config = deps.config;
    this.selector = deps.selector;
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Routes one request, retrying once against a different node.
   *
   * @throws {NoCapacityError} when no eligible node exists.
   * @throws {UpstreamError} when every attempted node failed.
   */
  async route(input: RouteInput): Promise<RouteResult> {
    const tried: string[] = [];
    let lastError: unknown;

    // Wrapping the caller's sink once means "have any bytes reached the client?" is a fact
    // the retry loop can consult, rather than something it has to guess at.
    const sink = input.sink === undefined ? undefined : new TrackedSink(input.sink);
    const attemptInput: RouteInput = sink === undefined ? input : { ...input, sink };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let node: NodeRecord;
      try {
        const selection = await withSpan(
          "gateway.select_node",
          () =>
            Promise.resolve(
              this.selector.select({ model: input.request.model, excludeNodeIds: tried }),
            ),
          { "mesh.model": input.request.model, "mesh.attempt": attempt },
        );
        node = selection.node;
      } catch (error) {
        // Running out of candidates on a retry is expected; the *original* upstream failure
        // is the more useful thing to report, so keep it.
        if (attempt > 1 && lastError !== undefined) break;
        throw error;
      }
      tried.push(node.registration.nodeId);
      input.onNodeSelected?.(node);

      try {
        const result = await this.callNode(node, attemptInput, attempt);
        return { ...result, attempts: attempt };
      } catch (error) {
        lastError = error;
        const fatal = input.signal.aborted || sink?.started === true;
        this.logger.warn(
          {
            requestId: input.requestId,
            nodeId: node.registration.nodeId,
            attempt,
            retryable: !fatal && attempt === 1,
            reason: describe(error),
          },
          "upstream node call failed",
        );
        if (fatal) break;
      }
    }

    if (lastError instanceof NoCapacityError) throw lastError;
    throw new UpstreamError("every candidate node failed to serve the request", {
      requestId: input.requestId,
      triedNodeIds: tried,
      reason: describe(lastError),
    });
  }

  /**
   * Performs one upstream call with full health accounting.
   *
   * The `finally` is load-bearing: `endRequest` must run on every exit path, including the
   * abort and timeout paths, or the node's in-flight counter drifts upward forever.
   */
  private async callNode(
    node: NodeRecord,
    input: RouteInput,
    attempt: number,
  ): Promise<Omit<RouteResult, "attempts">> {
    const nodeId = node.registration.nodeId;
    const startedAt = this.now();

    await this.selector.beginRequest(nodeId);
    try {
      const result = await withSpan("gateway.upstream_call", () => this.performCall(node, input), {
        "mesh.node_id": nodeId,
        "mesh.model": input.request.model,
        "mesh.attempt": attempt,
        "mesh.streaming": input.sink !== undefined,
      });
      const latencyMs = this.now() - startedAt;
      await this.selector.recordOutcome(nodeId, { success: true, latencyMs });
      return { node, latencyMs, ...(result === undefined ? {} : { body: result }) };
    } catch (error) {
      await this.selector.recordOutcome(nodeId, {
        success: false,
        latencyMs: this.now() - startedAt,
        error: describe(error),
      });
      throw error;
    } finally {
      await this.selector.endRequest(nodeId);
    }
  }

  /**
   * Issues the HTTP call and either buffers the JSON body or pumps the SSE stream.
   *
   * @returns The parsed body for a non-streaming call, `undefined` for a streamed one.
   */
  private async performCall(node: NodeRecord, input: RouteInput): Promise<unknown> {
    const url = `${stripTrailingSlash(node.registration.endpoint)}${NODE_CHAT_PATH}`;
    if (input.signal.aborted) {
      // The client is already gone. Opening a socket to a node just to tear it down wastes
      // the node's concurrency slot for a response nobody will read.
      throw new UpstreamError("client disconnected before the request was forwarded", {
        nodeId: node.registration.nodeId,
      });
    }
    // Re-validate at connect time, not just at registration. A hostname that resolved to a
    // public address when the node registered can be re-pointed at 169.254.169.254 or a
    // private service afterwards; only a check here closes that DNS-rebinding window.
    await assertRoutableEndpoint(node.registration.endpoint, {
      allowPrivate: this.config.allowPrivateNodeEndpoints,
    });

    const timeout = AbortSignal.timeout(this.config.nodeRequestTimeoutMs);
    // Whichever fires first wins: a client disconnect or the upstream deadline. Either way
    // fetch tears the socket down rather than leaving it pinned to a hung node.
    const signal = AbortSignal.any([input.signal, timeout]);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: input.sink ? "text/event-stream" : "application/json",
          "x-request-id": input.requestId,
        },
        body: JSON.stringify(forwardBody(input.request)),
        signal,
      });
    } catch (error) {
      throw new UpstreamError(
        timeout.aborted ? "node did not respond before the deadline" : "node request failed",
        {
          nodeId: node.registration.nodeId,
          timeoutMs: this.config.nodeRequestTimeoutMs,
          reason: describe(error),
        },
      );
    }

    if (!response.ok) {
      throw new UpstreamError(`node returned HTTP ${response.status}`, {
        nodeId: node.registration.nodeId,
        status: response.status,
        detail: await readErrorSnippet(response),
      });
    }

    if (input.sink === undefined) {
      return await readJson(response, node.registration.nodeId);
    }
    await pumpStream(response, input.sink, node.registration.nodeId);
    return undefined;
  }
}

/**
 * Copies an SSE body through to the sink without buffering.
 *
 * Chunks are forwarded byte-for-byte, so `data:` frames reach the client exactly as the node
 * emitted them. Only one thing is synthesised: if the node's stream ends without the
 * terminating `data: [DONE]` frame, it is appended — an OpenAI-compatible client waits for
 * that frame and would otherwise hang until its own timeout.
 */
async function pumpStream(response: Response, sink: StreamSink, nodeId: string): Promise<void> {
  const body = response.body;
  if (body === null) {
    throw new UpstreamError("node returned a streaming response with no body", { nodeId });
  }

  sink.begin(response.headers.get("content-type") ?? "text/event-stream");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // Only the tail matters for the [DONE] check, and a frame is short; keeping a bounded
  // window avoids accumulating the whole completion in memory just to inspect its end.
  let tail = "";

  let forwarded = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      forwarded += value.byteLength;
      if (forwarded > MAX_STREAM_BODY_BYTES) {
        // A node that never stops emitting would otherwise hold this connection, its
        // concurrency slot and the client's socket open forever. Bytes already sent cannot be
        // recalled, so terminate the stream cleanly rather than erroring mid-completion.
        break;
      }
      sink.write(value);
      tail = (tail + decoder.decode(value, { stream: true })).slice(-64);
    }
    if (!tail.includes("[DONE]")) {
      sink.write(new TextEncoder().encode(DONE_FRAME));
    }
  } finally {
    // Release the upstream socket even if the client vanished mid-stream.
    reader.cancel().catch(() => undefined);
    sink.end();
  }
}

/**
 * Reads at most `limit` bytes from a response, tearing the socket down the moment the cap is
 * passed.
 *
 * `await response.text()` would resolve the *entire* body into memory before any size check
 * could run, so a hostile node advertising a 20 GB response would exhaust the gateway's heap
 * even though the result is destined to be rejected. Counting as chunks arrive and cancelling
 * the reader makes the cap actually protective rather than merely descriptive.
 *
 * @param response - The upstream response.
 * @param limit - Maximum number of bytes to accept.
 * @returns The decoded body, and whether the cap was exceeded.
 */
async function readBounded(
  response: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (body === null) return { text: "", truncated: false };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      received += value.byteLength;
      if (received > limit) return { text, truncated: true };
      text += decoder.decode(value, { stream: true });
    }
    return { text: text + decoder.decode(), truncated: false };
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** Reads and parses a bounded JSON body. */
async function readJson(response: Response, nodeId: string): Promise<unknown> {
  const { text, truncated } = await readBounded(response, MAX_JSON_BODY_BYTES);
  if (truncated) {
    throw new UpstreamError("node response exceeded the maximum body size", {
      nodeId,
      maxBytes: MAX_JSON_BODY_BYTES,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError("node returned a body that is not valid JSON", { nodeId });
  }
}

/**
 * Best-effort short excerpt of an error body, for diagnostics. Never throws.
 *
 * Bounded for the same reason as {@link readJson}: slicing after `response.text()` would
 * still have buffered the whole body first, so a hostile node could exhaust memory purely by
 * failing loudly.
 */
async function readErrorSnippet(response: Response): Promise<string> {
  try {
    const { text } = await readBounded(response, ERROR_SNIPPET_BYTES);
    return text.slice(0, ERROR_SNIPPET_BYTES);
  } catch {
    return "";
  }
}

/**
 * Projects the validated request onto exactly the fields forwarded upstream.
 *
 * Zod strips unknown keys, but building the outbound body explicitly means a future schema
 * change cannot start silently proxying a new field to third-party nodes.
 */
function forwardBody(request: ChatCompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
  };
  if (request.stream !== undefined) body["stream"] = request.stream;
  if (request.max_tokens !== undefined) body["max_tokens"] = request.max_tokens;
  if (request.temperature !== undefined) body["temperature"] = request.temperature;
  if (request.top_p !== undefined) body["top_p"] = request.top_p;
  if (request.stop !== undefined) body["stop"] = request.stop;
  return body;
}

/**
 * Sink decorator that remembers whether the stream has been opened.
 *
 * Once `begin` has run the client is committed to this node's response, so the router must
 * not fail over — hence the flag rather than a best guess. `end` is idempotent so the
 * `finally` in {@link pumpStream} cannot double-terminate a response.
 */
class TrackedSink implements StreamSink {
  /** True once the response has been opened towards the client. */
  started = false;
  private ended = false;

  constructor(private readonly inner: StreamSink) {}

  begin(contentType: string): void {
    if (this.started) return;
    this.started = true;
    this.inner.begin(contentType);
  }

  write(chunk: Uint8Array): void {
    this.inner.write(chunk);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.inner.end();
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.replace(/\/+$/, "") : url;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
