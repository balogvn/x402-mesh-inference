import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { encodeAddress } from "@algorandfoundation/algokit-utils";
import type {
  GatewayConfig,
  NodeRecord,
  NodeRegistration,
  SettlementRecord,
  SignedNodeRegistration,
} from "@x402-mesh/shared";
import {
  ALGORAND_TESTNET,
  facilitatorNetwork,
  canonicalRegistrationBytes,
  NoCapacityError,
  registrationNonce,
} from "@x402-mesh/shared";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import type {
  ChainReaderPort,
  InboundSettlement,
  NodeOutcome,
  NodeSelectionCriteria,
  NodeSelectorPort,
  NodeStorePort,
  PayoutRequest,
  RouteInput,
  RouteResult,
  RouterPort,
  SettlementServicePort,
  UsdcPayoutPort,
} from "../src/ports.js";

/**
 * Test doubles and factories.
 *
 * Nothing here touches the network, algod, or a real wallet — that is the point of the port
 * boundary in `src/ports.ts`. Every stub records what it was asked to do so a test can
 * assert on behaviour rather than on internal state.
 */

/** An Ed25519 keypair plus the Algorand address it encodes to. */
export interface TestOperator {
  address: string;
  /** Raw 32-byte public key, base64 — the wire form used in `SignedNodeRegistration`. */
  publicKeyB64: string;
  privateKey: KeyObject;
}

/** Generates an operator identity. The Algorand address *is* the Ed25519 public key. */
export function makeOperator(): TestOperator {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Strip the 12-byte SPKI header to recover the raw key the address encodes.
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  return {
    address: encodeAddress(new Uint8Array(raw)),
    publicKeyB64: Buffer.from(raw).toString("base64"),
    privateKey,
  };
}

/** A syntactically valid, deliberately unfunded Algorand address for `payTo` in tests. */
export const TEST_PAY_TO = makeOperator().address;

/** Builds a gateway config with the defaults the production loader would produce. */
export function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 8402,
    host: "127.0.0.1",
    network: ALGORAND_TESTNET,
    meshNetwork: "testnet",
    facilitatorUrl: "https://facilitator.example.test",
    payToAddress: TEST_PAY_TO,
    inboundPriceUsdc: "0.0020",
    marginBps: 1500,
    publicBaseUrl: "https://mesh.test",
    requireUsdcOptIn: true,
    // Test nodes live on loopback, so the SSRF guard is relaxed by default here. The tests
    // that exercise the guard itself set this back to false explicitly.
    allowPrivateNodeEndpoints: true,
    nodeRequestTimeoutMs: 5_000,
    maxConcurrentPerNode: 8,
    logLevel: "silent",
    otelEnabled: false,
    challengeTag: "x402-global-challenge",
    ...overrides,
  };
}

/** Builds a signed registration for `operator`, valid at `now`. */
export function makeSignedRegistration(
  operator: TestOperator,
  overrides: Partial<NodeRegistration> = {},
  now = Date.now(),
): SignedNodeRegistration {
  const registration: NodeRegistration = {
    nodeId: "node-alpha",
    operatorAddress: operator.address,
    endpoint: "https://node-alpha.test",
    capabilities: [{ model: "llama3.1:8b", contextWindow: 8192, pricePer1kTokensUsdc: "0.0004" }],
    network: ALGORAND_TESTNET,
    version: "0.1.0",
    timestamp: now,
    nonce: registrationNonce(),
    ...overrides,
  };
  const signature = signEd25519(
    null,
    Buffer.from(canonicalRegistrationBytes(registration)),
    operator.privateKey,
  );
  return {
    registration,
    signature: signature.toString("base64"),
    publicKey: operator.publicKeyB64,
  };
}

/** Builds a healthy, routable node record. */
export function makeNodeRecord(
  overrides: Partial<NodeRecord> = {},
  registrationOverrides: Partial<NodeRegistration> = {},
): NodeRecord {
  const operator = makeOperator();
  const registration: NodeRegistration = {
    nodeId: "node-alpha",
    operatorAddress: operator.address,
    endpoint: "https://node-alpha.test",
    capabilities: [{ model: "llama3.1:8b", contextWindow: 8192, pricePer1kTokensUsdc: "0.0004" }],
    network: ALGORAND_TESTNET,
    version: "0.1.0",
    timestamp: Date.now(),
    nonce: registrationNonce(),
    ...registrationOverrides,
  };
  return {
    registration,
    health: {
      nodeId: registration.nodeId,
      healthy: true,
      latencyMsP50: 120,
      latencyMsP95: 240,
      inFlight: 0,
      maxConcurrency: 8,
      uptimeRatio: 1,
      qualityScore: 0.9,
      consecutiveFailures: 0,
      lastSeenAt: Date.now(),
    },
    usdcOptedIn: true,
    totalRequests: 0,
    totalPaidAtomic: "0",
    registeredAt: Date.now(),
    ...overrides,
  };
}

/** An in-memory {@link NodeStorePort} that records every call. */
export class StubStore implements NodeStorePort {
  readonly nodes = new Map<string, NodeRecord>();

  constructor(initial: NodeRecord[] = []) {
    for (const node of initial) this.nodes.set(node.registration.nodeId, node);
  }

  upsert(record: NodeRecord): NodeRecord {
    this.nodes.set(record.registration.nodeId, record);
    return record;
  }

  get(nodeId: string): NodeRecord | undefined {
    return this.nodes.get(nodeId);
  }

