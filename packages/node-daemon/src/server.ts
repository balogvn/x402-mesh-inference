import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  ChatCompletionRequestSchema,
  MeshError,
  ValidationError,
  parseOrThrow,
  toErrorResponse,
} from "@x402-mesh/shared";
import type { ChatCompletionChunk, ChatCompletionRequest } from "@x402-mesh/shared";
import type { InferenceProvider } from "./providers/index.js";
import { Semaphore } from "./semaphore.js";
import { SSE_DONE } from "./sse.js";
import { DAEMON_VERSION } from "./version.js";

/** Default listen port when neither the CLI nor the advertised endpoint names one. */
export const DEFAULT_NODE_PORT = 8403;

/** Maximum accepted request body. A completion request is small; anything larger is abuse. */
const MAX_BODY_BYTES = 1_048_576;

/** How long a provider health probe is reused before `GET /health` re-runs it. */
const HEALTH_CACHE_MS = 5_000;

/** Options for {@link NodeServer}. */
export interface NodeServerOptions {
  provider: InferenceProvider;
  /** Concurrency ceiling; requests beyond it are refused with 503. */
  maxConcurrency: number;
  /** Node id echoed in `/health`, for operator sanity-checking. */
  nodeId: string;
  /** Models this node advertises, echoed in `/health`. */
  models: string[];
  /** Listen port. Defaults to {@link DEFAULT_NODE_PORT}. */
  port?: number;
  /** Listen host. Defaults to `0.0.0.0`. */
  host?: string;
  /**
   * Optional shared secret the gateway must present as `Authorization: Bearer <token>`.
   *
   * Off by default because a node is normally reachable only from the gateway; set it when
   * the node's endpoint is exposed to the internet. Compared in constant time. Never logged.
   */
  authToken?: string;
  /** Structured log sink. Defaults to no logging. */
  log?: (event: Record<string, unknown>) => void;
}

/** Load figures the heartbeat samples from a running server. */
export interface ServerLoad {
  inFlight: number;
  maxConcurrency: number;
}

/**
 * The node's inference endpoint.
 *
 * Exposes exactly two routes:
 *
 * - `POST /infer` — what the gateway forwards a paid request to. Accepts an OpenAI-compatible
 *   chat-completion body; answers with JSON, or with an SSE stream when `stream: true`.
 * - `GET /health` — liveness and load, used by the gateway's probes and by `doctor`.
 *
 * Admission control lives here rather than in the provider: the semaphore is checked before
 * the request is parsed or forwarded, and saturation answers **503 with `Retry-After`** so
 * the gateway can immediately route to another node instead of queueing behind a busy GPU.
 */
export class NodeServer {
  private readonly options: NodeServerOptions;
  private readonly semaphore: Semaphore;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private cachedHealth: { healthy: boolean; at: number } | null = null;
  private listening = false;

