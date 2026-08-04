import { createHash } from "node:crypto";
import type { GatewayConfig } from "@x402-mesh/shared";
import { ConfigError, SettlementError } from "@x402-mesh/shared";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { getAlgokitSigner, toClientAvmSigner } from "@x402/avm";
import type { ChainReaderPort, PayoutRequest, UsdcPayoutPort } from "../ports.js";

/**
 * Algorand adapters: the only place in the gateway that talks to a chain.
 *
 * Everything above this file works against {@link ChainReaderPort} and
 * {@link UsdcPayoutPort}, so unit tests never construct an algod client, never need a funded
 * wallet, and never make a network call.
 */

/** Environment variables that redirect algod away from the public AlgoNode endpoints. */
export interface AlgodOverrides {
  /** Full algod base URL, e.g. `https://algod.example.com`. */
  server?: string;
  /** Algod port, when not implied by the URL. */
  port?: string;
  /** Algod API token. Never logged. */
  token?: string;
}

/**
 * Builds an `AlgorandClient` for the configured network.
 *
 * Defaults to AlgoKit's public MainNet/TestNet endpoints. When `ALGOD_SERVER` is present the
 * client is built from that instead, which is how a deployment points at its own node or a
 * paid API provider.
 *
 * @param config - Resolved gateway configuration (only `meshNetwork` is read).
 * @param overrides - Algod connection overrides, normally read from the environment.
 */
export function createAlgorandClient(
  config: Pick<GatewayConfig, "meshNetwork">,
  overrides: AlgodOverrides = {},
): AlgorandClient {
  if (overrides.server !== undefined && overrides.server.length > 0) {
    const algodConfig = {
      server: overrides.server,
      port: overrides.port,
      token: overrides.token ?? "",
    };
    return AlgorandClient.fromConfig({ algodConfig });
  }
  return config.meshNetwork === "mainnet" ? AlgorandClient.mainNet() : AlgorandClient.testNet();
}

/**
 * Reads algod connection overrides out of an environment.
 *
 * Kept separate from `loadGatewayConfig` because these are optional infrastructure knobs
 * rather than part of the economic configuration.
 */
export function readAlgodOverrides(env: NodeJS.ProcessEnv = process.env): AlgodOverrides {
  const overrides: AlgodOverrides = {};
  const server = env["ALGOD_SERVER"]?.trim();
  const port = env["ALGOD_PORT"]?.trim();
  const token = env["ALGOD_TOKEN"]?.trim();
  if (server) overrides.server = server;
  if (port) overrides.port = port;
  if (token) overrides.token = token;
  return overrides;
}

/**
 * The gateway's own wallet, derived from `AVM_PRIVATE_KEY`.
 *
 * The key never leaves this function: only the derived address and a signer bound into the
 * `AlgorandClient` escape, so no call site can accidentally log the secret.
 *
 * @param privateKeyBase64 - Base64 of the 64-byte Algorand secret key (seed ‖ public key).
 * @param algorand - Client the signer is registered against; it is mutated and returned.
 * @throws {ConfigError} when the key cannot be turned into a usable signer.
 */
