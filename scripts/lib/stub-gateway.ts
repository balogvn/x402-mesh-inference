/**
 * An in-process stand-in for the mesh gateway, used when the end-to-end harness runs without
 * secrets — which is how it runs in CI on every pull request.
 *
 * It is deliberately *not* a mock: it speaks the real wire contract, validates with the real
 * `@x402-mesh/shared` schemas, verifies real Ed25519 registration signatures over the real
 * canonical signing bytes, and computes the settlement split with the real `computeSplit`. The
 * only thing it fakes is the chain — a stub facilitator stands in for GoPlausible, so no ALGO,
 * no USDC and no network egress are required.
 *
 * What that buys: a green CI run means the protocol shape, the signature scheme and the money
 * arithmetic are all correct. What it does not buy: proof that a real Algorand transaction
 * group settles. `scripts/e2e-mainnet.ts` covers that, against real funds, on purpose.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ChatCompletionRequestSchema,
  MeshError,
  NoCapacityError,
  PaymentError,
  ValidationError,
  assertFreshTimestamp,
  assertSplitInvariant,
  atomicToWire,
  canonicalRegistrationBytes,
  computeSplit,
  normalizeNetwork,
  parseOrThrow,
  SignedNodeRegistrationSchema,
  toErrorResponse,
  usdcAssetId,
  usdcToAtomic,
  type NodeRecord,
  type SettlementRecord,
} from "@x402-mesh/shared";
import type { Network } from "@x402/core/types";
import { addressFromPublicKey, base32Encode, verifyBytes } from "./ed25519.js";

/** Options for {@link startStubGateway}. */
export interface StubGatewayOptions {
  network: Network;
  /** Algorand address the challenge tells clients to pay. */
  payTo: string;
  /** Decimal USDC price per request, e.g. `"0.0020"`. */
  inboundPriceUsdc: string;
  /** Gateway margin in basis points. */
  marginBps: number;
  /** Discovery tag advertised on the paid route. */
  challengeTag: string;
  /** How long the gateway waits on a node before giving up. */
  nodeRequestTimeoutMs?: number;
}

/** A running stub gateway. */
export interface StubGateway {
  url: string;
  close(): Promise<void>;
}

/** How long a 402 challenge stays valid for. */
const MAX_TIMEOUT_SECONDS = 120;

/** Bytes in an Algorand transaction id, which base32-encodes to 52 characters. */
const TXID_BYTES = 32;

/** Produces a syntactically plausible but entirely fake Algorand transaction id. */
function stubTxId(): string {
  return base32Encode(randomBytes(TXID_BYTES));
}

/**
 * The stub facilitator's view of one transaction in a payment group.
 *
 * The real `exact` scheme on Algorand carries base64 msgpack transactions here. Building those
 * needs a funded account and a live algod, so in stub mode each group member is base64 JSON of
 * this descriptor instead. The *validation* the stub facilitator performs against it — asset,
 * amount, receiver — is the same set of checks the real facilitator performs, which is what
 * makes a stub-mode pass meaningful.
 */
export interface StubTransferDescriptor {
  stub: true;
  from: string;
  to: string;
  assetId: string;
  /** Atomic units, as a decimal string. */
  amount: string;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown, extra = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString(10),
    ...extra,
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage, limitBytes = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new ValidationError("request body too large");
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("request body is not valid JSON");
  }
}

/**
 * Starts the stub gateway on an ephemeral loopback port.
 *
 * @returns The running server; always `await close()` it, or the harness will not exit.
 */