  constructor(options: NodeServerOptions) {
    this.options = options;
    this.semaphore = new Semaphore(options.maxConcurrency);
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    // Track sockets so `close()` can terminate idle keep-alive connections instead of
    // waiting for the client to hang up.
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  /** Current load, for the heartbeat snapshot. */
  get load(): ServerLoad {
    return { inFlight: this.semaphore.inFlight, maxConcurrency: this.semaphore.permits };
  }

  /** Port the server is bound to. Only meaningful after {@link listen} resolves. */
  get port(): number {
    const address = this.server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  /**
   * Binds and starts accepting requests.
   *
   * @returns The bound port, which differs from the configured one when port 0 was requested.
   */
  listen(): Promise<number> {
    const port = this.options.port ?? DEFAULT_NODE_PORT;
    const host = this.options.host ?? "0.0.0.0";
    return new Promise((resolve, reject) => {
      const onError = (cause: Error): void => reject(cause);
      this.server.once("error", onError);
      this.server.listen(port, host, () => {
        this.server.removeListener("error", onError);
        this.listening = true;
        resolve(this.port);
      });
    });
  }

  /** Stops accepting requests and destroys lingering keep-alive sockets. */
  close(): Promise<void> {
    if (!this.listening) return Promise.resolve();
    this.listening = false;
    return new Promise((resolve, reject) => {
      this.server.close((cause) => (cause ? reject(cause) : resolve()));
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
  }

  /**
   * Reports whether the inference backend is reachable, reusing a recent probe.
   *
   * The gateway may poll `/health` far more often than the backend deserves to be probed, and
   * the heartbeat calls this too; a 5 s cache keeps that from turning liveness checks into
   * load.
   */
  async healthy(): Promise<boolean> {
    const now = Date.now();
    if (this.cachedHealth && now - this.cachedHealth.at < HEALTH_CACHE_MS) {
      return this.cachedHealth.healthy;
    }
    const healthy = await this.options.provider.health();
    this.cachedHealth = { healthy, at: now };
    return healthy;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = headerValue(req, "x-request-id") ?? randomUUID();
    res.setHeader("x-request-id", requestId);

    try {
      const url = req.url ?? "/";
      const path = url.split("?", 1)[0] ?? "/";

      if (path === "/health") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { error: { code: "method_not_allowed", message: "use GET /health" } });
          return;
        }
        await this.handleHealth(res);
        return;
      }

      // `/v1/chat/completions` is the path the GATEWAY calls (see NODE_CHAT_PATH in
      // packages/gateway/src/services/router.ts) and the one an OpenAI-compatible client
      // expects. It has to be served here or no paid request can ever reach this node.
      //
      // The daemon originally served only `/infer`, so the gateway's routed request got a
      // 404 and every paid request died with `upstream_error: node returned HTTP 404`. No
      // test caught it: the mock node in scripts/lib/mock-node.ts serves
      // `/v1/chat/completions`, matching the gateway, so the suite exercised a contract the
      // real daemon did not implement. `/infer` stays as an alias so anything already
      // pointed at it keeps working.
      if (path === "/v1/chat/completions" || path === "/infer") {
        if (req.method !== "POST") {
          sendJson(res, 405, {
            error: { code: "method_not_allowed", message: `use POST ${path}` },
          });
          return;
        }
        await this.handleInfer(req, res, requestId);
        return;
      }

      sendJson(res, 404, { error: { code: "not_found", message: `no route for ${path}` } });
    } catch (cause) {
      this.options.log?.({ level: "error", msg: "unhandled request failure", requestId });
      const { status, body } = toErrorResponse(cause);
      sendJson(res, status, body);
    }
  }

  private async handleHealth(res: ServerResponse): Promise<void> {
    const healthy = await this.healthy();
    sendJson(res, healthy ? 200 : 503, {
      status: healthy ? "ok" : "degraded",
      nodeId: this.options.nodeId,
      version: DAEMON_VERSION,
      provider: this.options.provider.name,
      models: this.options.models,
      inFlight: this.semaphore.inFlight,
      maxConcurrency: this.semaphore.permits,
      available: this.semaphore.available,
    });
  }

  private async handleInfer(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
  ): Promise<void> {
    if (!this.authorized(req)) {
      sendJson(res, 401, {
        error: { code: "auth_error", message: "missing or invalid bearer token" },
      });
      return;
    }

    // Admission control first: refusing early is the whole point of the 503 contract, and it
    // keeps a saturated node from spending CPU parsing work it will not run.
    const release = this.semaphore.tryAcquire();
    if (!release) {
      res.setHeader("retry-after", "1");
      sendJson(res, 503, {
        error: {
          code: "no_capacity",
          message: "node is at maximum concurrency",
          details: {
            inFlight: this.semaphore.inFlight,
            maxConcurrency: this.semaphore.permits,
          },
        },
      });
      return;
    }

    const controller = new AbortController();
    // The gateway hanging up must tear down the upstream generation, not leave the GPU busy
    // producing tokens nobody will read.
    const onClose = (): void => controller.abort(new Error("client disconnected"));
    res.on("close", onClose);

    const startedAt = Date.now();
    try {
      const raw = await readJsonBody(req);
      const request = parseOrThrow(ChatCompletionRequestSchema, raw, "chat completion request");
      if (request.stream === true) {
        await this.streamCompletion(request, res, controller.signal, requestId);
      } else {
        const completion = await this.options.provider.chat(request, controller.signal);
        sendJson(res, 200, completion);
      }
      this.options.log?.({
        level: "info",
        msg: "inference served",
        requestId,
        model: request.model,
        stream: request.stream === true,
        durationMs: Date.now() - startedAt,
      });
    } catch (cause) {
      this.failInfer(res, cause, requestId, Date.now() - startedAt);
    } finally {
      res.removeListener("close", onClose);
      release();
    }
  }

  /**
   * Streams completion chunks as SSE.
   *
   * Chunks are re-serialized rather than byte-forwarded: the provider layer has already
   * normalized every backend's quirks into `ChatCompletionChunk`, so the gateway receives one
   * shape no matter what the operator runs locally.
   */
  private async streamCompletion(
    request: ChatCompletionRequest,
    res: ServerResponse,
    signal: AbortSignal,
    requestId: string,
  ): Promise<void> {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Defeats proxy buffering, which would otherwise defeat the point of streaming.
      "x-accel-buffering": "no",
      "x-request-id": requestId,
    });

