import { ALGORAND_TESTNET, type NodeCapability, type NodeRecord } from "@x402-mesh/shared";
import type { RequestOutcome } from "../src/index.js";

/** Deterministic 58-character base32 string that satisfies the Algorand address schema. */
export function testAddress(seed: string): string {
  const filler = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const sanitized = seed
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "X")
    .slice(0, 58);
  return (sanitized + filler.repeat(3)).slice(0, 58);
}

export interface NodeFixtureOverrides {
  nodeId?: string;
  capabilities?: NodeCapability[];
  healthy?: boolean;
  usdcOptedIn?: boolean;
  latencyMsP50?: number;
  latencyMsP95?: number;
  inFlight?: number;
  maxConcurrency?: number;
  uptimeRatio?: number;
  qualityScore?: number;
  consecutiveFailures?: number;
  lastSeenAt?: number;
  totalRequests?: number;
  totalPaidAtomic?: string;
  registeredAt?: number;
}

/**
 * Builds a schema-valid {@link NodeRecord}.
 *
 * Values are chosen so the record round-trips through `NodeRecordSchema`, which the Redis store
 * enforces on read — a fixture that skips that would pass in memory and silently fail on Redis.
 */
export function makeNode(overrides: NodeFixtureOverrides = {}): NodeRecord {
  const nodeId = overrides.nodeId ?? "node-a";
  const latencyMsP95 = overrides.latencyMsP95 ?? 200;
  return {
    registration: {
      nodeId,
      operatorAddress: testAddress(nodeId),
      endpoint: `https://${nodeId}.example.com`,
      capabilities: overrides.capabilities ?? [
        { model: "llama3.1:8b", contextWindow: 8192, pricePer1kTokensUsdc: "0.0010" },
      ],
      network: ALGORAND_TESTNET,
      version: "0.1.0",
      timestamp: 1_700_000_000_000,
      nonce: "0123456789abcdef0123456789abcdef",
    },
    health: {
      nodeId,
      healthy: overrides.healthy ?? true,
      latencyMsP50: overrides.latencyMsP50 ?? Math.min(latencyMsP95, 100),
      latencyMsP95,
      inFlight: overrides.inFlight ?? 0,
      maxConcurrency: overrides.maxConcurrency ?? 8,
      uptimeRatio: overrides.uptimeRatio ?? 1,
      qualityScore: overrides.qualityScore ?? 1,
      consecutiveFailures: overrides.consecutiveFailures ?? 0,
      lastSeenAt: overrides.lastSeenAt ?? 1_700_000_000_000,
    },
    usdcOptedIn: overrides.usdcOptedIn ?? true,
    totalRequests: overrides.totalRequests ?? 0,
    totalPaidAtomic: overrides.totalPaidAtomic ?? "0",
    registeredAt: overrides.registeredAt ?? 1_700_000_000_000,
  };
}

/** One request outcome, with `at` derived from the sequence index for stable ordering. */
export function outcome(
  success: boolean,
  latencyMs: number,
  at = 1_700_000_000_000,
): RequestOutcome {
  return { success, latencyMs, at };
}

/**
 * Cycles a fixed sequence of unit draws.
 *
 * Pinning the rng is what makes the weighted round-robin assertable: the distribution over many
 * draws is then a pure function of the candidate scores.
 */
export function pinnedRng(sequence: readonly number[]): () => number {
  let i = 0;
  return () => {
    const value = sequence[i % sequence.length] ?? 0;
    i += 1;
    return value;
  };
}
