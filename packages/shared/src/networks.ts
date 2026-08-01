import * as avm from "@x402/avm";
import type { Network } from "@x402/core/types";
import { ConfigError } from "./errors.js";

/**
 * Canonical CAIP-2 identifier for Algorand MainNet.
 *
 * Sourced from `@x402/avm` rather than typed by hand: Algorand CAIP-2 uses only the first
 * 32 characters of the url-safe base64 genesis hash, which is trivially mistyped.
 */
export const ALGORAND_MAINNET: Network = avm.ALGORAND_MAINNET_CAIP2;

/** Canonical CAIP-2 identifier for Algorand TestNet. */
export const ALGORAND_TESTNET: Network = avm.ALGORAND_TESTNET_CAIP2;

/** Human-facing network selector used in configuration and CLI flags. */
export type MeshNetwork = "mainnet" | "testnet";

/** USDC has 6 decimals on both Algorand networks, so $0.0020 === 2000 atomic units. */
export const USDC_DECIMALS = 6;

/** Every network the mesh will route on, in canonical form. */
const SUPPORTED_NETWORKS: readonly Network[] = [ALGORAND_MAINNET, ALGORAND_TESTNET];

/**
 * Resolves a {@link MeshNetwork} selector to its canonical CAIP-2 identifier.
 *
 * @throws {ConfigError} if the selector is not "mainnet" or "testnet".
 */
export function toCaip2(n: MeshNetwork): Network {
  switch (n) {
    case "mainnet":
      return ALGORAND_MAINNET;
    case "testnet":
      return ALGORAND_TESTNET;
    default:
      throw new ConfigError(`unknown mesh network: ${String(n)}`, {
        allowed: ["mainnet", "testnet"],
      });
  }
}

/**
 * Inverse of {@link toCaip2}: maps a canonical CAIP-2 identifier back to the selector.
 *
 * @throws {ConfigError} if the network is not a supported Algorand network.
 */
export function toMeshNetwork(network: Network): MeshNetwork {
  const canonical = normalizeNetwork(network);
  return canonical === ALGORAND_MAINNET ? "mainnet" : "testnet";
}

/**
 * Normalizes any externally-sourced network string to canonical CAIP-2 form.
 *
 * The live facilitator advertises the *full, padded* genesis hash
 * (`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=`) while the SDK constants use the
 * *truncated* 32-character form. They denote the same chain. Pipe every network string that
 * arrives from a facilitator, an HTTP body or the environment through this function before
 * storing or comparing it — never string-compare a raw value against a local constant.
 *
 * @throws {ConfigError} for non-strings, non-Algorand namespaces and unknown genesis hashes.
 */
export function normalizeNetwork(raw: string): Network {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ConfigError("network must be a non-empty CAIP-2 string", {
      received: typeof raw,
    });
  }
  const candidate = raw.trim();
  try {
    return avm.normalizeAlgorandNetwork(candidate);
  } catch {
    // The SDK throws a bare Error; re-raise as a ConfigError so callers get a status + code.
    throw new ConfigError(`unsupported network: ${candidate}`, {
      network: candidate,
      supported: [...SUPPORTED_NETWORKS],
    });
  }
}

/** True when `raw` names a network the mesh can settle on. Never throws. */
export function isSupportedNetwork(raw: string): boolean {
  try {
    normalizeNetwork(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the USDC ASA id (as a decimal string) for a network.
 *
 * Read from `avm.USDC_CONFIG` rather than hardcoded so that flipping the network can never
 * desync the asset id from the chain.
 *
 * @throws {ConfigError} if the network is unknown or carries no USDC configuration.
 */
export function usdcAssetId(network: Network): string {
  const canonical = normalizeNetwork(network);
  const entry = avm.USDC_CONFIG[canonical];
  if (!entry) {
    throw new ConfigError(`no USDC asset configured for network: ${canonical}`, {
      network: canonical,
    });
  }
  if (entry.decimals !== USDC_DECIMALS) {
    // A decimals mismatch would silently corrupt every atomic amount we compute.
    throw new ConfigError(
      `USDC decimals mismatch on ${canonical}: expected ${USDC_DECIMALS}, got ${entry.decimals}`,
      { network: canonical, expected: USDC_DECIMALS, actual: entry.decimals },
    );
  }
  return entry.asaId;
}
