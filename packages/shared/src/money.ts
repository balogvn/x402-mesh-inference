import { ConfigError, PricingError } from "./errors.js";
import { USDC_DECIMALS } from "./networks.js";

/**
 * A USDC amount in integer atomic units (6 decimals).
 *
 * Money never touches IEEE-754 in this codebase: `0.1 + 0.2 !== 0.3` is a rounding bug in a
 * settlement path, and a settlement path that rounds is a settlement path that loses money.
 */
export type Atomic = bigint;

/** 10 ** USDC_DECIMALS, precomputed as a bigint scale factor. */
const SCALE: bigint = 10n ** BigInt(USDC_DECIMALS);

/** `<integer>` or `<integer>.<fraction>`, optionally prefixed with a `$`. */
const DECIMAL_RE = /^\$?(\d+)(?:\.(\d*))?$/;

/**
 * Parses a decimal USDC string into atomic units without any floating-point arithmetic.
 *
 * Accepts `"0.0020"`, `"0.002"`, `"$0.002"`, `"1"`, `"1.000000"`. A leading `$` is tolerated
 * because the x402 `Money` type is commonly written that way; surrounding whitespace is
 * trimmed. Anything else — negatives, exponents, more than 6 decimal places, empty strings —
 * is rejected rather than silently coerced.
 *
 * @example usdcToAtomic("0.0020") === 2000n
 * @throws {ConfigError} on malformed, negative or over-precise input.
 */
export function usdcToAtomic(usdc: string): Atomic {
  if (typeof usdc !== "string") {
    throw new ConfigError("USDC amount must be a string", { received: typeof usdc });
  }
  const trimmed = usdc.trim();
  if (trimmed.length === 0) {
    throw new ConfigError("USDC amount must not be empty");
  }
  if (trimmed.startsWith("-") || trimmed.startsWith("$-")) {
    throw new ConfigError(`USDC amount must not be negative: ${trimmed}`, { value: trimmed });
  }
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) {
    throw new ConfigError(`malformed USDC amount: ${trimmed}`, { value: trimmed });
  }
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (fraction.length > USDC_DECIMALS) {
    throw new ConfigError(
      `USDC amount has ${fraction.length} decimal places, maximum is ${USDC_DECIMALS}: ${trimmed}`,
      { value: trimmed, decimals: fraction.length, maxDecimals: USDC_DECIMALS },
    );
  }
  const padded = fraction.padEnd(USDC_DECIMALS, "0");
  return BigInt(whole) * SCALE + BigInt(padded === "" ? "0" : padded);
}

/**
 * Renders atomic units as an exact decimal USDC string with all 6 decimal places.
 *
 * Always fixed-width after the point (`2000n -> "0.002000"`) so that two amounts are
 * comparable as strings and round-tripping through {@link usdcToAtomic} is lossless.
 */
export function atomicToUsdc(a: Atomic): string {
  assertBigint(a, "atomicToUsdc");
  const negative = a < 0n;
  const magnitude = negative ? -a : a;
  const whole = magnitude / SCALE;
  const fraction = magnitude % SCALE;
  const fractionStr = fraction.toString(10).padStart(USDC_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole.toString(10)}.${fractionStr}`;
}

/**
 * Serializes atomic units for the x402 wire format, which carries `amount` as a decimal
 * integer string of atomic units.
 *
 * @throws {PricingError} if the amount is negative — a negative amount on the wire is always
 * a bug upstream, and shipping it would produce an unverifiable payment requirement.
 */
export function atomicToWire(a: Atomic): string {
  assertBigint(a, "atomicToWire");
  if (a < 0n) {
    throw new PricingError("cannot serialize a negative atomic amount to the wire", {
      amount: a.toString(10),
    });
  }
  return a.toString(10);
}

/**
 * Human-readable USD rendering for logs and UI only.
 *
 * Never parse this back for settlement — use {@link atomicToWire} on the wire and
 * {@link usdcToAtomic} at the boundary.
 */
export function formatUsd(a: Atomic): string {
  assertBigint(a, "formatUsd");
  const rendered = atomicToUsdc(a);
  return rendered.startsWith("-") ? `-$${rendered.slice(1)}` : `$${rendered}`;
}

/** Parses a wire-format atomic integer string (no decimal point) back into a bigint. */
export function wireToAtomic(wire: string): Atomic {
  if (typeof wire !== "string" || !/^\d+$/.test(wire.trim())) {
    throw new ConfigError(`malformed atomic amount: ${String(wire)}`, { value: String(wire) });
  }
  return BigInt(wire.trim());
}

function assertBigint(a: unknown, fn: string): asserts a is bigint {
  if (typeof a !== "bigint") {
    throw new PricingError(`${fn} requires a bigint atomic amount`, { received: typeof a });
  }
}
