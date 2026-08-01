import { describe, expect, it } from "vitest";
import { toClientAvmSigner } from "@x402/avm";
import { ConfigError, ValidationError } from "@x402-mesh/shared";
import {
  ED25519_SIGNATURE_BYTES,
  algorandAddressFromPublicKey,
  loadOperatorKey,
  verifySignatureB64,
} from "../src/keys.js";
import { generateSecretKeyB64 } from "./helpers.js";

/**
 * Operator identity.
 *
 * The address in a registration is a claim about where the gateway should send money, so
 * "the key that signs is the key that owns the address" is the one property this module
 * exists to guarantee.
 */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Rewrites the final significant base64 character so its unused low bits are non-zero. */
function nonCanonicalBase64(valid: string): string {
  // For a 64-byte payload the encoding ends `XY==`; `Y` carries 2 significant bits and 4
  // that canonical base64 leaves at zero. Setting one of them changes nothing on decode.
  const index = valid.length - 3;
  const alphabetIndex = BASE64_ALPHABET.indexOf(valid[index]!);
  return valid.slice(0, index) + BASE64_ALPHABET[alphabetIndex + 1]! + valid.slice(index + 1);
}

/** Splices the seed of one key onto the advertised public key of another. */
function splicedKeyB64(): string {
  const a = Buffer.from(generateSecretKeyB64(), "base64");
  const b = Buffer.from(generateSecretKeyB64(), "base64");
  return Buffer.concat([a.subarray(0, 32), b.subarray(32)]).toString("base64");
}

describe("algorandAddressFromPublicKey", () => {
  it("produces a 58-character base32 address", () => {
    const secret = Buffer.from(generateSecretKeyB64(), "base64");
    const address = algorandAddressFromPublicKey(secret.subarray(32));

    expect(address).toHaveLength(58);
    expect(address).toMatch(/^[A-Z2-7]{58}$/);
  });

  it("is deterministic", () => {
    const publicKey = Buffer.from(generateSecretKeyB64(), "base64").subarray(32);
    expect(algorandAddressFromPublicKey(publicKey)).toBe(algorandAddressFromPublicKey(publicKey));
  });

  it("rejects a public key that is not 32 bytes", () => {
    expect(() => algorandAddressFromPublicKey(new Uint8Array(31))).toThrow(ValidationError);
    expect(() => algorandAddressFromPublicKey(new Uint8Array(33))).toThrow(ValidationError);
    expect(() => algorandAddressFromPublicKey(new Uint8Array(0))).toThrow(ValidationError);
  });
});

