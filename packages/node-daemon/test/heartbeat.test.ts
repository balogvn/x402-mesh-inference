import { afterEach, describe, expect, it, vi } from "vitest";
import { UpstreamError } from "@x402-mesh/shared";
import { domainSeparatedBytes } from "../src/canonical.js";
import {
  HEARTBEAT_DOMAIN,
  HeartbeatLoop,
  canonicalHeartbeatBytes,
  defaultHeartbeatPath,
  signHeartbeat,
} from "../src/heartbeat.js";
import type {
  HeartbeatOptions,
  NodeHeartbeat,
  Scheduler,
  SignedNodeHeartbeat,
} from "../src/heartbeat.js";
import { loadOperatorKey, verifySignatureB64 } from "../src/keys.js";
import { DAEMON_VERSION } from "../src/version.js";
import { daemonConfig, stubFetch } from "./helpers.js";
import type { FetchStub, StubResponse } from "./helpers.js";

/**
 * Liveness.
 *
 * The heartbeat is how the gateway decides a node is worth routing money-carrying traffic
 * to. A loop that stops beating quietly removes the node from the mesh; a loop that leaves a
 * timer behind stops the daemon from ever exiting.
 */

const HEARTBEAT: NodeHeartbeat = {
  nodeId: "node-1",
  healthy: true,
  inFlight: 2,
  maxConcurrency: 4,
  version: "0.1.0",
  timestamp: 1_760_000_000_000,
  nonce: "0123456789abcdef0123456789abcdef",
};

