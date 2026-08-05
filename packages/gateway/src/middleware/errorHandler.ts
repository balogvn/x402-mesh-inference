import { MeshError, ValidationError, toErrorResponse } from "@x402-mesh/shared";
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
/**
 * Converts `express.json()`'s throws into the client errors they actually are.
 *
 * A malformed JSON body, a body over the size limit, or an unsupported charset are all the
 * *caller's* mistake, but body-parser signals them with a plain `Error` carrying an HTTP
 * status property. `toErrorResponse` sees an unrecognized throwable and collapses it to an
 * opaque 500 — so a client sending a truncated body was told the server had broken, was
 * logged as a server fault, and got no hint about what to fix. It also inflates any
 * error-rate alarm with traffic that is working exactly as designed.
 *
 * Anything that is not a body-parser error passes through untouched.
 */
function normalizeBodyParserError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof MeshError) return error;
  const status = (error as { status?: unknown; statusCode?: unknown }).status;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  const code =
    typeof status === "number" ? status : typeof statusCode === "number" ? statusCode : 0;
  if (code < 400 || code >= 500) return error;

  const type = (error as { type?: unknown }).type;
  if (code === 413) {
    // 413, not 400. "Your body is malformed" and "your body is too big" call for different
    // fixes, and a client that batched too many messages needs to be told to send fewer —
    // which the limit in `details` lets it do without guessing.
    return new MeshError("request body is too large", "payload_too_large", 413, {
      limit: MAX_BODY_HINT,
    });
  }
  return new ValidationError(
    typeof type === "string" && type === "entity.parse.failed"
      ? "request body is not valid JSON"
      : "request body could not be read",
  );
}

/** Echoed back on a 413 so the caller learns the ceiling rather than guessing. */
const MAX_BODY_HINT = "1mb";

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    const requestId = getRequestId(req);
    const { status, body } = toErrorResponse(normalizeBodyParserError(error));

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
