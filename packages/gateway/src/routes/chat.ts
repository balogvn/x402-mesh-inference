import type { GatewayConfig } from "@x402-mesh/shared";
import { ChatCompletionRequestSchema, parseOrThrow } from "@x402-mesh/shared";
import { Router } from "express";
import type { Request, Response } from "express";
import type { Logger } from "../logger.js";
import { getRequestId } from "../middleware/requestId.js";
import type { RouterPort, SettlementServicePort, StreamSink } from "../ports.js";
import { PAID_ROUTE_PATH } from "../x402/routes.js";

/**
 * `POST /v1/chat/completions` — the one paid route.
 *
 * By the time this handler runs the x402 middleware has already verified payment; settlement
 * happens after the handler returns. The handler's jobs are therefore: validate, route, and
 * leave behind enough information for the settlement hook to pay the right operator.
 *
 * The node id is echoed as `x-mesh-node-id`, which is not merely diagnostic — the x402
 * middleware passes the response headers into the settlement hook, so that header plus
 * `x-request-id` is how the payout leg learns which operator earned the money.
 */

/** Header carrying the node that served the request. */
export const NODE_ID_HEADER = "x-mesh-node-id";

/** Header carrying the router's selection rationale, for debugging a routing decision. */
export const ROUTE_REASON_HEADER = "x-mesh-route-reason";

/** Collaborators the chat route needs. */
export interface ChatRouteDeps {
  config: GatewayConfig;
  router: RouterPort;
  settlement: SettlementServicePort;
  logger: Logger;
}

/** Builds the router that serves the paid completion endpoint. */
export function createChatRouter(deps: ChatRouteDeps): Router {
  const router = Router();

  router.post(PAID_ROUTE_PATH, (req: Request, res: Response, next) => {
    handleChat(deps, req, res).catch(next);
  });

  return router;
}

async function handleChat(deps: ChatRouteDeps, req: Request, res: Response): Promise<void> {
  const requestId = getRequestId(req);
  const request = parseOrThrow(ChatCompletionRequestSchema, req.body, "chat completion request");

  // One controller for the whole request. A client that hangs up mid-inference aborts the
  // upstream fetch, so a slow node cannot keep a socket (and a concurrency slot) pinned.
  //
  // Disconnect is detected on the *response*, not the request. In current Node the request
  // stream emits `close` as soon as its body has been consumed — for a JSON POST that is
  // before the handler even runs — so `req.on("close")` fires on every healthy request and
  // using it here would abort every upstream call instantly. The response emits `close`
  // exactly once, either when it finished or when the socket died, and `writableEnded`
  // distinguishes the two. Verified against both a normal completion and a destroyed socket.
  const controller = new AbortController();
  const onClose = (): void => {
    if (res.writableEnded) return;
    controller.abort(new Error("client disconnected"));
  };
  res.on("close", onClose);

  const streaming = request.stream === true;
  const sink = streaming ? createResponseSink(res) : undefined;

  try {
    const result = await deps.router.route({
      requestId,
      request,
      signal: controller.signal,
      ...(sink === undefined ? {} : { sink }),
      // Fires before any bytes move — the last safe moment to set headers on a stream, and
      // where the settlement routing note is written so a retry onto a second node
      // re-points the payout at whoever actually serves.
      onNodeSelected: (node) => {
        res.setHeader(NODE_ID_HEADER, node.registration.nodeId);
        deps.settlement.recordRouting(
          requestId,
          node.registration.nodeId,
          node.registration.operatorAddress,
        );
      },
    });

    deps.logger.info(
      {
        requestId,
        nodeId: result.node.registration.nodeId,
        model: request.model,
        streaming,
        attempts: result.attempts,
        latencyMs: result.latencyMs,
      },
      "request served",
    );

    if (streaming) {
      // Headers and body were already written by the sink; nothing left to send.
      return;
    }

    res.setHeader(ROUTE_REASON_HEADER, `attempts=${result.attempts} latency=${result.latencyMs}ms`);
    res.status(200).json(result.body);
  } finally {
    res.off("close", onClose);
  }
}

/**
 * Adapts an Express response into a {@link StreamSink} that does not buffer.
 *
 * `flushHeaders()` pushes the status line and headers out before the first chunk, so a
 * client sees the stream open immediately instead of waiting for Node's write buffer.
 * `X-Accel-Buffering: no` asks an intermediary nginx not to re-buffer what we just took care
 * to un-buffer, and no compression middleware is mounted on this path for the same reason.
 *
 * Note: when the x402 payment middleware guards this route it buffers the handler's writes
 * until the inbound payment settles, then replays them. That is the SDK's atomicity
 * guarantee — the client is never billed for bytes it did not receive — and it means the
 * observable stream begins after settlement rather than before it. Everything here is still
 * required: it is what makes the replayed stream flow through unbuffered, and it is exactly
 * how the route behaves for any deployment that fronts settlement differently.
 */
export function createResponseSink(res: Response): StreamSink {
  return {
    begin(contentType: string): void {
      res.status(200);
      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders();
    },
    write(chunk: Uint8Array): void {
      if (res.writableEnded) return;
      res.write(chunk);
    },
    end(): void {
      if (res.writableEnded) return;
      res.end();
    },
  };
}
