import { ValidationError } from "@x402-mesh/shared";

/**
 * Deterministic JSON serialization, byte-for-byte identical to the scheme documented on
 * `canonicalRegistrationBytes` in `@x402-mesh/shared`.
 *
 * The shared package keeps its serializer private (only the registration payload builder is
 * exported), so the heartbeat payload — which the shared package does not model — needs its
 * own copy. The rules are reproduced verbatim on purpose: any independent implementation of
 * "canonical JSON + domain separator" must agree with this one for signatures to verify.
 *
 * Rules:
 * 1. Object keys are emitted in ascending order of their UTF-16 code units.
 * 2. Array order is preserved — it is semantically meaningful.
 * 3. Keys whose value is `undefined` are omitted entirely.
 * 4. Numbers must be finite; `NaN`/`Infinity` throw rather than serialize as `null`.
 * 5. No insignificant whitespace is emitted.
 *
 * @throws {ValidationError} on non-finite numbers and non-JSON values (functions, symbols).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new ValidationError("cannot canonicalize a non-finite number", {
          value: String(value),
        });
      }
      return JSON.stringify(value);
    case "bigint":
      return JSON.stringify(value.toString(10));
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",");
    return `{${body}}`;
  }
  throw new ValidationError("cannot canonicalize value", { type: typeof value });
}

/**
 * Builds the exact bytes a signer covers: a domain separator, a newline, then canonical JSON.
 *
 * The domain separator is what stops a signature minted for one message kind (a registration)
 * from being replayed as another (a heartbeat).
 */
export function domainSeparatedBytes(domain: string, payload: unknown): Uint8Array {
  return new TextEncoder().encode(`${domain}\n${canonicalJson(payload)}`);
}
