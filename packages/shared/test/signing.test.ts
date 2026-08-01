import { describe, expect, it } from "vitest";
import {
  ALGORAND_TESTNET,
  REGISTRATION_MAX_SKEW_MS,
  ValidationError,
  assertFreshTimestamp,
  canonicalRegistrationBytes,
  registrationNonce,
} from "../src/index.js";
import type { NodeRegistration } from "../src/index.js";

const ADDRESS = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
const TESTNET_FULL = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

const base: NodeRegistration = {
  nodeId: "node-alpha",
  operatorAddress: ADDRESS,
  endpoint: "https://node.example.com",
  capabilities: [
    { model: "llama3.1:8b", contextWindow: 8192, pricePer1kTokensUsdc: "0.000500" },
    { model: "qwen2.5:7b", contextWindow: 32768, pricePer1kTokensUsdc: "0.000400" },
  ],
  network: ALGORAND_TESTNET,
  version: "0.1.0",
  timestamp: 1_760_000_000_000,
  nonce: "0123456789abcdef0123456789abcdef",
};

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("canonicalRegistrationBytes", () => {
  it("is deterministic for the same logical object", () => {
    expect(canonicalRegistrationBytes(base)).toEqual(canonicalRegistrationBytes({ ...base }));
  });

  it("is independent of key insertion order", () => {
    // Same fields, built in reverse declaration order.
    const shuffled = {
      nonce: base.nonce,
      timestamp: base.timestamp,
      version: base.version,
      network: base.network,
      capabilities: base.capabilities.map((c) => ({
        pricePer1kTokensUsdc: c.pricePer1kTokensUsdc,
        contextWindow: c.contextWindow,
        model: c.model,
      })),
      endpoint: base.endpoint,
      operatorAddress: base.operatorAddress,
      nodeId: base.nodeId,
    } as NodeRegistration;
    expect(canonicalRegistrationBytes(shuffled)).toEqual(canonicalRegistrationBytes(base));
  });

  it("ignores properties outside the signed projection", () => {
    const polluted = { ...base, injected: "value", __proto__unused: 1 } as NodeRegistration;
    expect(canonicalRegistrationBytes(polluted)).toEqual(canonicalRegistrationBytes(base));
  });

  it("is independent of the CAIP-2 encoding used for the network", () => {
    const full = { ...base, network: TESTNET_FULL } as NodeRegistration;
    expect(canonicalRegistrationBytes(full)).toEqual(canonicalRegistrationBytes(base));
  });

  it("preserves capability array order (order is semantically meaningful)", () => {
    const reversed = { ...base, capabilities: [...base.capabilities].reverse() };
    expect(canonicalRegistrationBytes(reversed)).not.toEqual(canonicalRegistrationBytes(base));
  });

  it("changes when any signed field changes", () => {
    const fields: NodeRegistration[] = [
      { ...base, nodeId: "node-beta" },
      { ...base, operatorAddress: ADDRESS.replace("ZMFK", "AMFK") },
      { ...base, endpoint: "https://node.example.com/v1" },
      { ...base, version: "0.1.1" },
      { ...base, timestamp: base.timestamp + 1 },
      { ...base, nonce: "ffffffffffffffffffffffffffffffff" },
    ];
    const original = decode(canonicalRegistrationBytes(base));
    for (const mutated of fields) {
      expect(decode(canonicalRegistrationBytes(mutated))).not.toBe(original);
    }
  });

  it("emits the domain separator followed by canonical JSON with sorted keys", () => {
    const text = decode(canonicalRegistrationBytes(base));
    const [domain, json] = text.split("\n");
    expect(domain).toBe("x402-mesh/node-registration/v1");
    expect(json).toBeDefined();
    const keys = Object.keys(JSON.parse(json as string) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
    expect(json).toContain(`"network":"${ALGORAND_TESTNET}"`);
    expect(text).not.toMatch(/\n\s/); // no insignificant whitespace
  });

  it("omits an absent optional capability field but includes it when present", () => {
    const withQuant = {
      ...base,
      capabilities: [{ ...base.capabilities[0]!, quantization: "q4_K_M" }],
    };
    const withoutQuant = { ...base, capabilities: [base.capabilities[0]!] };
    expect(decode(canonicalRegistrationBytes(withoutQuant))).not.toContain("quantization");
    expect(decode(canonicalRegistrationBytes(withQuant))).toContain("q4_K_M");
  });

  it("rejects a non-finite number rather than serializing it as null", () => {
    expect(() =>
      canonicalRegistrationBytes({ ...base, timestamp: Number.NaN } as NodeRegistration),
    ).toThrow(ValidationError);
  });
});

describe("registrationNonce", () => {
  it("returns 128 bits of lowercase hex", () => {
    const nonce = registrationNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => registrationNonce()));
    expect(seen.size).toBe(500);
  });
});

describe("assertFreshTimestamp", () => {
  const now = 1_760_000_000_000;

  it("accepts the current instant", () => {
    expect(() => assertFreshTimestamp(now, now)).not.toThrow();
  });

  it("accepts the inclusive skew boundaries", () => {
    expect(() => assertFreshTimestamp(now - REGISTRATION_MAX_SKEW_MS, now)).not.toThrow();
    expect(() => assertFreshTimestamp(now + REGISTRATION_MAX_SKEW_MS, now)).not.toThrow();
  });

  it("rejects one millisecond past either boundary", () => {
    expect(() => assertFreshTimestamp(now - REGISTRATION_MAX_SKEW_MS - 1, now)).toThrow(
      ValidationError,
    );
    expect(() => assertFreshTimestamp(now + REGISTRATION_MAX_SKEW_MS + 1, now)).toThrow(
      ValidationError,
    );
  });

  it("uses distinct messages for stale and future timestamps", () => {
    expect(() => assertFreshTimestamp(now - 200_000, now)).toThrow(/too old/);
    expect(() => assertFreshTimestamp(now + 200_000, now)).toThrow(/too far in the future/);
  });

  it("defaults to the wall clock", () => {
    expect(() => assertFreshTimestamp(Date.now())).not.toThrow();
    expect(() => assertFreshTimestamp(0)).toThrow(ValidationError);
  });

  it("rejects non-integer and non-finite timestamps", () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, "1760000000000"]) {
      expect(() => assertFreshTimestamp(bad as number, now), String(bad)).toThrow(ValidationError);
    }
  });

  it("keeps the skew out of the error message but in the details", () => {
    try {
      assertFreshTimestamp(now - 200_000, now);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as ValidationError;
      expect(err.httpStatus).toBe(400);
      expect(err.details?.["maxSkewMs"]).toBe(REGISTRATION_MAX_SKEW_MS);
    }
  });
});
