/**
 * Ed25519 and Algorand address primitives built on `node:crypto` alone.
 *
 * `algosdk` is not a dependency of this repo and the scripts must not add one, so the few
 * operations the tooling needs — generate an account, sign a registration, verify a signature,
 * derive an address — are implemented directly against node's WebCrypto-backed key API.
 *
 * Nothing here logs. Secret material only ever leaves through a return value.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

/**
 * DER header for a PKCS#8-wrapped Ed25519 private key.
 *
 * Node has no "import these 32 raw seed bytes" API, but it does import PKCS#8, and the wrapper
 * around an Ed25519 seed is this fixed 16-byte prefix. Prepending it is what lets us derive the
 * public half of a seed we generated ourselves — which is exactly what Algorand's 64-byte
 * secret key format (seed ‖ public key) is.
 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** DER header for an SPKI-wrapped Ed25519 public key. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** RFC 4648 base32 alphabet, as used by Algorand addresses. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Bytes in an Algorand secret key: a 32-byte Ed25519 seed followed by the 32-byte public key. */
export const SECRET_KEY_BYTES = 64;

/** Bytes in an Ed25519 public key. */
export const PUBLIC_KEY_BYTES = 32;

/** Encodes bytes as unpadded RFC 4648 base32. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Derives an Algorand address from a raw Ed25519 public key.
 *
 * `address = base32(publicKey ‖ last4(sha512_256(publicKey)))`.
 */
export function addressFromPublicKey(publicKey: Buffer): string {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`public key must be ${PUBLIC_KEY_BYTES} bytes, got ${publicKey.length}`);
  }
  const checksum = createHash("sha512-256").update(publicKey).digest().subarray(28);
  return base32Encode(Buffer.concat([publicKey, checksum]));
}

/** Imports a raw 32-byte Ed25519 public key as a node `KeyObject`. */
export function publicKeyObject(publicKey: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
    format: "der",
    type: "spki",
  });
}

/** Imports the 32-byte seed half of an Algorand secret key as a node `KeyObject`. */
function privateKeyObject(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** An Ed25519 keypair in the shape Algorand and the mesh both expect. */
export interface AlgorandKeypair {
  /** 58-character Algorand address derived from `publicKey`. */
  address: string;
  /** Base64 of the 64-byte secret key (seed ‖ public key). Treat as a live secret. */
  secretKeyB64: string;
  /** Raw 32-byte public key. */
  publicKey: Buffer;
}

/** Splits a base64 Algorand secret key into its seed and public halves. */
export function decodeSecretKey(secretKeyB64: string): { seed: Buffer; publicKey: Buffer } {
  const bytes = Buffer.from(secretKeyB64, "base64");
  if (bytes.length !== SECRET_KEY_BYTES) {
    throw new Error(`secret key must decode to ${SECRET_KEY_BYTES} bytes, got ${bytes.length}`);
  }
  return { seed: bytes.subarray(0, 32), publicKey: bytes.subarray(32) };
}

/**
 * Generates a fresh Algorand keypair.
 *
 * The public key is derived from the seed by node rather than assumed, so the returned
 * `secretKeyB64` and `address` are guaranteed to correspond.
 */
export function generateKeypair(): AlgorandKeypair {
  const seed = randomBytes(32);
  const spki = createPublicKey(privateKeyObject(seed)).export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(spki.subarray(spki.length - PUBLIC_KEY_BYTES));
  const secretKey = Buffer.concat([seed, publicKey]);
  return {
    address: addressFromPublicKey(publicKey),
    secretKeyB64: secretKey.toString("base64"),
    publicKey,
  };
}

/** Signs bytes with an Algorand secret key, returning the 64-byte Ed25519 signature. */
export function signBytes(secretKeyB64: string, data: Uint8Array): Buffer {
  const { seed } = decodeSecretKey(secretKeyB64);
  return sign(null, data, privateKeyObject(seed));
}

/** Verifies an Ed25519 signature against a raw public key. Never throws on bad input. */
export function verifyBytes(publicKey: Buffer, data: Uint8Array, signature: Buffer): boolean {
  try {
    return verify(null, data, publicKeyObject(publicKey), signature);
  } catch {
    return false;
  }
}