  list(): NodeRecord[] {
    return [...this.nodes.values()];
  }

  heartbeat(nodeId: string, at: number): NodeRecord | undefined {
    const node = this.nodes.get(nodeId);
    if (node === undefined) return undefined;
    const updated: NodeRecord = {
      ...node,
      health: { ...node.health, lastSeenAt: at, healthy: true, consecutiveFailures: 0 },
    };
    this.nodes.set(nodeId, updated);
    return updated;
  }
}

/** A {@link NodeSelectorPort} that hands out a fixed queue of nodes and logs every call. */
export class StubSelector implements NodeSelectorPort {
  readonly began: string[] = [];
  readonly ended: string[] = [];
  readonly outcomes: Array<{ nodeId: string; outcome: NodeOutcome }> = [];
  readonly selections: NodeSelectionCriteria[] = [];

  constructor(private readonly nodes: NodeRecord[]) {}

  select(criteria: NodeSelectionCriteria): { node: NodeRecord; score: number; reason: string } {
    this.selections.push({ ...criteria, excludeNodeIds: [...(criteria.excludeNodeIds ?? [])] });
    const excluded = new Set(criteria.excludeNodeIds ?? []);
    const node = this.nodes.find(
      (n) =>
        !excluded.has(n.registration.nodeId) &&
        n.registration.capabilities.some((c) => c.model === criteria.model),
    );
    if (node === undefined) {
      throw new NoCapacityError("no healthy node can serve the requested model", {
        model: criteria.model,
      });
    }
    return { node, score: 1, reason: "stub" };
  }

  beginRequest(nodeId: string): void {
    this.began.push(nodeId);
  }

  endRequest(nodeId: string): void {
    this.ended.push(nodeId);
  }

  recordOutcome(nodeId: string, outcome: NodeOutcome): void {
    this.outcomes.push({ nodeId, outcome });
  }
}

/** A {@link SettlementServicePort} that records rather than settles. */
export class StubSettlement implements SettlementServicePort {
  readonly routed: Array<{ requestId: string; nodeId: string; operatorAddress: string }> = [];
  readonly inbound: InboundSettlement[] = [];
  ledger: SettlementRecord[] = [];

  recordRouting(requestId: string, nodeId: string, operatorAddress: string): void {
    this.routed.push({ requestId, nodeId, operatorAddress });
  }

  settleInbound(inbound: InboundSettlement): void {
    this.inbound.push(inbound);
  }

  getSettlementLedger(): SettlementRecord[] {
    return this.ledger;
  }

  whenIdle(): Promise<void> {
    return Promise.resolve();
  }
}

/** A {@link RouterPort} returning a canned result, or throwing a canned error. */
export class StubRouter implements RouterPort {
  readonly calls: RouteInput[] = [];

  constructor(
    private readonly respond: (input: RouteInput) => Promise<RouteResult> | RouteResult,
  ) {}

  async route(input: RouteInput): Promise<RouteResult> {
    this.calls.push(input);
    return await this.respond(input);
  }
}

/** A {@link ChainReaderPort} with fixed answers. */
export class StubChain implements ChainReaderPort {
  readonly optInQueries: Array<{ address: string; assetId: string }> = [];

  constructor(
    private readonly optedIn: boolean,
    private readonly balanceMicro: bigint = 1_000_000n,
  ) {}

  isOptedIn(address: string, assetId: string): Promise<boolean> {
    this.optInQueries.push({ address, assetId });
    return Promise.resolve(this.optedIn);
  }

  getAlgoBalanceMicro(): Promise<bigint> {
    return Promise.resolve(this.balanceMicro);
  }
}

/** A {@link UsdcPayoutPort} that can be scripted to fail a number of times before succeeding. */
export class StubPayer implements UsdcPayoutPort {
  readonly senderAddress = TEST_PAY_TO;
  readonly payments: PayoutRequest[] = [];
  private remainingFailures: number;

  constructor(
    failures = 0,
    private readonly txId = "PAYOUTTX",
  ) {
    this.remainingFailures = failures;
  }

  pay(request: PayoutRequest): Promise<{ txId: string }> {
    this.payments.push(request);
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      return Promise.reject(new Error("algod unavailable"));
    }
    return Promise.resolve({ txId: `${this.txId}-${this.payments.length}` });
  }
}

/**
 * A {@link FacilitatorClient} that answers entirely from memory.
 *
 * `getSupported` advertises the `exact` scheme on Algorand TestNet using the **full padded
 * genesis hash**, because that is what the real GoPlausible facilitator returns. An earlier
 * version of this stub answered with the canonical (truncated) id, which no real facilitator
 * emits — so the suite passed while production died at boot with `missing_facilitator`.
 * Keep this faithful to the wire format; a stub that is kinder than reality tests nothing.
 */
export class StubFacilitator implements FacilitatorClient {
  verify(): Promise<{ isValid: boolean; invalidReason?: string }> {
    return Promise.resolve({ isValid: false, invalidReason: "stub facilitator" });
  }

  settle(): Promise<never> {
    return Promise.reject(new Error("stub facilitator cannot settle"));
  }

  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: facilitatorNetwork(ALGORAND_TESTNET),
          extra: { feePayer: TEST_PAY_TO },
        },
      ],
      extensions: ["bazaar"],
      signers: {},
    });
  }
}

/** A clock a test can advance by hand. */
export function makeClock(start = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Builds a `Response` whose body streams the supplied SSE frames. */
export function sseResponse(frames: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}
