import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { ConfigError, ValidationError } from "@x402-mesh/shared";

/**
 * Operator key handling.
 *
 * `AVM_PRIVATE_KEY` is base64 of the 64-byte Algorand secret key: a 32-byte Ed25519 seed
 * followed by the 32-byte public key. Two capabilities are needed and neither is offered by
 * `toClientAvmSigner` from `@x402/avm`:
 *
 * - **Signing arbitrary bytes.** `ClientAvmSigner` only exposes `signTransactions`, which
 *   msgpack-decodes its input and refuses anything that is not a transaction. Registration
 *   and heartbeat payloads are plain bytes, so signing goes through `node:crypto` Ed25519.
 * - **Detecting a corrupt key.** `toClientAvmSigner` derives the address from the trailing
 *   32 bytes without checking that they match the seed; a truncated or spliced key would
 *   therefore sign with one identity and advertise another. {@link loadOperatorKey} derives
 *   the public key from the seed and rejects the key if the two disagree.
 *
 * The address derivation below is byte-identical to `toClientAvmSigner(key).address` — that
 * equivalence is pinned by a test, so this module can stay dependency-free (and skip a
 * ~300 ms `@x402/avm` import) without drifting from the SDK.
 *
 * Nothing here ever puts key material into an error message, a `toJSON` or a log line: the
 * seed lives only inside a `KeyObject` captured by the returned closure.
 */

/** Bytes in an Algorand secret key: 32-byte Ed25519 seed followed by the 32-byte public key. */
const ALGORAND_SECRET_KEY_BYTES = 64;

/** Bytes in the Ed25519 seed half of an Algorand secret key. */
const ED25519_SEED_BYTES = 32;

/** Bytes in an Ed25519 public key. */
const ED25519_PUBLIC_KEY_BYTES = 32;

/** Bytes in an Ed25519 signature. */
export const ED25519_SIGNATURE_BYTES = 64;

/** Trailing bytes of `sha512-256(publicKey)` that form the Algorand address checksum. */
const ALGORAND_CHECKSUM_BYTES = 4;

/** Characters in an Algorand address: base32 of 32 key bytes + 4 checksum bytes. */
const ALGORAND_ADDRESS_LENGTH = 58;

/**
 * DER prefix for a PKCS#8 Ed25519 private key holding a raw 32-byte seed.
 * `302e 020100 300506032b6570 042204 20` — SEQUENCE, version 0, AlgorithmIdentifier(Ed25519),
 * OCTET STRING wrapping a 32-byte OCTET STRING.
 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** DER prefix for an SPKI Ed25519 public key holding a raw 32-byte key. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** RFC 4648 base32 alphabet, the encoding Algorand addresses use (unpadded). */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Canonical base64 with the standard alphabet and correct padding. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes canonical base64 and asserts the exact decoded length.
 *
 * The re-encode comparison rejects non-canonical padding and stray characters, which
 * `Buffer.from(value, "base64")` would otherwise swallow silently.
 *
 * @throws {ConfigError} without ever echoing `value`, which may be secret.
 */
function decodeBase64Exact(value: string, byteLength: number, label: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    throw new ConfigError(`${label} must be canonical base64`, { expectedBytes: byteLength });
  }
  if (!BASE64_RE.test(value)) {
    throw new ConfigError(`${label} must be canonical base64`, { expectedBytes: byteLength });
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== byteLength || decoded.toString("base64") !== value) {
    throw new ConfigError(`${label} must decode to exactly ${byteLength} bytes`, {
      expectedBytes: byteLength,
      actualBytes: decoded.length,
    });
  }
  return decoded;
}

/** RFC 4648 base32 without padding. */
function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >>> bits) & 0b11111];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0b11111];
  }
  return out;
}

/**
 * Derives the 58-character Algorand address for an Ed25519 public key.
 *
 * `address = base32(publicKey ‖ sha512_256(publicKey)[28..32])`, unpadded.
 *
 * @throws {ValidationError} if `publicKey` is not exactly 32 bytes.
 */
