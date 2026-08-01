import pino from "pino";

/**
 * The logging surface the gateway depends on.
 *
 * Deliberately narrower than pino's `Logger`: every call site passes a structured object
 * first and a short message second, which keeps log output machine-parseable and stops
 * anyone from string-interpolating a secret into a message. A pino logger satisfies this
 * interface structurally, and tests inject {@link silentLogger} instead of a real one.
 */
export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Paths pino replaces with `[redacted]` before serializing.
 *
 * Belt-and-braces: no call site is supposed to log these in the first place, but a redaction
 * list costs nothing and a leaked private key costs everything.
 */
const REDACTED_PATHS = [
  "privateKey",
  "privateKeyB64",
  "AVM_PRIVATE_KEY",
  "mnemonic",
  "secret",
  "token",
  "authorization",
  "req.headers.authorization",
  "req.headers['x-payment']",
  "req.headers['payment-signature']",
  "headers.authorization",
  "headers['x-payment']",
  "headers['payment-signature']",
];

/**
 * Builds the process logger.
 *
 * @param level - pino level name; `"silent"` disables output entirely.
 * @param name - value bound to the `service` field on every line.
 */
export function createLogger(level: string, name = "x402-mesh-gateway"): Logger {
  return pino({
    level,
    name,
    base: { service: name },
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
  });
}

/** A logger that discards everything. Used by tests and by `--quiet` style call paths. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