describe("loadOperatorKey", () => {
  it("derives the same address as the x402 AVM SDK", () => {
    // The module docs claim byte-identical derivation to `toClientAvmSigner`; if that ever
    // drifts, the node advertises a payout address the facilitator does not agree with.
    for (let i = 0; i < 5; i += 1) {
      const secretB64 = generateSecretKeyB64();
      expect(loadOperatorKey(secretB64).address).toBe(toClientAvmSigner(secretB64).address);
    }
  });

  it("exposes a public key consistent with its address and base64 form", () => {
    const key = loadOperatorKey(generateSecretKeyB64());

    expect(key.publicKey).toHaveLength(32);
    expect(Buffer.from(key.publicKeyB64, "base64").equals(Buffer.from(key.publicKey))).toBe(true);
    expect(algorandAddressFromPublicKey(key.publicKey)).toBe(key.address);
  });

  it("signs bytes that verify against its own public key", () => {
    const key = loadOperatorKey(generateSecretKeyB64());
    const message = new TextEncoder().encode("x402-mesh/node-registration/v1\n{}");
    const signature = key.sign(message);

    expect(signature).toHaveLength(ED25519_SIGNATURE_BYTES);
    expect(verifySignatureB64(key.publicKeyB64, message, key.signB64(message))).toBe(true);
  });

  it("produces a deterministic Ed25519 signature", () => {
    const key = loadOperatorKey(generateSecretKeyB64());
    const message = new TextEncoder().encode("same bytes");
    expect(key.signB64(message)).toBe(key.signB64(message));
  });

  it("is frozen and carries no private material on the object", () => {
    const secretB64 = generateSecretKeyB64();
    const seedB64 = Buffer.from(secretB64, "base64").subarray(0, 32).toString("base64");
    const key = loadOperatorKey(secretB64);

    expect(Object.isFrozen(key)).toBe(true);
    const serialized = JSON.stringify(key);
    expect(serialized).not.toContain(secretB64);
    expect(serialized).not.toContain(seedB64);
    // The only data properties are public ones; the seed survives solely inside the closure.
    expect(
      Object.keys(key)
        .filter((k) => typeof (key as unknown as Record<string, unknown>)[k] !== "function")
        .sort(),
    ).toEqual(["address", "publicKey", "publicKeyB64"]);
  });

  it("rejects a key that is not canonical base64", () => {
    expect(() => loadOperatorKey("")).toThrow(ConfigError);
    // Right alphabet, wrong length modulus.
    expect(() => loadOperatorKey("AAAAA")).toThrow(ConfigError);
    // Right length modulus, illegal characters.
    expect(() => loadOperatorKey("!!!!")).toThrow(ConfigError);
    // Whitespace that `Buffer.from(..., "base64")` would otherwise silently drop.
    const valid = generateSecretKeyB64();
    expect(() => loadOperatorKey(`${valid.slice(0, 40)}\n${valid.slice(40)}`)).toThrow(ConfigError);
  });

  it("rejects a non-canonical encoding of the right bytes", () => {
    const valid = generateSecretKeyB64();
    const mutated = nonCanonicalBase64(valid);

    expect(mutated).not.toBe(valid);
    // Same 64 bytes, different spelling — accepted here it would mean two encodings of one key.
    expect(Buffer.from(mutated, "base64").equals(Buffer.from(valid, "base64"))).toBe(true);
    expect(() => loadOperatorKey(mutated)).toThrow(ConfigError);
  });

  it("rejects a key of the wrong byte length", () => {
    const secret = Buffer.from(generateSecretKeyB64(), "base64");
    expect(() => loadOperatorKey(secret.subarray(0, 32).toString("base64"))).toThrow(
      /exactly 64 bytes/,
    );
    expect(() => loadOperatorKey(Buffer.concat([secret, secret]).toString("base64"))).toThrow(
      /exactly 64 bytes/,
    );
  });

  it("rejects a key whose public half disagrees with its seed", () => {
    // A spliced key would sign with one identity and advertise another — payouts would go to
    // an address the operator cannot spend from.
    expect(() => loadOperatorKey(splicedKeyB64())).toThrow(/inconsistent/);
    expect(() => loadOperatorKey(splicedKeyB64())).toThrow(ConfigError);
  });

  it("never echoes key material in an error", () => {
    const spliced = splicedKeyB64();
    const seedHex = Buffer.from(spliced, "base64").subarray(0, 32).toString("hex");
    const seedB64 = Buffer.from(spliced, "base64").subarray(0, 32).toString("base64");

    let thrown: unknown;
    try {
      loadOperatorKey(spliced);
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const rendered = `${(thrown as Error).message}|${JSON.stringify(thrown)}|${String(thrown)}`;
    expect(rendered).not.toContain(spliced);
    expect(rendered).not.toContain(seedHex);
    expect(rendered).not.toContain(seedB64);
  });
});

describe("verifySignatureB64", () => {
  it("rejects a signature over different bytes", () => {
    const key = loadOperatorKey(generateSecretKeyB64());
    const signature = key.signB64(new TextEncoder().encode("original"));
    expect(
      verifySignatureB64(key.publicKeyB64, new TextEncoder().encode("tampered"), signature),
    ).toBe(false);
  });

  it("rejects a signature checked against another operator's key", () => {
    const signer = loadOperatorKey(generateSecretKeyB64());
    const other = loadOperatorKey(generateSecretKeyB64());
    const message = new TextEncoder().encode("payload");

    expect(verifySignatureB64(other.publicKeyB64, message, signer.signB64(message))).toBe(false);
  });

  it("rejects a mutated signature", () => {
    const key = loadOperatorKey(generateSecretKeyB64());
    const message = new TextEncoder().encode("payload");
    const raw = Buffer.from(key.sign(message));
    raw[0] = raw[0]! ^ 0xff;

    expect(verifySignatureB64(key.publicKeyB64, message, raw.toString("base64"))).toBe(false);
  });

  it("returns false rather than throwing on malformed input", () => {
    const key = loadOperatorKey(generateSecretKeyB64());
    const message = new TextEncoder().encode("payload");
    const signature = key.signB64(message);

    expect(verifySignatureB64("", message, signature)).toBe(false);
    expect(verifySignatureB64("not-base64!", message, signature)).toBe(false);
    expect(verifySignatureB64(key.publicKeyB64, message, "")).toBe(false);
    expect(verifySignatureB64(key.publicKeyB64, message, "AAAA")).toBe(false);
    // A 32-byte value where a 64-byte signature belongs.
    expect(verifySignatureB64(key.publicKeyB64, message, key.publicKeyB64)).toBe(false);
  });
});
