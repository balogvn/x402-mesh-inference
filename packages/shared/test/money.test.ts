import { describe, expect, it } from "vitest";
import {
  ConfigError,
  PricingError,
  atomicToUsdc,
  atomicToWire,
  formatUsd,
  usdcToAtomic,
  wireToAtomic,
} from "../src/index.js";

describe("usdcToAtomic", () => {
  it("parses the canonical inbound price exactly", () => {
    expect(usdcToAtomic("0.0020")).toBe(2000n);
  });

  it("treats trailing-zero variants as the same amount", () => {
    expect(usdcToAtomic("0.002")).toBe(2000n);
    expect(usdcToAtomic("0.002000")).toBe(2000n);
  });

  it("parses the payout and margin legs exactly", () => {
    expect(usdcToAtomic("0.0017")).toBe(1700n);
    expect(usdcToAtomic("0.0003")).toBe(300n);
  });

  it("parses whole and large amounts without precision loss", () => {
    expect(usdcToAtomic("1")).toBe(1_000_000n);
    expect(usdcToAtomic("0")).toBe(0n);
    expect(usdcToAtomic("123456789.123456")).toBe(123456789123456n);
  });

  it("tolerates a leading dollar sign and surrounding whitespace", () => {
    expect(usdcToAtomic("$0.0020")).toBe(2000n);
    expect(usdcToAtomic("  0.0020  ")).toBe(2000n);
  });

  it("rejects more than six decimal places instead of truncating", () => {
    expect(() => usdcToAtomic("0.0000001")).toThrow(ConfigError);
    expect(() => usdcToAtomic("1.1234567")).toThrow(ConfigError);
  });

  it("accepts exactly six decimal places", () => {
    expect(usdcToAtomic("0.000001")).toBe(1n);
  });

  it("rejects negatives", () => {
    expect(() => usdcToAtomic("-0.002")).toThrow(ConfigError);
    expect(() => usdcToAtomic("$-0.002")).toThrow(ConfigError);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "   ", "abc", "0.0.1", "1e-3", ".5", "1,5", "0x10", "Infinity", "NaN"]) {
      expect(() => usdcToAtomic(bad), bad).toThrow(ConfigError);
    }
  });

  it("rejects non-string input", () => {
    expect(() => usdcToAtomic(0.002 as unknown as string)).toThrow(ConfigError);
  });
});

describe("atomicToUsdc", () => {
  it("renders exact fixed-precision decimals", () => {
    expect(atomicToUsdc(2000n)).toBe("0.002000");
    expect(atomicToUsdc(1700n)).toBe("0.001700");
    expect(atomicToUsdc(300n)).toBe("0.000300");
    expect(atomicToUsdc(0n)).toBe("0.000000");
    expect(atomicToUsdc(1_000_000n)).toBe("1.000000");
    expect(atomicToUsdc(1n)).toBe("0.000001");
  });

  it("round-trips through usdcToAtomic for a wide range of amounts", () => {
    const cases = [0n, 1n, 300n, 1700n, 2000n, 999_999n, 1_000_000n, 123_456_789_123_456n];
    for (const atomic of cases) {
      expect(usdcToAtomic(atomicToUsdc(atomic))).toBe(atomic);
    }
  });
});

describe("atomicToWire / wireToAtomic", () => {
  it("emits a decimal integer string of atomic units", () => {
    expect(atomicToWire(2000n)).toBe("2000");
    expect(atomicToWire(0n)).toBe("0");
  });

  it("refuses to serialize a negative amount", () => {
    expect(() => atomicToWire(-1n)).toThrow(PricingError);
  });

  it("round-trips", () => {
    expect(wireToAtomic(atomicToWire(1700n))).toBe(1700n);
  });

  it("rejects a decimal string on the wire", () => {
    expect(() => wireToAtomic("0.002")).toThrow(ConfigError);
  });
});

describe("formatUsd", () => {
  it("formats for display only", () => {
    expect(formatUsd(2000n)).toBe("$0.002000");
    expect(formatUsd(1_500_000n)).toBe("$1.500000");
    expect(formatUsd(-2000n)).toBe("-$0.002000");
  });

  it("rejects non-bigint input rather than coercing", () => {
    expect(() => formatUsd(2000 as unknown as bigint)).toThrow(PricingError);
  });
});
