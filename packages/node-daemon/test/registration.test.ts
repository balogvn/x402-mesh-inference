import { describe, expect, it } from "vitest";
import {
  UpstreamError,
  ValidationError,
  canonicalRegistrationBytes,
  registrationNonce,
} from "@x402-mesh/shared";
import type { DaemonConfig, NodeRegistration, SignedNodeRegistration } from "@x402-mesh/shared";
import { algorandAddressFromPublicKey, loadOperatorKey, verifySignatureB64 } from "../src/keys.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_PRICE_PER_1K_TOKENS_USDC,
  REGISTER_PATH,
  backoffMs,
  buildCapabilities,
  buildRegistration,
  isRetryableStatus,
  registerNode,
  signRegistration,
} from "../src/registration.js";
import { DAEMON_VERSION } from "../src/version.js";
import { daemonConfig, stubFetch } from "./helpers.js";

/**
 * Registration.
 *
 * A registration is the operator's signed claim about where payouts go. The properties that
 * matter are that the signature verifies against the advertised Algorand address, that any
 * tampering breaks it, and that a retry never reuses a nonce the gateway has already seen.
 */

function fixture(overrides: Record<string, string | undefined> = {}) {
  const cfg = daemonConfig(overrides);
  return { cfg, key: loadOperatorKey(cfg.privateKeyB64) };
}

/** Rebuilds an object with its keys in reverse order, to prove ordering is irrelevant. */
function reverseKeys<T extends object>(value: T): T {
  const source = value as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(source).reverse()) out[k] = source[k];
  return out as unknown as T;
}

function nonceOf(body: unknown): string {
  return (body as SignedNodeRegistration).registration.nonce;
}

describe("buildCapabilities", () => {
  it("advertises every configured model with the documented defaults", () => {
    const { cfg } = fixture({ MESH_MODELS: "llama3.1:8b,mistral:7b" });
    expect(buildCapabilities(cfg)).toEqual([
      {
        model: "llama3.1:8b",
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        pricePer1kTokensUsdc: DEFAULT_PRICE_PER_1K_TOKENS_USDC,
      },
      {
        model: "mistral:7b",
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        pricePer1kTokensUsdc: DEFAULT_PRICE_PER_1K_TOKENS_USDC,
      },
    ]);
  });

  it("applies operator overrides and omits quantization when unset", () => {
    const { cfg } = fixture();
    const [only] = buildCapabilities(cfg, {
      contextWindow: 32_768,
      pricePer1kTokensUsdc: "0.0025",
      quantization: "q4_K_M",
    });

    expect(only).toEqual({
      model: "llama3.1:8b",
      contextWindow: 32_768,
      pricePer1kTokensUsdc: "0.0025",
      quantization: "q4_K_M",
    });
    expect(buildCapabilities(cfg)[0]).not.toHaveProperty("quantization");
  });

  it("refuses to advertise a node with no models", () => {
    const { cfg } = fixture();
    // Registering with nothing to serve would have the gateway route work this node rejects.
    expect(() => buildCapabilities({ ...cfg, models: [] })).toThrow(ValidationError);
  });
});

