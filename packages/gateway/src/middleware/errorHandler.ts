import { MeshError, toErrorResponse } from "@x402-mesh/shared";
import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import type { Logger } from "../logger.js";
import { getRequestId } from "./requestId.js";

/**
 * Terminal Express error handler.
 *
 * `toErrorResponse` decides what the client sees: a {@link MeshError} speaks for itself,
 * anything else collapses to an opaque 500. Stacks are logged, never serialized — an
 * unexpected throwable's message can embed filesystem paths or connection strings.
 *
 * @param logger - Where the full error is recorded.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    const requestId = getRequestId(req);
    const { status, body } = toErrorResponse(error);

    // Express cannot rewrite a response whose headers are already on the wire (a streamed
    // SSE body, typically). Destroying the socket is the only honest signal left.
    if (res.headersSent) {
      logger.error(
        { requestId, status, phase: "after-headers", reason: summarize(error) },
        "request failed after response started",
      );
      res.end();
      return;
    }

    if (status >= 500) {
      logger.error(
        { requestId, status, reason: summarize(error), stack: stackOf(error) },
        "request failed",
      );
    } else {
      logger.warn({ requestId, status, reason: summarize(error) }, "request rejected");
    }

    res.status(status).json(body);
    // `next` is unused but must stay in the signature: Express identifies error handlers by
    // arity, and dropping the parameter silently turns this into an ordinary middleware.
    void next;
  };
}

/** Short, client-safe description used for log lines only. */
function summarize(error: unknown): string {
  if (error instanceof MeshError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function stackOf(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