export function attachGatewayWallet(
  privateKeyBase64: string,
  algorand: AlgorandClient,
): { address: string; algorand: AlgorandClient } {
  let address: string;
  try {
    const signer = toClientAvmSigner(privateKeyBase64);
    const algokitSigner = getAlgokitSigner(signer);
    if (algokitSigner === null) {
      throw new Error("signer does not expose an algokit transaction signer");
    }
    algorand.setSignerFromAccount(algokitSigner);
    address = signer.address;
  } catch (error) {
    // The message is constructed here rather than forwarded: the SDK's own error text can
    // embed fragments of the key material it failed to parse.
    throw new ConfigError("AVM_PRIVATE_KEY could not be turned into an Algorand signer", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
  return { address, algorand };
}

/** Reads account state from algod. */
export class AlgokitChainReader implements ChainReaderPort {
  constructor(private readonly algorand: AlgorandClient) {}

  /**
   * True when `address` has opted in to ASA `assetId`.
   *
   * Algod answers "not opted in" with a 404, which algokit surfaces as a thrown error, so a
   * lookup failure is interpreted as *not opted in* rather than propagated. That is the
   * conservative direction: a transient algod outage makes registration fail closed with an
   * actionable message instead of admitting a node whose payouts would bounce.
   */
  async isOptedIn(address: string, assetId: string): Promise<boolean> {
    try {
      const info = await this.algorand.asset.getAccountInformation(address, BigInt(assetId));
      return info !== undefined;
    } catch {
      return false;
    }
  }

  /** Spendable ALGO balance in microAlgos; used to detect an unfunded gateway wallet. */
  async getAlgoBalanceMicro(address: string): Promise<bigint> {
    const info = await this.algorand.account.getInformation(address);
    return info.balance.microAlgo;
  }
}

/**
 * Sends the operator payout as an Algorand USDC ASA transfer.
 *
 * Two defences beyond the caller's own idempotency guard:
 *
 * - **Lease.** Every transfer carries a 32-byte lease derived from the request id. Algorand
 *   rejects a second transaction from the same sender with the same lease inside the
 *   validity window, so even a duplicate submission across two gateway replicas cannot pay
 *   an operator twice for one request.
 * - **Note.** The request id is written into the transaction note, so an operator can
 *   reconcile an on-chain payment against `GET /v1/settlements` without trusting us.
 */
export class AlgokitUsdcPayer implements UsdcPayoutPort {
  constructor(
    readonly senderAddress: string,
    private readonly algorand: AlgorandClient,
  ) {}

  async pay(request: PayoutRequest): Promise<{ txId: string }> {
    if (request.amountAtomic <= 0n) {
      throw new SettlementError("refusing to submit a non-positive payout", {
        amount: request.amountAtomic.toString(10),
        requestId: request.requestId,
      });
    }
    const result = await this.algorand.send.assetTransfer({
      sender: this.senderAddress,
      receiver: request.receiver,
      assetId: BigInt(request.assetId),
      amount: request.amountAtomic,
      note: `x402-mesh/payout/${request.requestId}`,
      lease: payoutLease(request.requestId),
      suppressLog: true,
    });
    const txId = result.txIds[0];
    if (txId === undefined || txId.length === 0) {
      throw new SettlementError("payout submitted but algod returned no transaction id", {
        requestId: request.requestId,
      });
    }
    return { txId };
  }

  /**
   * Searches the chain for an already-committed payout for `requestId`.
   *
   * Every payout carries the note `x402-mesh/payout/<requestId>`, which makes it findable
   * after the fact. That matters because `pay` can submit successfully and then throw while
   * awaiting confirmation: the transfer is on chain, the caller just never learned its id.
   *
   * The receiver's transactions are searched rather than the sender's because the set is far
   * smaller, and the note is matched exactly so a different request's payout to the same
   * operator can never be mistaken for this one.
   *
   * @param requestId - The request whose payout to look for.
   * @param receiver - The operator address that would have been paid.
   * @returns The committed transaction id, or undefined if no payout has landed.
   */
  async findLandedPayout(
    requestId: string,
    receiver: string,
  ): Promise<{ txId: string } | undefined> {
    const wanted = `x402-mesh/payout/${requestId}`;
    try {
      const result = await this.algorand.client.indexer.searchForTransactions({
        address: receiver,
        notePrefix: Buffer.from(wanted, "utf8").toString("base64"),
        limit: 20,
      });
      for (const raw of result.transactions ?? []) {
        const t = raw as unknown as { id?: string; sender?: unknown; note?: unknown };
        if (String(t.sender) !== this.senderAddress) continue;
        // `notePrefix` is a prefix match, so `.../req-1` would also match `.../req-12`.
        // Require the decoded note to equal ours exactly.
        if (decodeNote(t.note) !== wanted) continue;
        if (typeof t.id === "string" && t.id.length > 0) return { txId: t.id };
      }
      return undefined;
    } catch {
      // A search failure must not be read as "no payout landed" — the caller treats undefined
      // as unknown and keeps its existing failure handling.
      return undefined;
    }
  }
}

/**
 * Derives the 32-byte transaction lease for a request id.
 *
 * SHA-256 is used purely as a fixed-width, collision-resistant encoding of an arbitrary
 * request id into the exact width Algorand requires.
 */
export function payoutLease(requestId: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`x402-mesh/payout/${requestId}`).digest());
}

/**
 * Decodes an indexer `note` field to a string.
 *
 * The indexer returns it as base64 text or as raw bytes depending on client version, and a
 * wrong guess here would silently make every note comparison fail — which would turn the
 * landed-payout check into a no-op that always reports "not found".
 *
 * @param note - The raw note value from an indexer transaction.
 * @returns The decoded UTF-8 note, or "" when it cannot be decoded.
 */
function decodeNote(note: unknown): string {
  if (typeof note === "string") return Buffer.from(note, "base64").toString("utf8");
  if (note instanceof Uint8Array) return Buffer.from(note).toString("utf8");
  return "";
}