describe("buildRegistration", () => {
  it("carries the configured identity, endpoint and network", () => {
    const { cfg, key } = fixture();
    const registration = buildRegistration(cfg, key);

    expect(registration.nodeId).toBe(cfg.nodeId);
    expect(registration.endpoint).toBe(cfg.endpoint);
    expect(registration.network).toBe(cfg.network);
    expect(registration.operatorAddress).toBe(key.address);
    expect(registration.version).toBe(DAEMON_VERSION);
  });

  it("mints a fresh nonce on every call", () => {
    const { cfg, key } = fixture();
    const nonces = new Set(Array.from({ length: 20 }, () => buildRegistration(cfg, key).nonce));

    // The gateway keeps a seen-nonce set; a reused nonce is rejected as a replay.
    expect(nonces.size).toBe(20);
    for (const nonce of nonces) expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("re-reads the clock on every call rather than caching a timestamp", () => {
    const { cfg, key } = fixture();
    let clock = 1_760_000_000_000;
    const now = (): number => clock;

    const first = buildRegistration(cfg, key, { now });
    clock += 5_000;
    const second = buildRegistration(cfg, key, { now });

    expect(first.timestamp).toBe(1_760_000_000_000);
    expect(second.timestamp).toBe(1_760_000_005_000);
    expect(second.timestamp).not.toBe(first.timestamp);
  });

  it("floors a fractional clock to integer milliseconds", () => {
    const { cfg, key } = fixture();
    expect(buildRegistration(cfg, key, { now: () => 1_760_000_000_000.9 }).timestamp).toBe(
      1_760_000_000_000,
    );
  });

  it("validates before returning, so a bad node id never reaches the wire", () => {
    const { cfg, key } = fixture();
    const broken: DaemonConfig = { ...cfg, nodeId: "not a legal node id" };
    expect(() => buildRegistration(broken, key)).toThrow(ValidationError);
  });
});

describe("signRegistration", () => {
  it("round-trips: the signature verifies against the operator's Algorand address", () => {
    const { cfg, key } = fixture();
    const registration = buildRegistration(cfg, key);
    const envelope = signRegistration(registration, key);

    expect(
      verifySignatureB64(
        envelope.publicKey,
        canonicalRegistrationBytes(envelope.registration),
        envelope.signature,
      ),
    ).toBe(true);
    // The public key in the envelope must be the one the payout address is derived from.
    expect(algorandAddressFromPublicKey(Buffer.from(envelope.publicKey, "base64"))).toBe(
      registration.operatorAddress,
    );
  });

  it("signs bytes that do not depend on key insertion order", () => {
    const { cfg, key } = fixture();
    const registration = buildRegistration(cfg, key);
    const envelope = signRegistration(registration, key);

    const shuffled = reverseKeys(registration);
    shuffled.capabilities = registration.capabilities.map((c) => reverseKeys(c));

    expect(Object.keys(shuffled)).not.toEqual(Object.keys(registration));
    expect(
      Buffer.from(canonicalRegistrationBytes(shuffled)).equals(
        Buffer.from(canonicalRegistrationBytes(registration)),
      ),
    ).toBe(true);
    expect(
      verifySignatureB64(
        envelope.publicKey,
        canonicalRegistrationBytes(shuffled),
        envelope.signature,
      ),
    ).toBe(true);
  });

  it("survives a round trip through JSON, which is how the gateway receives it", () => {
    const { cfg, key } = fixture();
    const envelope = signRegistration(buildRegistration(cfg, key), key);
    const wire = JSON.parse(JSON.stringify(envelope)) as SignedNodeRegistration;

    expect(
      verifySignatureB64(
        wire.publicKey,
        canonicalRegistrationBytes(wire.registration),
        wire.signature,
      ),
    ).toBe(true);
  });

  it("is invalidated by tampering with any signed field", () => {
    const { cfg, key } = fixture();
    const registration = buildRegistration(cfg, key);
    const envelope = signRegistration(registration, key);
    const other = loadOperatorKey(daemonConfig().privateKeyB64);

    const tampered: NodeRegistration[] = [
      // A rerouted endpoint would let an attacker serve traffic the operator was paid for.
      { ...registration, endpoint: "http://evil.example:9999" },
      // A rewritten payout address is the money-stealing edit.
      { ...registration, operatorAddress: other.address },
      { ...registration, nodeId: "someone-else" },
      { ...registration, capabilities: [{ ...registration.capabilities[0]!, model: "gpt-4o" }] },
      {
        ...registration,
        capabilities: [{ ...registration.capabilities[0]!, pricePer1kTokensUsdc: "9.9999" }],
      },
      { ...registration, capabilities: [{ ...registration.capabilities[0]!, contextWindow: 1 }] },
      { ...registration, timestamp: registration.timestamp + 1 },
      { ...registration, nonce: registrationNonce() },
      { ...registration, version: "9.9.9" },
    ];

    for (const mutated of tampered) {
      expect(
        verifySignatureB64(
          envelope.publicKey,
          canonicalRegistrationBytes(mutated),
          envelope.signature,
        ),
      ).toBe(false);
    }
  });

  it("rejects a signature from a different operator key", () => {
    const { cfg, key } = fixture();
    const registration = buildRegistration(cfg, key);
    const impostor = loadOperatorKey(daemonConfig().privateKeyB64);

    expect(
      verifySignatureB64(
        key.publicKeyB64,
        canonicalRegistrationBytes(registration),
        impostor.signB64(canonicalRegistrationBytes(registration)),
      ),
    ).toBe(false);
  });

  it("puts no private key material in the serialized envelope", () => {
    const { cfg, key } = fixture();
    const secret = Buffer.from(cfg.privateKeyB64, "base64");
    const seed = secret.subarray(0, 32);
    const serialized = JSON.stringify(signRegistration(buildRegistration(cfg, key), key));

    expect(serialized).not.toContain(cfg.privateKeyB64);
    expect(serialized).not.toContain(seed.toString("base64"));
    expect(serialized).not.toContain(seed.toString("hex"));
    expect(serialized).not.toContain(secret.toString("hex"));
    // Only the public half is disclosed.
    expect(serialized).toContain(key.publicKeyB64);
  });
});

describe("registerNode", () => {
  const options = { timeoutMs: 1_000, retryBaseMs: 0, random: () => 0 };

  it("POSTs a signed envelope to the gateway's register path", async () => {
    const { cfg, key } = fixture();
    const stub = stubFetch(() => ({ status: 201, body: { ok: true } }));

    const result = await registerNode(cfg, key, { ...options, fetchImpl: stub.fetch });

    expect(result.attempts).toBe(1);
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url).toBe(`${cfg.gatewayUrl}${REGISTER_PATH}`);
    expect(stub.calls[0]!.method).toBe("POST");
    expect(stub.calls[0]!.headers["content-type"]).toBe("application/json");
    expect(stub.calls[0]!.headers["user-agent"]).toContain("x402-mesh-node/");
  });

  it("sends an envelope the gateway can verify from the wire bytes alone", async () => {
    const { cfg, key } = fixture();
    const stub = stubFetch(() => ({ status: 200, body: {} }));
    await registerNode(cfg, key, { ...options, fetchImpl: stub.fetch });

    const envelope = stub.calls[0]!.body as SignedNodeRegistration;
    expect(
      verifySignatureB64(
        envelope.publicKey,
        canonicalRegistrationBytes(envelope.registration),
        envelope.signature,
      ),
    ).toBe(true);
    expect(algorandAddressFromPublicKey(Buffer.from(envelope.publicKey, "base64"))).toBe(
      envelope.registration.operatorAddress,
    );
  });

  it("never puts key material on the wire", async () => {
    const { cfg, key } = fixture();
    const stub = stubFetch(() => ({ status: 200, body: {} }));
    await registerNode(cfg, key, { ...options, fetchImpl: stub.fetch });

    const serialized = JSON.stringify(stub.calls[0]);
    const seed = Buffer.from(cfg.privateKeyB64, "base64").subarray(0, 32);
    expect(serialized).not.toContain(cfg.privateKeyB64);
    expect(serialized).not.toContain(seed.toString("base64"));
    expect(serialized).not.toContain(seed.toString("hex"));
  });

  it("re-signs with a fresh nonce on every retry", async () => {
    const { cfg, key } = fixture();
    const stub = stubFetch((_call, index) => (index < 2 ? { status: 503 } : { status: 200 }));

    const result = await registerNode(cfg, key, { ...options, fetchImpl: stub.fetch });

    expect(result.attempts).toBe(3);
    const nonces = stub.calls.map((c) => nonceOf(c.body));
    // A retry that reused the nonce would be rejected by the gateway as a replay.
    expect(new Set(nonces).size).toBe(3);
    // And each attempt must still be individually verifiable.
    for (const call of stub.calls) {
      const envelope = call.body as SignedNodeRegistration;
      expect(
        verifySignatureB64(
          envelope.publicKey,
          canonicalRegistrationBytes(envelope.registration),
          envelope.signature,
        ),
      ).toBe(true);
    }
    // The registration reported back is the one the gateway actually accepted.
    expect(result.registration.nonce).toBe(nonces[2]);
  });

  it("retries transport failures and reports the winning attempt", async () => {
    const { cfg, key } = fixture();
    const stub = stubFetch((_call, index) => {
      if (index === 0) throw new Error("ECONNREFUSED");
      return { status: 200, body: null };
    });

    const result = await registerNode(cfg, key, { ...options, fetchImpl: stub.fetch });
    expect(result.attempts).toBe(2);
    expect(result.body).toBeNull();
  });

  it("retries 429 and every 5xx", async () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      const { cfg, key } = fixture();
      const stub = stubFetch((_call, index) => (index === 0 ? { status } : { status: 200 }));
      const result = await registerNode(cfg, key, { ...options, fetchImpl: stub.fetch });
      expect(result.attempts).toBe(2);
    }
  });

  it("stops immediately on a fatal 4xx", async () => {
    for (const status of [400, 401, 403, 409, 422]) {
      const { cfg, key } = fixture();
      const stub = stubFetch(() => ({ status, text: "nope" }));

      await expect(registerNode(cfg, key, { ...options, fetchImpl: stub.fetch })).rejects.toThrow(
        UpstreamError,
      );
      // A rejected signature fails identically next time; retrying only delays the operator.
      expect(stub.calls).toHaveLength(1);
    }
  });

  it("gives up after maxAttempts and surfaces the last gateway status", async () => {
    const { cfg, key } = fixture();
    const stub = stubFetch(() => ({ status: 500, text: "gateway on fire" }));

    const failure = await registerNode(cfg, key, {
      ...options,
      fetchImpl: stub.fetch,
      maxAttempts: 3,
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(UpstreamError);
    expect((failure as UpstreamError).details).toMatchObject({ status: 500, nodeId: cfg.nodeId });
    expect((failure as UpstreamError).message).toContain("HTTP 500");
    expect(stub.calls).toHaveLength(3);
  });

  it("always makes at least one attempt", async () => {
    const { cfg, key } = fixture();
    const stub = stubFetch(() => ({ status: 200 }));
    await registerNode(cfg, key, { ...options, fetchImpl: stub.fetch, maxAttempts: 0 });
    expect(stub.calls).toHaveLength(1);
  });

  it("reports progress through onAttempt", async () => {
    const { cfg, key } = fixture();
    const stub = stubFetch((_call, index) => (index === 0 ? { status: 500 } : { status: 200 }));
    const seen: Array<[number, number]> = [];

    await registerNode(cfg, key, {
      ...options,
      fetchImpl: stub.fetch,
      maxAttempts: 4,
      onAttempt: (attempt, max) => seen.push([attempt, max]),
    });

    expect(seen).toEqual([
      [1, 4],
      [2, 4],
    ]);
  });

  it("propagates a caller abort instead of recording it as a gateway fault", async () => {
    const { cfg, key } = fixture();
    const controller = new AbortController();
    controller.abort();
    const stub = stubFetch(() => ({ status: 200 }));

    const failure = await registerNode(cfg, key, {
      ...options,
      fetchImpl: stub.fetch,
      signal: controller.signal,
    }).catch((cause: unknown) => cause);

    expect((failure as Error).name).toBe("AbortError");
    expect(failure).not.toBeInstanceOf(UpstreamError);
    expect(stub.calls).toHaveLength(1);
  });

  it("tolerates a success body that is empty or not JSON", async () => {
    const { cfg, key } = fixture();
    const empty = stubFetch(() => ({ status: 200, text: "   " }));
    await expect(
      registerNode(cfg, key, { ...options, fetchImpl: empty.fetch }).then((r) => r.body),
    ).resolves.toBeNull();

    const html = stubFetch(() => ({ status: 200, text: "<html>ok</html>" }));
    await expect(
      registerNode(cfg, key, { ...options, fetchImpl: html.fetch }).then((r) => r.body),
    ).resolves.toBeNull();
  });

  it("honours a gateway URL that carries a trailing slash", async () => {
    const { key } = fixture();
    const cfg = { ...daemonConfig(), gatewayUrl: "https://gw.test/" } as DaemonConfig;
    const stub = stubFetch(() => ({ status: 200 }));
    const scoped = loadOperatorKey(cfg.privateKeyB64);

    await registerNode(cfg, scoped, { ...options, fetchImpl: stub.fetch });
    expect(stub.calls[0]!.url).toBe(`https://gw.test${REGISTER_PATH}`);
    expect(key.address).toHaveLength(58);
  });
});

describe("retry policy", () => {
  it("classifies statuses the way the retry loop depends on", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 599]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
    for (const status of [200, 201, 400, 401, 403, 404, 409, 422, 451]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it("grows exponentially and stops at the cap", () => {
    // random() === 1 is out of range for Math.random, but it pins the upper bound exactly.
    expect(backoffMs(1, 500, 8_000, () => 0.999999)).toBe(499);
    expect(backoffMs(2, 500, 8_000, () => 0.999999)).toBe(999);
    expect(backoffMs(3, 500, 8_000, () => 0.999999)).toBe(1_999);
    expect(backoffMs(10, 500, 8_000, () => 0.999999)).toBe(7_999);
  });

  it("uses full jitter, so a fleet does not retry in lockstep", () => {
    expect(backoffMs(5, 500, 8_000, () => 0)).toBe(0);
    expect(backoffMs(5, 500, 8_000, () => 0.5)).toBe(4_000);
  });

  it("treats attempt 0 and 1 alike rather than inverting the exponent", () => {
    expect(backoffMs(0, 500, 8_000, () => 0.5)).toBe(backoffMs(1, 500, 8_000, () => 0.5));
  });
});