/** A scheduler the test drives by hand, recording every delay the loop asks for. */
function controllableScheduler() {
  const delays: number[] = [];
  const timers = new Map<number, () => void>();
  let nextId = 0;

  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => {
      delays.push(ms);
      nextId += 1;
      timers.set(nextId, fn);
      return nextId;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };

  return {
    scheduler,
    delays,
    get pending(): number {
      return timers.size;
    },
    /** Runs the armed timer and lets the resulting beat settle. */
    async fire(): Promise<void> {
      const entry = [...timers.entries()][0];
      if (!entry) throw new Error("no timer is armed");
      timers.delete(entry[0]);
      entry[1]();
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function build(
  respond: (index: number) => StubResponse,
  overrides: Partial<HeartbeatOptions> = {},
): {
  loop: HeartbeatLoop;
  stub: FetchStub;
  results: Array<{ ok: boolean; status: number | null; reregistered: boolean }>;
  reregisterCalls: number;
} {
  const config = daemonConfig();
  const key = loadOperatorKey(config.privateKeyB64);
  const stub = stubFetch((_call, index) => respond(index));
  const results: Array<{ ok: boolean; status: number | null; reregistered: boolean }> = [];
  let reregisterCalls = 0;

  const loop = new HeartbeatLoop({
    config,
    key,
    snapshot: () => ({ healthy: true, inFlight: 1 }),
    reregister: async () => {
      reregisterCalls += 1;
    },
    fetchImpl: stub.fetch,
    random: () => 0.5,
    onResult: (r) => results.push({ ok: r.ok, status: r.status, reregistered: r.reregistered }),
    ...overrides,
  });

  return {
    loop,
    stub,
    results,
    get reregisterCalls() {
      return reregisterCalls;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("canonicalHeartbeatBytes", () => {
  it("is domain-separated from a registration", () => {
    const bytes = new TextDecoder().decode(canonicalHeartbeatBytes(HEARTBEAT));
    expect(bytes.startsWith(`${HEARTBEAT_DOMAIN}\n`)).toBe(true);
    expect(HEARTBEAT_DOMAIN).not.toBe("x402-mesh/node-registration/v1");

    const asRegistration = domainSeparatedBytes("x402-mesh/node-registration/v1", HEARTBEAT);
    // A captured heartbeat signature must not verify as a registration.
    expect(
      Buffer.from(canonicalHeartbeatBytes(HEARTBEAT)).equals(Buffer.from(asRegistration)),
    ).toBe(false);
  });

  it("covers exactly the seven declared fields", () => {
    const json = new TextDecoder()
      .decode(canonicalHeartbeatBytes(HEARTBEAT))
      .slice(HEARTBEAT_DOMAIN.length + 1);
    expect(Object.keys(JSON.parse(json) as Record<string, unknown>).sort()).toEqual([
      "healthy",
      "inFlight",
      "maxConcurrency",
      "nodeId",
      "nonce",
      "timestamp",
      "version",
    ]);
  });

  it("ignores properties added in transit", () => {
    const smuggled = { ...HEARTBEAT, maxConcurrency: 4, injected: "ignored" };
    expect(
      Buffer.from(canonicalHeartbeatBytes(smuggled)).equals(
        Buffer.from(canonicalHeartbeatBytes(HEARTBEAT)),
      ),
    ).toBe(true);
  });

  it("is insensitive to key insertion order", () => {
    const reordered: NodeHeartbeat = {
      nonce: HEARTBEAT.nonce,
      version: HEARTBEAT.version,
      timestamp: HEARTBEAT.timestamp,
      maxConcurrency: HEARTBEAT.maxConcurrency,
      inFlight: HEARTBEAT.inFlight,
      healthy: HEARTBEAT.healthy,
      nodeId: HEARTBEAT.nodeId,
    };
    expect(
      Buffer.from(canonicalHeartbeatBytes(reordered)).equals(
        Buffer.from(canonicalHeartbeatBytes(HEARTBEAT)),
      ),
    ).toBe(true);
  });

  it("changes when any covered field changes", () => {
    const baseline = Buffer.from(canonicalHeartbeatBytes(HEARTBEAT));
    const mutations: NodeHeartbeat[] = [
      { ...HEARTBEAT, healthy: false },
      { ...HEARTBEAT, inFlight: 3 },
      { ...HEARTBEAT, nodeId: "node-2" },
      { ...HEARTBEAT, timestamp: HEARTBEAT.timestamp + 1 },
      { ...HEARTBEAT, nonce: "ffffffffffffffffffffffffffffffff" },
    ];
    for (const mutated of mutations) {
      expect(baseline.equals(Buffer.from(canonicalHeartbeatBytes(mutated)))).toBe(false);
    }
  });
});

describe("signHeartbeat", () => {
  it("produces a signature that verifies against the operator's public key", () => {
    const key = loadOperatorKey(daemonConfig().privateKeyB64);
    const envelope = signHeartbeat(HEARTBEAT, key);

    expect(
      verifySignatureB64(
        envelope.publicKey,
        canonicalHeartbeatBytes(envelope.heartbeat),
        envelope.signature,
      ),
    ).toBe(true);
  });

  it("is invalidated by tampering with the reported load", () => {
    const key = loadOperatorKey(daemonConfig().privateKeyB64);
    const envelope = signHeartbeat(HEARTBEAT, key);

    // Inflating headroom would let a node attract traffic it cannot serve.
    expect(
      verifySignatureB64(
        envelope.publicKey,
        canonicalHeartbeatBytes({ ...HEARTBEAT, inFlight: 0 }),
        envelope.signature,
      ),
    ).toBe(false);
  });
});

describe("defaultHeartbeatPath", () => {
  it("percent-encodes the node id", () => {
    expect(defaultHeartbeatPath("node-1")).toBe("/v1/nodes/node-1/heartbeat");
    expect(defaultHeartbeatPath("a/b?c")).toBe("/v1/nodes/a%2Fb%3Fc/heartbeat");
  });
});

describe("HeartbeatLoop.tick", () => {
  it("POSTs a verifiable signed beat and reports success", async () => {
    const { loop, stub } = build(() => ({ status: 200, body: { ok: true } }));

    const result = await loop.tick();

    expect(result).toEqual({ ok: true, status: 200, reregistered: false });
    expect(stub.calls[0]!.url).toBe(loop.endpoint);
    expect(stub.calls[0]!.url).toBe("https://gateway.test/v1/nodes/node-test-1/heartbeat");
    expect(stub.calls[0]!.method).toBe("POST");

    const envelope = stub.calls[0]!.body as SignedNodeHeartbeat;
    expect(
      verifySignatureB64(
        envelope.publicKey,
        canonicalHeartbeatBytes(envelope.heartbeat),
        envelope.signature,
      ),
    ).toBe(true);
  });

  it("reports the live snapshot and the configured ceiling", async () => {
    const { loop, stub } = build(() => ({ status: 200 }), {
      snapshot: () => ({ healthy: false, inFlight: 2 }),
    });
    await loop.tick();

    const { heartbeat } = stub.calls[0]!.body as SignedNodeHeartbeat;
    expect(heartbeat).toMatchObject({
      nodeId: "node-test-1",
      healthy: false,
      inFlight: 2,
      maxConcurrency: 2,
      version: DAEMON_VERSION,
    });
  });

  it("mints a fresh nonce and a current timestamp per beat", async () => {
    let clock = 1_760_000_000_000;
    const { loop, stub } = build(() => ({ status: 200 }), { now: () => clock });

    await loop.tick();
    clock += 1_000;
    await loop.tick();

    const beats = stub.calls.map((c) => (c.body as SignedNodeHeartbeat).heartbeat);
    // A replayed nonce is rejected by the gateway; a stale timestamp is rejected as skew.
    expect(beats[0]!.nonce).not.toBe(beats[1]!.nonce);
    expect(beats[0]!.timestamp).toBe(1_760_000_000_000);
    expect(beats[1]!.timestamp).toBe(1_760_000_001_000);
  });

  it("puts no key material on the wire", async () => {
    const config = daemonConfig();
    const key = loadOperatorKey(config.privateKeyB64);
    const stub = stubFetch(() => ({ status: 200 }));
    const loop = new HeartbeatLoop({
      config,
      key,
      snapshot: () => ({ healthy: true, inFlight: 0 }),
      reregister: async () => undefined,
      fetchImpl: stub.fetch,
    });

    await loop.tick();
    const serialized = JSON.stringify(stub.calls[0]);
    const seed = Buffer.from(config.privateKeyB64, "base64").subarray(0, 32);
    expect(serialized).not.toContain(config.privateKeyB64);
    expect(serialized).not.toContain(seed.toString("base64"));
    expect(serialized).not.toContain(seed.toString("hex"));
  });

  it("re-registers when the gateway has forgotten this node", async () => {
    for (const status of [404, 410]) {
      const fixture = build(() => ({ status }));
      const result = await fixture.loop.tick();

      // A restarted gateway with an in-memory registry must not need operator intervention.
      expect(result).toEqual({ ok: true, status, reregistered: true });
      expect(fixture.reregisterCalls).toBe(1);
      expect(fixture.loop.failureStreak).toBe(0);
    }
  });

  it("reports a failed re-registration rather than pretending to recover", async () => {
    const fixture = build(() => ({ status: 404 }), {
      reregister: async () => {
        throw new Error("gateway still down");
      },
    });

    const result = await fixture.loop.tick();
    expect(result.ok).toBe(false);
    expect(result.reregistered).toBe(false);
    expect(result.error?.message).toBe("gateway still down");
    expect(fixture.loop.failureStreak).toBe(1);
  });

  it("maps any other non-2xx to an UpstreamError carrying the status", async () => {
    const { loop } = build(() => ({ status: 503, text: "gateway overloaded" }));

    const result = await loop.tick();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toBeInstanceOf(UpstreamError);
    expect((result.error as UpstreamError).details).toMatchObject({
      status: 503,
      body: "gateway overloaded",
    });
  });

  it("reports a transport failure without a status", async () => {
    const config = daemonConfig();
    const loop = new HeartbeatLoop({
      config,
      key: loadOperatorKey(config.privateKeyB64),
      snapshot: () => ({ healthy: true, inFlight: 0 }),
      reregister: async () => undefined,
      fetchImpl: () => Promise.reject(new Error("EHOSTUNREACH")),
    });

    const result = await loop.tick();
    expect(result).toMatchObject({ ok: false, status: null, reregistered: false });
    expect(result.error?.message).toContain("EHOSTUNREACH");
  });

  it("reports a timeout as a timeout, not as a gateway rejection", async () => {
    const config = daemonConfig();
    const loop = new HeartbeatLoop({
      config,
      key: loadOperatorKey(config.privateKeyB64),
      snapshot: () => ({ healthy: true, inFlight: 0 }),
      reregister: async () => undefined,
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          init?.signal?.addEventListener("abort", () => reject(error), { once: true });
        }),
    });

    const result = await loop.tick();
    expect(result.status).toBeNull();
    expect(result.error).toBeInstanceOf(UpstreamError);
    expect(result.error?.message).toBe("heartbeat timed out");
  });

  it("never throws when the snapshot itself fails", async () => {
    const { loop } = build(() => ({ status: 200 }), {
      snapshot: () => {
        throw new Error("provider probe exploded");
      },
    });

    // An unhandled rejection inside a timer would take the daemon down.
    const result = await loop.tick();
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
  });

  it("counts consecutive failures and resets on the first success", async () => {
    const { loop } = build((index) => (index < 3 ? { status: 500 } : { status: 200 }));

    await loop.tick();
    expect(loop.failureStreak).toBe(1);
    await loop.tick();
    await loop.tick();
    expect(loop.failureStreak).toBe(3);
    await loop.tick();
    expect(loop.failureStreak).toBe(0);
  });
});

describe("HeartbeatLoop scheduling", () => {
  it("beats on the configured interval", async () => {
    const clock = controllableScheduler();
    const { loop, stub } = build(() => ({ status: 200 }), { scheduler: clock.scheduler });

    loop.start();
    expect(loop.isRunning).toBe(true);
    expect(clock.delays).toEqual([1_000]);

    await clock.fire();
    expect(stub.calls).toHaveLength(1);
    expect(clock.delays).toEqual([1_000, 1_000]);

    await clock.fire();
    expect(stub.calls).toHaveLength(2);
    expect(clock.delays).toEqual([1_000, 1_000, 1_000]);
    loop.stop();
  });

  it("is idempotent: a second start does not arm a second timer", () => {
    const clock = controllableScheduler();
    const { loop } = build(() => ({ status: 200 }), { scheduler: clock.scheduler });

    loop.start();
    loop.start();
    loop.start();

    expect(clock.delays).toEqual([1_000]);
    expect(clock.pending).toBe(1);
    loop.stop();
  });

  it("backs off exponentially while the gateway is failing, then recovers", async () => {
    const clock = controllableScheduler();
    const { loop } = build((index) => (index < 3 ? { status: 500 } : { status: 200 }), {
      scheduler: clock.scheduler,
    });

    loop.start();
    await clock.fire();
    await clock.fire();
    await clock.fire();
    await clock.fire();
    loop.stop();

    // Armed at: start, then after 1, 2, 3 failures, then after the success.
    expect(clock.delays).toEqual([1_000, 2_000, 4_000, 8_000, 1_000]);
  });

  it("caps the backoff so a long outage cannot push a node offline forever", async () => {
    const clock = controllableScheduler();
    const { loop } = build(() => ({ status: 500 }), {
      scheduler: clock.scheduler,
      maxBackoffMs: 5_000,
    });

    loop.start();
    for (let i = 0; i < 5; i += 1) await clock.fire();
    loop.stop();

    expect(clock.delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
  });

  it("applies jitter so a fleet does not come back in lockstep", () => {
    const low = controllableScheduler();
    const high = controllableScheduler();
    build(() => ({ status: 200 }), { scheduler: low.scheduler, random: () => 0 }).loop.start();
    build(() => ({ status: 200 }), { scheduler: high.scheduler, random: () => 1 }).loop.start();

    // ±20% of the 1 s interval.
    expect(low.delays).toEqual([800]);
    expect(high.delays).toEqual([1_200]);
  });

  it("never schedules a non-positive delay", () => {
    const clock = controllableScheduler();
    const config = { ...daemonConfig(), heartbeatIntervalMs: 1 };
    new HeartbeatLoop({
      config,
      key: loadOperatorKey(config.privateKeyB64),
      snapshot: () => ({ healthy: true, inFlight: 0 }),
      reregister: async () => undefined,
      fetchImpl: stubFetch(() => ({ status: 200 })).fetch,
      scheduler: clock.scheduler,
      random: () => 0,
    }).start();

    expect(clock.delays[0]).toBeGreaterThanOrEqual(1);
  });

  it("stops rescheduling once stopped, even mid-beat", async () => {
    const clock = controllableScheduler();
    let releaseFetch!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const config = daemonConfig();
    const loop = new HeartbeatLoop({
      config,
      key: loadOperatorKey(config.privateKeyB64),
      snapshot: () => ({ healthy: true, inFlight: 0 }),
      reregister: async () => undefined,
      scheduler: clock.scheduler,
      fetchImpl: async () => {
        await inFlight;
        return new Response(null, { status: 200 });
      },
    });

    loop.start();
    await clock.fire();
    expect(clock.pending).toBe(0);

    loop.stop();
    releaseFetch();
    await loop.drain();
    await new Promise((resolve) => setImmediate(resolve));

    expect(loop.isRunning).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("clears its timer on stop and tolerates a repeated stop", () => {
    const clock = controllableScheduler();
    const { loop } = build(() => ({ status: 200 }), { scheduler: clock.scheduler });

    loop.start();
    expect(clock.pending).toBe(1);
    loop.stop();
    loop.stop();

    expect(clock.pending).toBe(0);
    expect(loop.isRunning).toBe(false);
  });
});

describe("HeartbeatLoop with real timers", () => {
  it("leaves nothing pending after stop, so the process can exit", async () => {
    vi.useFakeTimers();
    const { loop, stub } = build(() => ({ status: 200 }));

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stub.calls).toHaveLength(1);

    // Another interval keeps it beating.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stub.calls).toHaveLength(2);

    loop.stop();
    await loop.drain();

    // A leftover timer would hold the event loop open after the server closed.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(stub.calls).toHaveLength(2);
  });

  it("does not beat before the first interval elapses", async () => {
    vi.useFakeTimers();
    const { loop, stub } = build(() => ({ status: 200 }));

    loop.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(stub.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(stub.calls).toHaveLength(1);
    loop.stop();
  });
});