export function algorandAddressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new ValidationError(`public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`, {
      actualBytes: publicKey.length,
    });
  }
  const digest = createHash("sha512-256").update(publicKey).digest();
  const checksum = digest.subarray(digest.length - ALGORAND_CHECKSUM_BYTES);
  const address = base32Encode(Buffer.concat([Buffer.from(publicKey), checksum]));
  if (address.length !== ALGORAND_ADDRESS_LENGTH) {
    // Unreachable for a 36-byte input; asserted so a future edit cannot ship silent breakage.
    throw new ValidationError("derived an Algorand address of the wrong length", {
      length: address.length,
      expected: ALGORAND_ADDRESS_LENGTH,
    });
  }
  return address;
}

/** An operator identity: the payout address plus the ability to sign mesh payloads. */
export interface OperatorKey {
  /** 58-character Algorand address derived from the key. Safe to log. */
  readonly address: string;
  /** Raw 32-byte Ed25519 public key. Safe to log. */
  readonly publicKey: Uint8Array;
  /** Base64 of {@link publicKey}, the encoding `SignedNodeRegistration` carries. */
  readonly publicKeyB64: string;
  /** Produces a 64-byte Ed25519 signature over `message`. */
  sign(message: Uint8Array): Uint8Array;
  /** Base64 convenience wrapper around {@link sign}. */
  signB64(message: Uint8Array): string;
}

/**
 * Loads the operator identity from a base64 Algorand secret key.
 *
 * @param privateKeyB64 - Base64 of the 64-byte secret key (`AVM_PRIVATE_KEY`). Never logged.
 * @throws {ConfigError} if the key is not canonical base64, is not 64 bytes, or its trailing
 * public-key half does not match the public key derived from its seed.
 */
export function loadOperatorKey(privateKeyB64: string): OperatorKey {
  const secret = decodeBase64Exact(privateKeyB64, ALGORAND_SECRET_KEY_BYTES, "AVM_PRIVATE_KEY");
  const seed = secret.subarray(0, ED25519_SEED_BYTES);
  const declaredPublicKey = secret.subarray(ED25519_SEED_BYTES);

  let privateKey;
  try {
    privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    // The underlying OpenSSL message can embed the DER we just built; never forward it.
    throw new ConfigError("AVM_PRIVATE_KEY is not a usable Ed25519 seed");
  }

  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const derivedPublicKey = Buffer.from(spki.subarray(spki.length - ED25519_PUBLIC_KEY_BYTES));

  if (!derivedPublicKey.equals(declaredPublicKey)) {
    throw new ConfigError(
      "AVM_PRIVATE_KEY is inconsistent: its public-key half does not match its seed",
    );
  }

  const address = algorandAddressFromPublicKey(derivedPublicKey);
  const publicKeyB64 = derivedPublicKey.toString("base64");

  const key: OperatorKey = {
    address,
    publicKey: derivedPublicKey,
    publicKeyB64,
    sign(message: Uint8Array): Uint8Array {
      // `null` selects Ed25519's built-in PureEdDSA hashing; any other digest is rejected.
      return sign(null, Buffer.from(message), privateKey);
    },
    signB64(message: Uint8Array): string {
      return Buffer.from(this.sign(message)).toString("base64");
    },
  };
  return Object.freeze(key);
}

/**
 * Verifies a base64 Ed25519 signature against a base64 public key.
 *
 * Returns `false` rather than throwing for malformed inputs, so it is safe to call on
 * attacker-controlled data. Used by the round-trip tests and by anything that wants to
 * re-check a payload it just produced.
 */
export function verifySignatureB64(
  publicKeyB64: string,
  message: Uint8Array,
  signatureB64: string,
): boolean {
  try {
    const publicKey = decodeBase64Exact(publicKeyB64, ED25519_PUBLIC_KEY_BYTES, "publicKey");
    const signature = decodeBase64Exact(signatureB64, ED25519_SIGNATURE_BYTES, "signature");
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(message), key, signature);
  } catch {
    return false;
  }
}
