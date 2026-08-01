import { ALGORAND_MAINNET, normalizeNetwork, usdcAssetId } from "@x402-mesh/shared";
import type { Network } from "@x402/core/types";
import {
  DEFAULT_CONTROL_TIMEOUT_MS,
  baseHeaders,
  joinUrl,
  scopedSignal,
  transportError,
  upstreamErrorFrom,
} from "./http.js";
import type { FetchLike } from "./http.js";

/**
 * Minimal read-only algod client.
 *
 * `doctor` needs two facts about the operator account — is it funded above its minimum
 * balance, and has it opted in to USDC — and both are plain algod REST reads. Doing them with
 * `fetch` keeps the diagnostic path free of the heavyweight `algokit-utils` client (and its
 * ~300 ms import) that nothing else in the daemon needs.
 */

/** Public algod endpoints used when `ALGOD_URL` is not set. */
const DEFAULT_ALGOD_URL: Record<"mainnet" | "testnet", string> = {
  mainnet: "https://mainnet-api.algonode.cloud",
  testnet: "https://testnet-api.algonode.cloud",
};

/** Resolves the default algod endpoint for a canonical CAIP-2 network. */
export function defaultAlgodUrl(network: Network): string {
  return normalizeNetwork(network) === ALGORAND_MAINNET
    ? DEFAULT_ALGOD_URL.mainnet
    : DEFAULT_ALGOD_URL.testnet;
}

/** Construction options for {@link AlgodReader}. */
export interface AlgodReaderOptions {
  /** Algod base URL. Defaults to the public AlgoNode endpoint for the network. */
  baseUrl?: string;
  /** `X-Algo-API-Token` header value, for a node that requires one. Never logged. */
  token?: string;
  /** Injected `fetch`; defaults to the global. */
  fetchImpl?: FetchLike;
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number;
}

/** Balance facts about an Algorand account, in microALGO. */
export interface AccountSummary {
  /** ALGO balance in microALGO. */
  microAlgos: bigint;
  /** Minimum balance the account must retain, in microALGO. */
  minBalanceMicroAlgos: bigint;
  /** Number of ASAs the account has opted in to. */
  assetsOptedIn: number;
  /** False when the address has never been funded (algod reports 404). */
  exists: boolean;
}

/**
 * Read-only algod access for the `doctor` command.
 *
 * Balances are handled as `bigint` microALGO for the same reason USDC is: they are integer
 * atomic units, and a float would lose precision at large balances.
 */
export class AlgodReader {
  readonly baseUrl: string;

  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly token: string | undefined;

  constructor(network: Network, options: AlgodReaderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? defaultAlgodUrl(network)).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.token = options.token;
  }

  /**
   * Fetches balance and opt-in counts for an address.
   *
   * `?exclude=all` omits the (potentially large) asset and application arrays; the totals we
   * need are top-level fields.
   *
   * @throws {UpstreamError} if algod is unreachable or answers with an unexpected status.
   */
  async accountSummary(address: string): Promise<AccountSummary> {
    const url = `${joinUrl(this.baseUrl, `/v2/accounts/${encodeURIComponent(address)}`)}?exclude=all`;
    const res = await this.get(url, "account lookup");
    if (res.status === 404) {
      return {
        microAlgos: 0n,
        minBalanceMicroAlgos: 0n,
        assetsOptedIn: 0,
        exists: false,
      };
    }
    if (!res.ok) throw await upstreamErrorFrom("algod", res, "account lookup");

    const body = (await res.json()) as Record<string, unknown>;
    return {
      microAlgos: asBigint(body["amount"]),
      minBalanceMicroAlgos: asBigint(body["min-balance"]),
      assetsOptedIn: Number(asBigint(body["total-assets-opted-in"])),
      exists: true,
    };
  }

  /**
   * Reports whether `address` holds the given ASA.
   *
   * Algorand is opt-in: an account cannot *receive* an ASA it has not opted into, so a node
   * operator who skips this step silently fails every payout. Algod answers 404 for an
   * account that is not opted in — that is a definite "no", not an error.
   *
   * @throws {UpstreamError} on any status other than 2xx or 404.
   */
  async isOptedIn(address: string, assetId: string): Promise<boolean> {
    const url = joinUrl(
      this.baseUrl,
      `/v2/accounts/${encodeURIComponent(address)}/assets/${encodeURIComponent(assetId)}`,
    );
    const res = await this.get(url, "asset holding lookup");
    if (res.status === 404) {
      // Drain the body so the connection can be reused.
      await res.text().catch(() => "");
      return false;
    }
    if (!res.ok) throw await upstreamErrorFrom("algod", res, "asset holding lookup");
    await res.text().catch(() => "");
    return true;
  }

  /** Convenience wrapper: is `address` opted in to USDC on `network`? */
  async isOptedInToUsdc(address: string, network: Network): Promise<boolean> {
    return this.isOptedIn(address, usdcAssetId(network));
  }

  private async get(url: string, what: string): Promise<Response> {
    const scope = scopedSignal(this.timeoutMs);
    try {
      const headers = baseHeaders({ accept: "application/json" });
      if (this.token !== undefined) headers["x-algo-api-token"] = this.token;
      return await this.fetchImpl(url, { method: "GET", headers, signal: scope.signal });
    } catch (cause) {
      throw transportError("algod", what, cause);
    } finally {
      scope.dispose();
    }
  }
}

/** Coerces an algod numeric field to `bigint`, treating anything unusable as zero. */
function asBigint(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}
