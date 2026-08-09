import { describe, expect, it } from "vitest";
import { ALGORAND_MAINNET, ALGORAND_TESTNET } from "@x402-mesh/shared";
import { MemoryNodeStore, NodeSelector, isRoutable, unroutableReason } from "../src/index.js";
import { makeNode, type NodeFixtureOverrides } from "./fixtures.js";

/**
 * Routability, and the agreement between the two places that decide it.
 *
 * This predicate exists because those two places disagreed. `NodeSelector.select()` rejected
 * wrong-network, stale and non-opted-in nodes; the gateway's `/readyz` check applied only
 * `healthy && optedIn`. On a live MainNet gateway that produced "2/2 nodes routable" while the
 * selector would route to exactly one — the other was a TestNet leftover.
 *
 * A readiness endpoint that over-reports capacity is worse than one that under-reports: it
 * conceals an outage until traffic fails, which is the moment it existed to warn about.
 */

const MODEL = "llama3.1:8b";
const NOW = 1_700_000_000_000;

function record(overrides: NodeFixtureOverrides = {}) {
  return makeNode({
    network: ALGORAND_MAINNET,
    healthy: true,
    usdcOptedIn: true,
    lastSeenAt: NOW,
    ...overrides,
  });
}

const OPTIONS = { network: ALGORAND_MAINNET, staleAfterMs: 60_000, now: () => NOW };

describe("unroutableReason", () => {
  it("passes a node that is on-network, fresh, healthy and opted in", () => {
    expect(unroutableReason(record(), OPTIONS)).toBeNull();
    expect(isRoutable(record(), OPTIONS)).toBe(true);
  });

  it("rejects a node on another chain", () => {
    // The live case: a TestNet node left registered after the gateway flipped to MainNet.
    expect(unroutableReason(record({ network: ALGORAND_TESTNET }), OPTIONS)).toBe("wrongNetwork");
  });

  it("rejects a node that stopped heartbeating", () => {
    expect(unroutableReason(record({ lastSeenAt: NOW - 60_001 }), OPTIONS)).toBe("stale");
    // Exactly at the boundary is still fresh.
    expect(unroutableReason(record({ lastSeenAt: NOW - 60_000 }), OPTIONS)).toBeNull();
  });

  it("rejects an unhealthy node and one that cannot receive USDC", () => {
    expect(unroutableReason(record({ healthy: false }), OPTIONS)).toBe("unhealthy");
    expect(unroutableReason(record({ usdcOptedIn: false }), OPTIONS)).toBe("notOptedIn");
  });

  it("reports the wrong network ahead of unhealthiness", () => {
    // A node on the wrong chain is not broken, it is irrelevant. Calling it unhealthy sends an
    // operator to debug a node that is fine.
    const both = record({ network: ALGORAND_TESTNET, healthy: false });
    expect(unroutableReason(both, OPTIONS)).toBe("wrongNetwork");
  });

  it("reports staleness ahead of the health flag", () => {
    // The stored flag is a memory of when the node was last reachable, not a claim about now.
    const both = record({ lastSeenAt: NOW - 120_000, healthy: false });
    expect(unroutableReason(both, OPTIONS)).toBe("stale");
  });

  it("skips the checks it was given no basis for", () => {
    // A caller that does not know the network must not have every node declared wrong-network.
    expect(unroutableReason(record({ network: ALGORAND_TESTNET }), {})).toBeNull();
    expect(unroutableReason(record({ lastSeenAt: 0 }), { now: () => NOW })).toBeNull();
  });
});

describe("the selector and the readiness predicate agree", () => {
  /**
   * The drift guard. These are two code paths answering one question, and the bug this fixes
   * was precisely them answering it differently. If a future change makes the selector reject
   * something `unroutableReason` accepts, this fails.
   */
  const cases: Array<{ name: string; overrides: NodeFixtureOverrides }> = [
    { name: "fully routable", overrides: {} },
    { name: "wrong network", overrides: { network: ALGORAND_TESTNET } },
    { name: "stale", overrides: { lastSeenAt: NOW - 3_600_000 } },
    { name: "unhealthy", overrides: { healthy: false } },
    { name: "not opted in", overrides: { usdcOptedIn: false } },
    {
      name: "wrong network AND unhealthy",
      overrides: { network: ALGORAND_TESTNET, healthy: false },
    },
    { name: "stale AND not opted in", overrides: { lastSeenAt: 0, usdcOptedIn: false } },
  ];

  for (const { name, overrides } of cases) {
    it(`agrees on: ${name}`, async () => {
      const node = record(overrides);
      const store = new MemoryNodeStore();
      await store.upsert(node);

      const selector = new NodeSelector(store, {
        network: ALGORAND_MAINNET,
        staleAfterMs: 60_000,
        now: () => NOW,
      });

      const predicateSaysRoutable = isRoutable(node, OPTIONS);

      let selectorSaysRoutable: boolean;
      try {
        await selector.select(MODEL);
        selectorSaysRoutable = true;
      } catch {
        selectorSaysRoutable = false;
      }

      expect(
        predicateSaysRoutable,
        `the readiness predicate and the selector must not disagree about "${name}"`,
      ).toBe(selectorSaysRoutable);
    });
  }
});
