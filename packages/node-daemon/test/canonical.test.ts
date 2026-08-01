import { describe, expect, it } from "vitest";
import { ValidationError, canonicalRegistrationBytes } from "@x402-mesh/shared";
import type { NodeRegistration } from "@x402-mesh/shared";
import { canonicalJson, domainSeparatedBytes } from "../src/canonical.js";

/**
 * Deterministic serialization.
 *
 * This module is a deliberate second implementation of the scheme in `@x402-mesh/shared`.
 * Two implementations that disagree by one byte produce signatures the gateway rejects, so
 * the agreement is asserted here directly rather than assumed.
 */

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("canonicalJson", () => {
  it("sorts object keys, so insertion order cannot change the bytes", () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    expect(canonicalJson({ c: 3, a: 2, b: 1 })).toBe(canonicalJson({ a: 2, b: 1, c: 3 }));
  });

  it("sorts by UTF-16 code unit, not by locale", () => {
    // "Z" (0x5A) sorts before "a" (0x61); a locale-aware sort would put them the other way.
    expect(canonicalJson({ a: 1, Z: 2, B: 3 })).toBe('{"B":3,"Z":2,"a":1}');
  });

  it("sorts nested objects too", () => {
    const left = canonicalJson({ outer: { z: 1, a: { y: 1, b: 2 } } });
    const right = canonicalJson({ outer: { a: { b: 2, y: 1 }, z: 1 } });
    expect(left).toBe(right);
    expect(left).toBe('{"outer":{"a":{"b":2,"y":1},"z":1}}');
  });

  it("preserves array order, which is semantically meaningful", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([{ b: 1, a: 2 }, "x"])).toBe('[{"a":2,"b":1},"x"]');
  });

  it("omits undefined object values entirely", () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
    expect(canonicalJson({ a: undefined })).toBe("{}");
  });

  it("represents an undefined array element as null, keeping the length", () => {
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("emits primitives exactly as JSON does", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-1.5)).toBe("-1.5");
    expect(canonicalJson("hi")).toBe('"hi"');
    // Escaping must match JSON.stringify or the two implementations diverge on unicode.
    expect(canonicalJson('a"b\\c\nd\té')).toBe(JSON.stringify('a"b\\c\nd\té'));
  });

  it("serializes bigint as a decimal string, never as a number", () => {
    // Money is bigint; emitting it as a JSON number would lose precision above 2^53.
    expect(canonicalJson(12345678901234567890n)).toBe('"12345678901234567890"');
    expect(canonicalJson({ atomic: 1900n })).toBe('{"atomic":"1900"}');
  });

  it("throws on a non-finite number instead of silently emitting null", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(ValidationError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
    expect(() => canonicalJson({ a: Number.NEGATIVE_INFINITY })).toThrow(ValidationError);
    expect(() => canonicalJson([1, Number.NaN])).toThrow(ValidationError);
  });

  it("throws on values JSON cannot represent", () => {
    expect(() => canonicalJson(() => 1)).toThrow(ValidationError);
    expect(() => canonicalJson(Symbol("s"))).toThrow(ValidationError);
    expect(() => canonicalJson({ fn: () => 1 })).toThrow(ValidationError);
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalJson({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });
});

describe("domainSeparatedBytes", () => {
  it("prefixes the domain and a newline", () => {
    expect(decode(domainSeparatedBytes("dom/v1", { a: 1 }))).toBe('dom/v1\n{"a":1}');
  });

  it("produces different bytes for the same payload under different domains", () => {
    const payload = { nodeId: "n1", healthy: true };
    const heartbeat = decode(domainSeparatedBytes("x402-mesh/node-heartbeat/v1", payload));
    const registration = decode(domainSeparatedBytes("x402-mesh/node-registration/v1", payload));

    // Without this, a captured heartbeat signature could be replayed as a registration.
    expect(heartbeat).not.toBe(registration);
  });

  it("is byte-identical regardless of key insertion order", () => {
    const a = domainSeparatedBytes("d", { x: 1, y: [{ b: 1, a: 2 }] });
    const b = domainSeparatedBytes("d", { y: [{ a: 2, b: 1 }], x: 1 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("encodes as UTF-8", () => {
    const bytes = domainSeparatedBytes("d", { s: "é" });
    expect(Buffer.from(bytes).equals(Buffer.from(`d\n{"s":"é"}`, "utf8"))).toBe(true);
  });
});

describe("agreement with the shared registration serializer", () => {
  const registration: NodeRegistration = {
    nodeId: "node-1",
    operatorAddress: "A".repeat(58),
    endpoint: "http://127.0.0.1:8403",
    capabilities: [
      { model: "llama3.1:8b", contextWindow: 8192, pricePer1kTokensUsdc: "0.0017" },
      {
        model: "mistral:7b",
        contextWindow: 4096,
        pricePer1kTokensUsdc: "0.0020",
        quantization: "q4_K_M",
      },
    ],
    network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k",
    version: "0.1.0",
    timestamp: 1_760_000_000_000,
    nonce: "0123456789abcdef0123456789abcdef",
  };

  it("reproduces canonicalRegistrationBytes exactly", () => {
    // The daemon's copy of the serializer is what signs heartbeats; if it ever diverges from
    // the shared one, registration signatures and heartbeat signatures stop agreeing on what
    // "canonical" means and the gateway rejects one of them.
    const mine = domainSeparatedBytes("x402-mesh/node-registration/v1", {
      nodeId: registration.nodeId,
      operatorAddress: registration.operatorAddress,
      endpoint: registration.endpoint,
      capabilities: registration.capabilities,
      network: registration.network,
      version: registration.version,
      timestamp: registration.timestamp,
      nonce: registration.nonce,
    });

    expect(Buffer.from(mine).equals(Buffer.from(canonicalRegistrationBytes(registration)))).toBe(
      true,
    );
  });
});
