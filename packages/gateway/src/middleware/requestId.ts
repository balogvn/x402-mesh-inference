import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Header the request id is echoed on, both to the client and into settlement bookkeeping. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Property the id is stashed under on the Express request.
 *
 * A symbol would be tidier, but the value has to survive being read from
 * `res.getHeaders()` inside the x402 settlement hook, so the header is the real carrier and
 * this is only a convenience for handlers in the same process.
 */
const REQUEST_ID_KEY = "x402MeshRequestId";

declare module "express-serve-static-core" {
  interface Request {
    /** Server-generated correlation id for this request. Always present after the middleware. */
    x402MeshRequestId?: string;
  }
}

/**
 * Assigns every request a fresh UUIDv4 and echoes it as `x-request-id`.
 *
 * A client-supplied `x-request-id` is deliberately **ignored**. The id keys settlement
 * idempotency, so honouring caller input would let one payer suppress another payer's
 * operator payout by reusing their id.
 */
export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = randomUUID();
    req[REQUEST_ID_KEY] = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}

/**
 * Reads the id assigned by {@link requestId}.
 *
 * Falls back to a fresh UUID so a handler mounted without the middleware still gets a
 * unique, non-colliding value rather than an empty string.
 */
export function getRequestId(req: Request): string {
  return req[REQUEST_ID_KEY] ?? randomUUID();
}
