import { describe, expect, it } from "vitest";
import {
  DEFAULT_INBOUND_USDC,
  DEFAULT_MARGIN_BPS,
  DEFAULT_MARGIN_USDC,
  DEFAULT_NODE_PAYOUT_USDC,
  PricingError,
  assertSplitInvariant,
  computeSplit,
  usdcToAtomic,
} from "../src/index.js";

describe("computeSplit", () => {
  it("splits the default price exactly, with no rounding", () => {
    expect(computeSplit(2000n, 1500)).toEqual({
      inbound: 2000n,
      payout: 1700n,
      margin: 300n,
    });
  });

  it("matches the published economics constants", () => {
    const inbound = usdcToAtomic(DEFAULT_INBOUND_USDC);
    const split = computeSplit(inbound, DEFAULT_MARGIN_BPS);
    expect(split.inbound).toBe(usdcToAtomic(DEFAULT_INBOUND_USDC));
    expect(split.payout).toBe(usdcToAtomic(DEFAULT_NODE_PAYOUT_USDC));
    expect(split.margin).toBe(usdcToAtomic(DEFAULT_MARGIN_USDC));
  });

  it("holds the invariant inbound - payout === margin for many inputs", () => {
    for (let inbound = 0n; inbound < 5000n; inbound += 37n) {
      for (const bps of [0, 1, 250, 1500, 3333, 10_000]) {
        const split = computeSplit(inbound, bps);
        expect(split.inbound - split.payout).toBe(split.margin);
        expect(split.payout).toBeGreaterThanOrEqual(0n);
        expect(split.margin).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it("floors the margin so the remainder accrues to the operator", () => {
    // 1 atomic unit at 1500 bps is 0.15 atomic units -> floors to 0.
    expect(computeSplit(1n, 1500)).toEqual({ inbound: 1n, payout: 1n, margin: 0n });
    // 7 * 3333 / 10000 = 2.3331 -> 2.
    expect(computeSplit(7n, 3333)).toEqual({ inbound: 7n, payout: 5n, margin: 2n });
  });

  it("supports the degenerate ends of the range", () => {
    expect(computeSplit(2000n, 0)).toEqual({ inbound: 2000n, payout: 2000n, margin: 0n });
    expect(computeSplit(2000n, 10_000)).toEqual({ inbound: 2000n, payout: 0n, margin: 2000n });
  });

  it("rejects a negative inbound amount", () => {
    expect(() => computeSplit(-1n, 1500)).toThrow(PricingError);
  });

  it("rejects an out-of-range or fractional marginBps", () => {
    expect(() => computeSplit(2000n, -1)).toThrow(PricingError);
    expect(() => computeSplit(2000n, 10_001)).toThrow(PricingError);
    expect(() => computeSplit(2000n, 15.5)).toThrow(PricingError);
    expect(() => computeSplit(2000n, Number.NaN)).toThrow(PricingError);
  });

  it("rejects a non-bigint inbound amount", () => {
    expect(() => computeSplit(2000 as unknown as bigint, 1500)).toThrow(PricingError);
  });
});

describe("assertSplitInvariant", () => {
  it("accepts a well-formed split", () => {
    expect(() =>
      assertSplitInvariant({ inbound: 2000n, payout: 1700n, margin: 300n }),
    ).not.toThrow();
  });

  it("rejects a split that mints value", () => {
    expect(() => assertSplitInvariant({ inbound: 2000n, payout: 1800n, margin: 300n })).toThrow(
      PricingError,
    );
  });

  it("rejects a negative leg", () => {
    expect(() => assertSplitInvariant({ inbound: 2000n, payout: 2100n, margin: -100n })).toThrow(
      PricingError,
    );
  });
});
