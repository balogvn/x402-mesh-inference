import { pino } from "pino";
import type { Logger } from "pino";

export type { Logger } from "pino";

/**
 * Keys pino redacts before anything reaches a log line.
 *
 * Belt and braces: nothing in this package deliberately logs a secret, but a future
 * `log.info({ config })` would otherwise dump `privateKeyB64` verbatim into an operator's
 * journal. Redaction paths are cheap insurance against exactly that edit.
 */
const REDACT_PATHS = [
  "privateKeyB64",
  "*.privateKeyB64",
  "AVM_PRIVATE_KEY",
  "*.AVM_PRIVATE_KEY",
  "apiKey",
  "*.apiKey",
  "authToken",
  "*.authToken",
  "req.headers.authorization",
  "headers.authorization",
  "authorization",
];

/**
 * Builds the daemon logger.
 *
 * @param level - Pino level name; `"silent"` disables output entirely.
 */
export function createLogger(level = "info"): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { component: "node-daemon" },
  });
}
