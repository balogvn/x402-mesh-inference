/**
 * Minimal algod REST client for the operator scripts.
 *
 * `algosdk` is not a dependency of this repo, and the scripts must not add one, so the two
 * things they actually need — an account's ALGO balance and its ASA holdings — are read
 * straight off the algod v2 REST API with `fetch`.
 *
 * All amounts returned by algod are integers in the asset's base unit (microALGO for ALGO,
 * atomic units for an ASA), so they are surfaced as `bigint` and never as `number`.
 */

import type { MeshNetwork } from "@x402-mesh/shared";
import { httpJson, type HttpError } from "./cli.js";

/** Public, no-token algod endpoints, used when `ALGOD_URL` is not configured. */
const DEFAULT_ALGOD_URL: Record<MeshNetwork, string> = {
  mainnet: "https://mainnet-api.algonode.cloud",
  testnet: "https://testnet-api.algonode.cloud",
};

/** MicroALGO in one ALGO. */
export const MICRO_ALGO = 1_000_000n;

/**
 * Base minimum balance requirement, in microALGO.
 *
 * Algorand charges 0.1 ALGO to keep an account open and a further 0.1 ALGO per opted-in
 * asset, so an account that must hold USDC needs at least 0.2 ALGO before it can transact.
 */
export const BASE_MBR_MICRO_ALGO = 100_000n;

/** Additional minimum balance requirement per opted-in ASA, in microALGO. */
export const PER_ASSET_MBR_MICRO_ALGO = 100_000n;

/** One ASA holding as algod reports it. */
export interface AlgodAssetHolding {
  "asset-id": number;
  amount: number;
  "is-frozen"?: boolean;
}

/** The subset of algod's account model these scripts use. */
export interface AlgodAccount {
  address: string;
  /** Total balance in microALGO. */
  amount: number;
  /** Current minimum balance requirement in microALGO. */
  "min-balance"?: number;
  assets?: AlgodAssetHolding[];
}

/** Resolved algod connection details. */
export interface AlgodConfig {
  url: string;
  /** Present only for private nodes; public AlgoNode endpoints need no token. */
  token?: string;
  /** True when the URL came from the environment rather than the built-in default. */
  fromEnv: boolean;
}

/**
 * Resolves algod connection details for a network.
 *
 * `ALGOD_URL` overrides the built-in public endpoint; `ALGOD_TOKEN` is only sent when set and
 * is never logged.
 */
export function resolveAlgod(
  network: MeshNetwork,
  env: NodeJS.ProcessEnv = process.env,
): AlgodConfig {
  const raw = env["ALGOD_URL"]?.trim();
  const token = env["ALGOD_TOKEN"]?.trim();
  const url = (raw !== undefined && raw.length > 0 ? raw : DEFAULT_ALGOD_URL[network]).replace(
    /\/+$/,
    "",
  );
  const config: AlgodConfig = { url, fromEnv: raw !== undefined && raw.length > 0 };
  if (token !== undefined && token.length > 0) config.token = token;
  return config;
}

function algodHeaders(config: AlgodConfig): Record<string, string> {
  return config.token === undefined ? {} : { "X-Algo-API-Token": config.token };
}

/**
 * Fetches algod's health/status. Resolves with the round number when the node is healthy.
 *
 * @throws {HttpError} when algod answers non-2xx, or a `TypeError` when it is unreachable.
 */
export async function algodStatus(config: AlgodConfig): Promise<{ lastRound: bigint }> {
  const body = await httpJson<{ "last-round"?: number }>(`${config.url}/v2/status`, {
    headers: algodHeaders(config),
  });
  return { lastRound: BigInt(body["last-round"] ?? 0) };
}

/**
 * Fetches an account.
 *
 * Returns `undefined` for an address algod does not know about — on Algorand an account with
 * no balance and no history simply does not exist yet, which is a normal, expected state for
 * a freshly generated key rather than an error.
 */
export async function fetchAccount(
  config: AlgodConfig,
  address: string,
): Promise<AlgodAccount | undefined> {
  try {
    return await httpJson<AlgodAccount>(
      `${config.url}/v2/accounts/${encodeURIComponent(address)}`,
      { headers: algodHeaders(config) },
    );
  } catch (e) {
    if (isHttpError(e) && (e.status === 404 || e.status === 400)) return undefined;
    throw e;
  }
}

function isHttpError(e: unknown): e is HttpError {
  return e instanceof Error && e.name === "HttpError" && "status" in e;
}

/** An account's position in one ASA. */
export interface AssetPosition {
  /** True when the account has opted in and can therefore receive the asset. */
  optedIn: boolean;
  /** Holding in atomic units. Zero when opted in but unfunded. */
  balanceAtomic: bigint;
  /** True when the asset manager has frozen this holding, which blocks transfers. */
  frozen: boolean;
}

/**
 * Reads an account's position in one ASA.
 *
 * The opt-in check is the important one: an Algorand account **cannot receive an asset it has
 * not opted into**, so a node operator or gateway that skips it will have every payout
 * rejected on chain after the client has already been charged.
 */
export function assetPosition(account: AlgodAccount | undefined, assetId: string): AssetPosition {
  const wanted = Number(assetId);
  const holding = account?.assets?.find((a) => a["asset-id"] === wanted);
  if (holding === undefined) return { optedIn: false, balanceAtomic: 0n, frozen: false };
  return {
    optedIn: true,
    balanceAtomic: BigInt(holding.amount),
    frozen: holding["is-frozen"] === true,
  };
}

/** Renders microALGO as a decimal ALGO string, using integer arithmetic only. */
export function formatAlgo(microAlgo: bigint): string {
  const whole = microAlgo / MICRO_ALGO;
  const fraction = (microAlgo % MICRO_ALGO).toString(10).padStart(6, "0");
  return `${whole.toString(10)}.${fraction} ALGO`;
}

/** Explorer links for a confirmed transaction, so an operator can verify a settlement. */
export function explorerLinks(network: MeshNetwork, txId: string): string[] {
  const lora = `https://lora.algokit.io/${network}/transaction/${txId}`;
  return network === "mainnet" ? [lora, `https://allo.info/tx/${txId}`] : [lora];
}

/** Explorer link for an account. */
export function accountExplorerLink(network: MeshNetwork, address: string): string {
  return `https://lora.algokit.io/${network}/account/${address}`;
}

/** Where to get funds for a network. */
export function faucetHints(network: MeshNetwork): string[] {
  if (network === "testnet") {
    return [
      "ALGO (TestNet): https://lora.algokit.io/testnet/fund",
      "USDC (TestNet): https://faucet.circle.com/  (choose Algorand TestNet)",
    ];
  }
  return [
    "ALGO (MainNet): buy on an exchange and withdraw to this address",
    "USDC (MainNet): withdraw USDC on the Algorand network (ASA 31566704), not on another chain",
  ];
}
