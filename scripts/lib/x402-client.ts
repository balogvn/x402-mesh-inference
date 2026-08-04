/**
 * The x402 client-side wire contract, in one place.
 *
 * `e2e-simulate.ts` and `e2e-mainnet.ts` both have to read a 402 challenge and build a payment
 * against it. They each grew their own copy, and both copies were wrong in the same two ways.
 * Worse, the fixes were applied to the simulation script — the one being actively exercised —
 * and never carried to the MainNet script, which is the one that cannot be casually re-run:
 *
 *   - The challenge was read from the JSON body instead of the base64 `payment-required`
 *     header, so `accepts[]` was always empty. Fixed in e2e-simulate.ts, then rediscovered on
 *     MainNet.
 *   - The client scheme was registered against the canonical CAIP-2 network id while servers
 *     advertise the facilitator's full-genesis-hash form, so no payment could be built. Fixed
 *     in e2e-simulate.ts, then rediscovered on MainNet.
 *
 * Both are the kind of mistake that a *shared implementation* prevents structurally and a
 * consistency check only catches after the fact. This module is that shared implementation:
 * neither script may talk to the x402 client SDK directly.
 */

import * as avm from "@x402/avm";
import { ExactAvmScheme as ClientExactAvmScheme } from "@x402/avm/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";

/**
 * The CAIP-2 pattern the client registers against.
 *
 * Deliberately the wildcard rather than a concrete network id. A client matches a challenge's
 * `network` **verbatim**, and a server may legitimately advertise either encoding: the
 * canonical truncated genesis hash that `@x402/avm` exports as a constant, or the full padded
 * hash the GoPlausible facilitator returns from `/supported`. Registering one form makes the
 * other unpayable with "No network/scheme registered for x402 version: 2". The wildcard
 * matches both, which is the only thing that makes this robust against a server changing which
 * encoding it advertises.
 */
export const ALGORAND_WILDCARD = "algorand:*";

/**
 * Extracts the x402 challenge from a 402 response.
 *
 * x402 v2 carries the machine-readable challenge in the base64 `payment-required` **header**.
 * The JSON body is a human- and agent-readable preview and has no `accepts[]`, so reading the
 * body and casting it to `PaymentRequired` type-checks — the cast is unchecked — and then
 * yields a challenge with nothing to pay against.
 *
 * @param response - The 402 response from a paid route.
 * @returns The decoded challenge, or undefined when the header is absent or undecodable.
 */
export function readChallenge(response: Response): PaymentRequired | undefined {
  const header = response.headers.get("payment-required");
  if (header === null || header.trim() === "") return undefined;
  try {
    return decodePaymentRequiredHeader(header);
  } catch {
    return undefined;
  }
}

/** Builds payment headers for a challenge, using a real Algorand signer. */
export interface X402Payer {
  /** The Algorand address that will pay. */
  readonly address: string;
  /**
   * Builds the payment headers for a challenge.
   *
   * Returns the header MAP the SDK produced, never a bare value, because the header *name* is
   * part of the protocol: x402 v2 expects `PAYMENT-SIGNATURE`, and renaming it to `X-PAYMENT`
   * makes `paymentMiddleware` ignore the payment and answer 402 again. Callers must spread
   * this verbatim rather than picking a value out of it.
   */
  buildHeaders(challenge: PaymentRequired): Promise<Record<string, string>>;
}

/**
 * Creates a payer backed by the real `@x402/avm` client scheme.
 *
 * @param privateKeyBase64 - Base64 of the 64-byte Algorand secret key. Never logged.
 * @returns A payer that signs genuine Algorand atomic transaction groups.
 */
export function createX402Payer(privateKeyBase64: string): X402Payer {
  const signer = avm.toClientAvmSigner(privateKeyBase64);
  const client = new x402Client().register(ALGORAND_WILDCARD, new ClientExactAvmScheme(signer));
  const http = new x402HTTPClient(client);

  return {
    address: signer.address,
    buildHeaders: async (challenge: PaymentRequired): Promise<Record<string, string>> => {
      const payload = await http.createPaymentPayload(challenge);
      const headers = http.encodePaymentSignatureHeader(payload);
      if (Object.keys(headers).length === 0) {
        throw new Error("the x402 client produced no payment header");
      }
      return headers;
    },
  };
}