export async function startStubGateway(options: StubGatewayOptions): Promise<StubGateway> {
  const startedAt = Date.now();
  const network = normalizeNetwork(options.network);
  const assetId = usdcAssetId(network);
  const inboundAtomic = usdcToAtomic(options.inboundPriceUsdc);
  const split = computeSplit(inboundAtomic, options.marginBps);
  assertSplitInvariant(split);

  const nodes = new Map<string, NodeRecord>();
  const settlements: SettlementRecord[] = [];
  const seenNonces = new Set<string>();
  let baseUrl = "";

  /** The single payment option this gateway offers, shared by the 402 and the manifest. */
  function paymentRequirements(): Record<string, unknown> {
    return {
      scheme: "exact",
      network,
      asset: assetId,
      amount: atomicToWire(split.inbound),
      payTo: options.payTo,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: { name: "USDC", decimals: 6, feePayer: null },
    };
  }

  function paymentRequiredBody(error: string): Record<string, unknown> {
    return {
      x402Version: 2,
      error,
      resource: {
        url: `${baseUrl}/v1/chat/completions`,
        description: "Pay-per-prompt OpenAI-compatible LLM inference routed to community nodes.",
        mimeType: "application/json",
        serviceName: "x402 Mesh Inference",
        tags: [options.challengeTag, "ai", "inference", "llm", "algorand"],
      },
      accepts: [paymentRequirements()],
    };
  }

  /**
   * Headers accompanying a 402, matching what `@x402/express` emits on the real gateway.
   *
   * The real middleware puts the machine-readable challenge in a base64 `payment-required`
   * header and leaves the body as a human-readable preview. A stub that only populated the
   * body let the harness "pass" against a shape no real gateway produces — the same
   * stub-kinder-than-reality trap that hid the `missing_facilitator` boot failure. Emitting
   * the header keeps stub mode and live mode on one code path.
   *
   * @param body - The challenge object also being returned in the response body.
   * @returns Extra response headers to merge into the 402.
   */
  function paymentRequiredHeaders(body: Record<string, unknown>): Record<string, string> {
    return {
      "payment-required": Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
    };
  }

  /**
   * Stands in for the facilitator's verify + settle.
   *
   * Checks the same invariants the real one does: the accepted requirements must be the ones
   * we issued, and the transfer leg must move exactly the demanded amount of exactly the
   * demanded asset to exactly the demanded address.
   *
   * @throws {PaymentError} with an operator-actionable reason on any mismatch.
   */
  function stubVerifyAndSettle(headerValue: string): { payer: string; txId: string } {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
    } catch {
      throw new PaymentError("X-PAYMENT is not base64-encoded JSON");
    }
    if (payload["x402Version"] !== 2) {
      throw new PaymentError("unsupported x402Version", { expected: 2 });
    }
    const accepted = payload["accepted"] as Record<string, unknown> | undefined;
    if (accepted === undefined) throw new PaymentError("payment payload has no `accepted` block");

    const required = paymentRequirements();
    if (accepted["scheme"] !== required["scheme"]) {
      throw new PaymentError("ErrSchemeMismatch: accepted.scheme is not `exact`");
    }
    if (
      typeof accepted["network"] !== "string" ||
      normalizeNetwork(accepted["network"]) !== network
    ) {
      throw new PaymentError("ErrNetworkMismatch: accepted.network is not the offered chain");
    }
    if (accepted["asset"] !== required["asset"]) {
      throw new PaymentError("ErrAssetMismatch: accepted.asset is not the offered USDC ASA");
    }
    if (accepted["amount"] !== required["amount"]) {
      throw new PaymentError("ErrAmountMismatch: accepted.amount is not the quoted price");
    }
    if (accepted["payTo"] !== required["payTo"]) {
      throw new PaymentError("ErrReceiverMismatch: accepted.payTo is not this gateway");
    }

    const inner = payload["payload"] as Record<string, unknown> | undefined;
    const group = inner?.["paymentGroup"];
    const index = inner?.["paymentIndex"];
    if (!Array.isArray(group) || group.length === 0) {
      throw new PaymentError("payload.paymentGroup must be a non-empty array");
    }
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= group.length
    ) {
      throw new PaymentError("payload.paymentIndex is out of range");
    }
    const encoded = group[index];
    if (typeof encoded !== "string") {
      throw new PaymentError("payload.paymentGroup entries must be base64 strings");
    }

    let transfer: StubTransferDescriptor;
    try {
      transfer = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw new PaymentError("ErrSimulationFailed: transfer leg is not decodable");
    }
    if (transfer.stub !== true) {
      throw new PaymentError("ErrSimulationFailed: stub facilitator cannot settle a real group");
    }
    if (transfer.assetId !== assetId) {
      throw new PaymentError("ErrAssetMismatch: transfer moves the wrong asset");
    }
    if (transfer.to !== options.payTo) {
      throw new PaymentError("ErrReceiverMismatch: transfer pays the wrong address");
    }
    if (transfer.amount !== atomicToWire(split.inbound)) {
      throw new PaymentError("ErrAmountMismatch: transfer amount is not the quoted price");
    }
    return { payer: transfer.from, txId: stubTxId() };
  }

  /** Verifies a registration the way the gateway must: schema, freshness, key, signature. */
  function registerNode(raw: unknown): NodeRecord {
    const signed = parseOrThrow(SignedNodeRegistrationSchema, raw, "node registration");
    const { registration, signature, publicKey } = signed;
    assertFreshTimestamp(registration.timestamp);
    if (seenNonces.has(registration.nonce)) {
      throw new ValidationError("registration nonce has already been used");
    }
    const publicKeyBytes = Buffer.from(publicKey, "base64");
    if (addressFromPublicKey(publicKeyBytes) !== registration.operatorAddress) {
      throw new ValidationError("publicKey does not correspond to operatorAddress");
    }
    const ok = verifyBytes(
      publicKeyBytes,
      canonicalRegistrationBytes(registration),
      Buffer.from(signature, "base64"),
    );
    if (!ok) throw new ValidationError("signature does not verify against operatorAddress");
    if (normalizeNetwork(registration.network) !== network) {
      throw new ValidationError("node settles on a different network than this gateway");
    }
    seenNonces.add(registration.nonce);

    const now = Date.now();
    const record: NodeRecord = {
      registration,
      health: {
        nodeId: registration.nodeId,
        healthy: true,
        latencyMsP50: 0,
        latencyMsP95: 0,
        inFlight: 0,
        maxConcurrency: 8,
        uptimeRatio: 1,
        qualityScore: 1,
        consecutiveFailures: 0,
        lastSeenAt: now,
      },
      // The stub cannot query a chain, so it trusts the opt-in. The real gateway must not.
      usdcOptedIn: true,
      totalRequests: 0,
      totalPaidAtomic: "0",
      registeredAt: now,
    };
    nodes.set(registration.nodeId, record);
    return record;
  }

  function selectNode(model: string): NodeRecord {
    for (const record of nodes.values()) {
      if (!record.health.healthy || !record.usdcOptedIn) continue;
      if (record.registration.capabilities.some((c) => c.model === model)) return record;
    }
    throw new NoCapacityError(`no healthy node advertises model ${model}`, { model });
  }

  /** Appends the settled record, re-asserting the invariant before it is published. */
  function recordSettlement(input: {
    requestId: string;
    node: NodeRecord;
    payer: string;
    inboundTxId: string;
  }): SettlementRecord {
    assertSplitInvariant(split);
    const now = Date.now();
    const record: SettlementRecord = {
      requestId: input.requestId,
      nodeId: input.node.registration.nodeId,
      payerAddress: input.payer,
      operatorAddress: input.node.registration.operatorAddress,
      inboundAtomic: atomicToWire(split.inbound),
      payoutAtomic: atomicToWire(split.payout),
      marginAtomic: atomicToWire(split.margin),
      inboundTxId: input.inboundTxId,
      payoutTxId: stubTxId(),
      status: "settled",
      createdAt: now,
      settledAt: now,
    };
    settlements.unshift(record);
    input.node.totalRequests += 1;
    input.node.totalPaidAtomic = (BigInt(input.node.totalPaidAtomic) + split.payout).toString(10);
    return record;
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const { status, body } = toErrorResponse(e);
      jsonResponse(res, status, body);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", baseUrl === "" ? "http://gateway.invalid" : baseUrl);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/healthz") {
      jsonResponse(res, 200, {
        status: "ok",
        version: "0.1.0-stub",
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      });
      return;
    }

    if (method === "GET" && path === "/readyz") {
      const healthy = [...nodes.values()].filter((n) => n.health.healthy).length;
      const checks = [
        { name: "config", ok: true },
        { name: "facilitator", ok: true, detail: "stub facilitator (no chain)" },
        { name: "registry", ok: true, detail: "in-memory" },
        { name: "nodes", ok: healthy > 0, detail: `${healthy} healthy` },
      ];
      const ready = checks.every((c) => c.ok);
      jsonResponse(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", checks });
      return;
    }

    if (method === "GET" && path === "/.well-known/x402") {
      jsonResponse(res, 200, {
        x402Version: 2,
        serviceName: "x402 Mesh Inference",
        description: "Decentralized pay-per-prompt AI inference settled in USDC on Algorand.",
        items: [
          {
            resource: `${baseUrl}/v1/chat/completions`,
            type: "http",
            x402Version: 2,
            accepts: [paymentRequirements()],
            lastUpdated: new Date(startedAt).toISOString(),
            mimeType: "application/json",
            serviceName: "x402 Mesh Inference",
            tags: [options.challengeTag, "ai", "inference", "llm", "algorand"],
          },
        ],
      });
      return;
    }

    if (method === "POST" && path === "/v1/nodes/register") {
      const record = registerNode(await readJsonBody(req));
      jsonResponse(res, 201, record);
      return;
    }

    const heartbeat = /^\/v1\/nodes\/([^/]+)\/heartbeat$/.exec(path);
    if (method === "POST" && heartbeat !== null) {
      const nodeId = decodeURIComponent(heartbeat[1] ?? "");
      const record = nodes.get(nodeId);
      if (record === undefined) throw new ValidationError("unknown nodeId", { nodeId });
      await readJsonBody(req);
      record.health.lastSeenAt = Date.now();
      record.health.healthy = true;
      jsonResponse(res, 200, record.health);
      return;
    }

    if (method === "GET" && path === "/v1/nodes") {
      const all = [...nodes.values()];
      jsonResponse(res, 200, { nodes: all, count: all.length });
      return;
    }

    if (method === "GET" && path === "/v1/settlements") {
      jsonResponse(res, 200, {
        settlements,
        count: settlements.length,
        nextCursor: null,
      });
      return;
    }

    if (method === "POST" && path === "/v1/chat/completions") {
      const body = parseOrThrow(
        ChatCompletionRequestSchema,
        await readJsonBody(req),
        "chat completion request",
      );

      const header = req.headers["x-payment"] ?? req.headers["payment-signature"];
      const headerValue = Array.isArray(header) ? header[0] : header;
      if (headerValue === undefined || headerValue.trim() === "") {
        const challenge = paymentRequiredBody("X-PAYMENT header is required");
        jsonResponse(res, 402, challenge, paymentRequiredHeaders(challenge));
        return;
      }

      let settled: { payer: string; txId: string };
      try {
        settled = stubVerifyAndSettle(headerValue.trim());
      } catch (e) {
        if (e instanceof PaymentError) {
          const challenge = paymentRequiredBody(e.message);
          jsonResponse(res, 402, challenge, paymentRequiredHeaders(challenge));
          return;
        }
        throw e;
      }

      // Routing happens only after the money is captured, exactly as in the real gateway.
      const node = selectNode(body.model);
      const requestId = `req_${randomBytes(8).toString("hex")}`;
      const record = recordSettlement({
        requestId,
        node,
        payer: settled.payer,
        inboundTxId: settled.txId,
      });

      const settleResponse = Buffer.from(
        JSON.stringify({
          success: true,
          transaction: settled.txId,
          network,
          payer: settled.payer,
          amount: record.inboundAtomic,
        }),
      ).toString("base64");

      const upstream = await fetch(`${node.registration.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.nodeRequestTimeoutMs ?? 30_000),
      });

      const meshHeaders = {
        "PAYMENT-RESPONSE": settleResponse,
        "X-Mesh-Node-Id": node.registration.nodeId,
        "X-Mesh-Request-Id": requestId,
        "X-Mesh-Route-Reason": `only healthy node advertising ${body.model}`,
      };

      if (body.stream === true && upstream.body !== null) {
        res.writeHead(upstream.status, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          ...meshHeaders,
        });
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
        return;
      }

      jsonResponse(res, upstream.status, await upstream.json(), meshHeaders);
      return;
    }

    const notFound = new ValidationError(`no route for ${method} ${path}`);
    const { status, body } = toErrorResponse(notFound);
    jsonResponse(res, status === 400 ? 404 : status, body);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    url: baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

/** Re-exported so the harness and the stub agree on the shape without duplicating it. */
export function encodeStubPayment(input: {
  network: Network;
  assetId: string;
  amountAtomic: string;
  payTo: string;
  payer: string;
  feePayer: string;
}): string {
  const transfer: StubTransferDescriptor = {
    stub: true,
    from: input.payer,
    to: input.payTo,
    assetId: input.assetId,
    amount: input.amountAtomic,
  };
  const feeLeg = {
    stub: true,
    from: input.feePayer,
    to: input.feePayer,
    assetId: "0",
    amount: "0",
  };
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: input.network,
      asset: input.assetId,
      amount: input.amountAtomic,
      payTo: input.payTo,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: { name: "USDC", decimals: 6, feePayer: null },
    },
    payload: {
      // Index 0 is the sponsor's fee leg, index 1 is the client's transfer — the same layout
      // the real AVM scheme produces for a gasless payment.
      paymentGroup: [
        Buffer.from(JSON.stringify(feeLeg)).toString("base64"),
        Buffer.from(JSON.stringify(transfer)).toString("base64"),
      ],
      paymentIndex: 1,
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** Raised by the harness when the stub gateway rejects something it should have accepted. */
export function isMeshError(e: unknown): e is MeshError {
  return e instanceof MeshError;
}