    let wroteAny = false;
    try {
      for await (const chunk of this.options.provider.chatStream(request, signal)) {
        if (res.writableEnded) break;
        writeSseData(res, JSON.stringify(chunk satisfies ChatCompletionChunk));
        wroteAny = true;
      }
      if (!res.writableEnded) {
        writeSseData(res, SSE_DONE);
        res.end();
      }
    } catch (cause) {
      if (res.writableEnded) return;
      // Headers are already sent, so the failure has to travel in-band. An SSE consumer that
      // sees `event: error` knows the stream ended abnormally; silently ending would look
      // like a successful, truncated completion.
      const { body } = toErrorResponse(cause);
      res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
      writeSseData(res, SSE_DONE);
      res.end();
      this.options.log?.({
        level: "error",
        msg: "streaming inference failed",
        requestId,
        wroteAny,
        code: cause instanceof MeshError ? cause.code : "internal_error",
      });
    }
  }

  private failInfer(res: ServerResponse, cause: unknown, requestId: string, ms: number): void {
    if (res.headersSent || res.writableEnded) return;
    const { status, body } = toErrorResponse(cause);
    this.options.log?.({
      level: "error",
      msg: "inference failed",
      requestId,
      status,
      durationMs: ms,
      code: cause instanceof MeshError ? cause.code : "internal_error",
    });
    sendJson(res, status, body);
  }

  /** Constant-time bearer check. Always true when no token is configured. */
  private authorized(req: IncomingMessage): boolean {
    const expected = this.options.authToken;
    if (expected === undefined) return true;
    const header = headerValue(req, "authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(presented, "utf8");
    const b = Buffer.from(expected, "utf8");
    // `timingSafeEqual` throws on unequal lengths, which would itself leak the length.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload).toString(10),
  });
  res.end(payload);
}

function writeSseData(res: ServerResponse, data: string): void {
  res.write(`data: ${data}\n\n`);
}

/**
 * Reads and JSON-parses a request body, refusing anything over {@link MAX_BODY_BYTES}.
 *
 * The size check runs per chunk, so an oversized body is rejected while it is still arriving
 * rather than after it has been buffered in full.
 *
 * @throws {ValidationError} on an oversized or malformed body.
 */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      // Stop reading; the peer gets the error response we are about to write.
      req.resume();
      reject(error);
    };

    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new ValidationError("request body is too large", { maxBytes: MAX_BODY_BYTES }));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim().length === 0) {
        reject(new ValidationError("request body is empty"));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ValidationError("request body is not valid JSON"));
      }
    }

    function onError(cause: Error): void {
      fail(new ValidationError(`could not read request body: ${cause.message}`));
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
