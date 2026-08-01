import { describe, expect, it } from "vitest";
import {
  ALGORAND_MAINNET,
  ALGORAND_TESTNET,
  ConfigError,
  USDC_DECIMALS,
  isSupportedNetwork,
  normalizeNetwork,
  toCaip2,
  toMeshNetwork,
  usdcAssetId,
} from "../src/index.js";

/** Full, padded genesis-hash form as advertised by the live GoPlausible facilitator. */
const MAINNET_FULL = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const TESTNET_FULL = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

describe("network constants", () => {
  it("uses the canonical truncated CAIP-2 form", () => {
    expect(ALGORAND_MAINNET).toBe("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k");
    expect(ALGORAND_TESTNET).toBe("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe");
    expect(USDC_DECIMALS).toBe(6);
  });
});

describe("normalizeNetwork", () => {
  it("passes canonical identifiers through unchanged", () => {
    expect(normalizeNetwork(ALGORAND_MAINNET)).toBe(ALGORAND_MAINNET);
    expect(normalizeNetwork(ALGORAND_TESTNET)).toBe(ALGORAND_TESTNET);
  });

  it("collapses the full padded genesis-hash form onto the canonical form", () => {
    expect(normalizeNetwork(MAINNET_FULL)).toBe(ALGORAND_MAINNET);
    expect(normalizeNetwork(TESTNET_FULL)).toBe(ALGORAND_TESTNET);
  });

  it("is idempotent", () => {
    expect(normalizeNetwork(normalizeNetwork(MAINNET_FULL))).toBe(ALGORAND_MAINNET);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeNetwork(`  ${TESTNET_FULL}  `)).toBe(ALGORAND_TESTNET);
  });

  it("rejects non-Algorand and unknown networks as ConfigError", () => {
    for (const bad of [
      "eip155:1",
      "algorand:not-a-real-genesis-hash",
      "algorand:",
      "",
      "   ",
      "solana:mainnet",
    ]) {
      expect(() => normalizeNetwork(bad), bad).toThrow(ConfigError);
    }
  });

  it("rejects non-string input without throwing a TypeError", () => {
    expect(() => normalizeNetwork(undefined as unknown as string)).toThrow(ConfigError);
    expect(() => normalizeNetwork(42 as unknown as string)).toThrow(ConfigError);
  });

  it("does not leak a raw SDK error", () => {
    try {
      normalizeNetwork("eip155:1");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe("config_error");
    }
  });
});

describe("isSupportedNetwork", () => {
  it("never throws", () => {
    expect(isSupportedNetwork(MAINNET_FULL)).toBe(true);
    expect(isSupportedNetwork(ALGORAND_TESTNET)).toBe(true);
    expect(isSupportedNetwork("eip155:1")).toBe(false);
    expect(isSupportedNetwork("")).toBe(false);
  });
});

describe("toCaip2 / toMeshNetwork", () => {
  it("round-trips both selectors", () => {
    expect(toCaip2("mainnet")).toBe(ALGORAND_MAINNET);
    expect(toCaip2("testnet")).toBe(ALGORAND_TESTNET);
    expect(toMeshNetwork(ALGORAND_MAINNET)).toBe("mainnet");
    expect(toMeshNetwork(ALGORAND_TESTNET)).toBe("testnet");
  });

  it("accepts the full genesis-hash form when mapping back", () => {
    expect(toMeshNetwork(MAINNET_FULL)).toBe("mainnet");
    expect(toMeshNetwork(TESTNET_FULL)).toBe("testnet");
  });

  it("rejects an unknown selector", () => {
    expect(() => toCaip2("devnet" as "mainnet")).toThrow(ConfigError);
  });
});

describe("usdcAssetId", () => {
  it("returns the verified ASA ids for both networks", () => {
    expect(usdcAssetId(ALGORAND_MAINNET)).toBe("31566704");
    expect(usdcAssetId(ALGORAND_TESTNET)).toBe("10458941");
  });

  it("normalizes before lookup, so the full genesis-hash form resolves too", () => {
    expect(usdcAssetId(MAINNET_FULL)).toBe("31566704");
    expect(usdcAssetId(TESTNET_FULL)).toBe("10458941");
  });

  it("throws on an unknown network", () => {
    expect(() => usdcAssetId("eip155:1")).toThrow(ConfigError);
  });
});
