import { describe, expect, it } from "vitest";
import { NoCapacityError } from "@x402-mesh/shared";
import { MemoryNodeStore, NodeSelector } from "@x402-mesh/registry";
import { NonceCache } from "../src/services/nonceCache.js";
import { RegistrySelectorAdapter, RegistryStoreAdapter } from "../src/services/registryAdapter.js";
import { makeClock, makeNodeRecord } from "./helpers.js";

/**
 * The seam between `@x402-mesh/registry` and the gateway's ports.
 *
 * These run against the *real* registry implementation rather than a stub: the whole point
 * of the adapter is to reconcile two genuinely different shapes, so testing it against a
 * mock of the thing it adapts would prove nothing.
 */

function build() {
  const clock = makeClock();
  const store = new MemoryNodeStore();
  const storePort = new RegistryStoreAdapter(store);
  const selectorPort = new RegistrySelectorAdapter(new NodeSelector(store), store, clock.now);
  return { store, storePort, selectorPort, clock };
}

function node(nodeId: string, at: number) {
  const record = makeNodeRecord({}, { nodeId });
  return { ...record, health: { ...record.health, nodeId, lastSeenAt: at } };
}

describe("RegistryStoreAdapter", () => {
  it("translates the registry's null into undefined", async () => {
    const { storePort } = build();
    expect(await storePort.get("ghost")).toBeUndefined();
    expect(await storePort.heartbeat("ghost", Date.now())).toBeUndefined();
  });

  it("returns what the store actually kept, not the caller's copy", async () => {
    const { storePort, clock } = build();
    const stored = await storePort.upsert(node("a", clock.now()));

    expect(stored.registration.nodeId).toBe("a");
    expect(await storePort.list()).toHaveLength(1);
  });

  it("expresses a heartbeat as a merge that advances lastSeenAt", async () => {
    const { storePort, clock } = build();
    await storePort.upsert(node("a", clock.now()));

    clock.advance(30_000);
    const beat = await storePort.heartbeat("a", clock.now());

    expect(beat?.health.lastSeenAt).toBe(clock.now());
    expect(beat?.health.consecutiveFailures).toBe(0);
  });

  it("does not let a heartbeat roll back lifetime counters", async () => {
    const { store, storePort, clock } = build();
    const record = node("a", clock.now());
    await storePort.upsert({ ...record, totalRequests: 7, totalPaidAtomic: "11900" });

    // A stale heartbeat carrying zeroed counters must not launder the node's history.
    clock.advance(1_000);
    await storePort.heartbeat("a", clock.now());

    const current = await store.get("a");
    expect(current?.totalRequests).toBe(7);
    expect(current?.totalPaidAtomic).toBe("11900");
    expect(current?.registeredAt).toBe(record.registeredAt);
  });
});

describe("RegistrySelectorAdapter", () => {
  it("selects a node that advertises the model", async () => {
    const { storePort, selectorPort, clock } = build();
    await storePort.upsert(node("a", clock.now()));

    const selection = await selectorPort.select({ model: "llama3.1:8b" });
    expect(selection.node.registration.nodeId).toBe("a");
  });

  it("forwards excludeNodeIds so a retry cannot pick the node that just failed", async () => {
    const { storePort, selectorPort, clock } = build();
    await storePort.upsert(node("a", clock.now()));
    await storePort.upsert(node("b", clock.now()));

    const selection = await selectorPort.select({
      model: "llama3.1:8b",
      excludeNodeIds: ["a"],
    });
    expect(selection.node.registration.nodeId).toBe("b");
  });

  it("raises NoCapacityError when nothing advertises the model", async () => {
    const { storePort, selectorPort, clock } = build();
    await storePort.upsert(node("a", clock.now()));

    await expect(selectorPort.select({ model: "mistral:7b" })).rejects.toBeInstanceOf(
      NoCapacityError,
    );
  });

  it("excludes a node whose operator is not opted in to USDC", async () => {
    const { storePort, selectorPort, clock } = build();
    await storePort.upsert({ ...node("a", clock.now()), usdcOptedIn: false });

    // Routing here would charge the client for work whose payout cannot land.
    await expect(selectorPort.select({ model: "llama3.1:8b" })).rejects.toBeInstanceOf(
      NoCapacityError,
    );
  });

  it("brackets in-flight accounting through the store", async () => {
    const { store, storePort, selectorPort, clock } = build();
    await storePort.upsert(node("a", clock.now()));

    await selectorPort.beginRequest("a");
    expect((await store.get("a"))?.health.inFlight).toBe(1);

    await selectorPort.endRequest("a");
    expect((await store.get("a"))?.health.inFlight).toBe(0);
  });

  it("stamps outcomes with the injected clock", async () => {
    const { store, storePort, selectorPort, clock } = build();
    await storePort.upsert(node("a", clock.now()));

    clock.advance(5_000);
    await selectorPort.recordOutcome("a", { success: true, latencyMs: 250 });

    const health = (await store.get("a"))?.health;
    expect(health?.lastSeenAt).toBe(clock.now());
    expect(health?.latencyMsP50).toBe(250);
  });

  it("takes a node out of rotation after repeated failures", async () => {
    const { storePort, selectorPort, clock } = build();
    await storePort.upsert(node("a", clock.now()));

    for (let i = 0; i < 3; i += 1) {
      await selectorPort.recordOutcome("a", { success: false, latencyMs: 500, error: "boom" });
    }

    await expect(selectorPort.select({ model: "llama3.1:8b" })).rejects.toBeInstanceOf(
      NoCapacityError,
    );
  });
});

describe("NonceCache", () => {
  it("claims a nonce exactly once", () => {
    const clock = makeClock();
    const cache = new NonceCache(clock.now);

    expect(cache.claim("abc")).toBe(true);
    expect(cache.claim("abc")).toBe(false);
  });

  it("forgets a nonce once it can no longer pass the freshness check", () => {
    const clock = makeClock();
    const cache = new NonceCache(clock.now, 1_000);

    expect(cache.claim("abc")).toBe(true);
    clock.advance(1_001);
    // Safe to forget: a registration carrying it would now fail on its timestamp anyway.
    expect(cache.claim("abc")).toBe(true);
  });

  it("stays bounded under a flood", () => {
    const clock = makeClock();
    const cache = new NonceCache(clock.now, 60_000, 10);

    for (let i = 0; i < 100; i += 1) cache.claim(`nonce-${i}`);

    expect(cache.size).toBeLessThanOrEqual(10);
  });
});
