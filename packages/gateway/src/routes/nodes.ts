import { createPublicKey, verify as verifySignature } from "node:crypto";
import type {
  GatewayConfig,
  NodeHealth,
  NodeRecord,
  NodeRegistration,
  SignedNodeHeartbeat,
  SignedNodeRegistration,
} from "@x402-mesh/shared";
import {
  assertFreshTimestamp,
  assertRoutableEndpoint,
  AuthError,
  canonicalHeartbeatBytes,
  canonicalRegistrationBytes,
  parseOrThrow,
  SignedNodeHeartbeatSchema,
  SignedNodeRegistrationSchema,
  usdcAssetId,
  ValidationError,
} from "@x402-mesh/shared";
import { decodeAddress } from "@algorandfoundation/algokit-utils";
import { Router } from "express";
import type { Request, Response } from "express";
import type { Logger } from "../logger.js";
import { getRequestId } from "../middleware/requestId.js";
import type { ChainReaderPort, Clock, NodeStorePort } from "../ports.js";
import { NonceCache } from "../services/nonceCache.js";

/**
 * Node lifecycle: registration, heartbeat and public listing.
 *
 * Registration is the mesh's only trust boundary with operators, so it is defended in depth:
 * schema validation, timestamp freshness, single-use nonce, Ed25519 signature bound to the
 * operator's own Algorand address, network agreement, and an on-chain USDC opt-in check.
 * Each of those closes a different hole, and skipping any one of them produces a mesh that
 * looks fine until money moves.
 */

/**
 * DER prefix for an Ed25519 SubjectPublicKeyInfo.
 *
 * `node:crypto` will not accept a bare 32-byte Ed25519 public key, and an Algorand address
 * *is* a bare 32-byte Ed25519 public key (plus a checksum). Prepending this fixed 12-byte
 * SPKI header — `SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING }` — turns one into the
 * other, which is what lets registrations be verified with no third-party crypto dependency.
 * Round-tripped against a real signature in the test suite.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Bytes in a raw Ed25519 public key. */
const ED25519_PUBLIC_KEY_BYTES = 32;

/** Collaborators the node routes need. */
export interface NodeRouteDeps {
  config: GatewayConfig;
  store: NodeStorePort;
  chain: ChainReaderPort;
  logger: Logger;
  now?: Clock;
  nonces?: NonceCache;
}

/**
 * Builds the node lifecycle router.
 *
 * These endpoints are intentionally *not* behind the x402 paywall: an operator has to be
 * able to join the mesh before it has earned anything to pay with.
 */
export function createNodeRouter(deps: NodeRouteDeps): Router {
  const now = deps.now ?? Date.now;
  const nonces = deps.nonces ?? new NonceCache(now);
  const router = Router();

  router.post("/v1/nodes/register", (req, res, next) => {
    handleRegister(deps, nonces, now, req, res).catch(next);
  });

  router.post("/v1/nodes/:id/heartbeat", (req, res, next) => {
    handleHeartbeat(deps, nonces, now, req, res).catch(next);
  });

  router.get("/v1/nodes", (req, res, next) => {
    handleList(deps, req, res).catch(next);
  });

  return router;
}

async function handleRegister(
  deps: NodeRouteDeps,
  nonces: NonceCache,
  now: Clock,
  req: Request,
  res: Response,
): Promise<void> {
  const requestId = getRequestId(req);
  const signed = parseOrThrow(
    SignedNodeRegistrationSchema,
    req.body,
    "node registration",
  ) as SignedNodeRegistration;
  const registration = signed.registration;

  // 1. Freshness. Bounds how long a captured registration stays usable at all.
  assertFreshTimestamp(registration.timestamp, now());

  // 2. Single use. Freshness alone still permits unlimited replays inside the window.
  if (!nonces.claim(registration.nonce)) {
    throw new ValidationError("registration nonce has already been used", {
      nodeId: registration.nodeId,
    });
  }

  // 3. Authenticity, bound to the payout address. Verifying against `signed.publicKey` alone
  //    would let anyone register any endpoint under someone else's payout address; the key
  //    must be *derived from* `operatorAddress` for the signature to mean anything.
  verifyRegistrationSignature(signed);

  // 4. Network agreement. A node settling on a different chain can never be paid by us.
  if (registration.network !== deps.config.network) {
    throw new ValidationError("node settles on a different network than this gateway", {
      nodeNetwork: registration.network,
      gatewayNetwork: deps.config.network,
    });
  }

  // 5. Endpoint reachability class. The gateway makes outbound requests to this URL on every
  //    routed request, and registration is open to anyone who can generate a keypair. Without
  //    this check a registrant can aim the gateway at cloud metadata (169.254.169.254) or at
  //    services on the deployment's private network — a server-side request forgery.
  await assertRoutableEndpoint(registration.endpoint, {
    allowPrivate: deps.config.allowPrivateNodeEndpoints,
  });

  // 6. On-chain readiness. Algorand accounts cannot receive an ASA they have not opted into,
  //    so without this the first payout fails silently, after the client has been charged.
  const assetId = usdcAssetId(deps.config.network);
  const usdcOptedIn = await deps.chain.isOptedIn(registration.operatorAddress, assetId);
  if (!usdcOptedIn && deps.config.requireUsdcOptIn) {
    throw new ValidationError(
      "operator payout address has not opted in to USDC and cannot receive payouts",
      {
        operatorAddress: registration.operatorAddress,
        assetId,
        network: deps.config.network,
        remedy:
          `Send a 0-amount asset transfer of ASA ${assetId} from ` +
          `${registration.operatorAddress} to itself (an opt-in), keeping at least 0.1 ALGO ` +
          `of minimum balance per asset, then register again.`,
      },
    );
  }

  const existing = await deps.store.get(registration.nodeId);
  if (
    existing !== undefined &&
    existing.registration.operatorAddress !== registration.operatorAddress
  ) {
    // The node id is operator-chosen, so it is first-come-first-served. Letting a second
    // operator re-point an existing id would redirect another operator's earnings.
    throw new AuthError("node id is already registered to a different operator address", {
      nodeId: registration.nodeId,
    });
  }

  const record = buildRecord(registration, existing, usdcOptedIn, deps.config, now());
  const stored = await deps.store.upsert(record);

  deps.logger.info(
    {
      requestId,
      nodeId: registration.nodeId,
      operatorAddress: registration.operatorAddress,
      endpoint: registration.endpoint,
      models: registration.capabilities.map((c) => c.model),
      usdcOptedIn,
    },
    "node registered",
  );

  res.status(existing === undefined ? 201 : 200).json({
    nodeId: stored.registration.nodeId,
    usdcOptedIn: stored.usdcOptedIn,
    network: stored.registration.network,
    heartbeatIntervalMs: 15_000,
    registeredAt: stored.registeredAt,
    routable: stored.usdcOptedIn || !deps.config.requireUsdcOptIn,
  });
}

/**
 * Verifies a heartbeat's Ed25519 signature against the operator address recorded at
 * registration.
 *
 * `operatorAddress` is deliberately a parameter rather than a field of the signed payload:
 * the caller must pass the address from the gateway's own stored `NodeRecord`. A heartbeat
 * that carried its own address would let anyone sign with a fresh key, name any node, and be
 * believed — which is exactly the hole this closes.
 *
 * @param signed - The parsed heartbeat envelope.
 * @param operatorAddress - Address from the stored registration, never from the request.
 * @throws {AuthError} If the key does not match the address or the signature does not verify.
 */
export function verifyHeartbeatSignature(
  signed: SignedNodeHeartbeat,
  operatorAddress: string,
): void {
  let addressKey: Uint8Array;
  try {
    addressKey = decodeAddress(operatorAddress).publicKey;
  } catch {
    throw new AuthError("stored operator address is not a valid Algorand address", {
      nodeId: signed.heartbeat.nodeId,
    });
  }
  if (addressKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new AuthError("operator address did not yield a 32-byte Ed25519 public key");
  }

  if (!Buffer.from(addressKey).equals(Buffer.from(signed.publicKey, "base64"))) {
    throw new AuthError("heartbeat public key does not match the registered operator", {
      nodeId: signed.heartbeat.nodeId,
    });
  }

  const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(addressKey)]);
  let keyObject;
  try {
    keyObject = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    throw new AuthError("operator public key could not be imported for verification");
  }

  const ok = verifySignature(
    null,
    canonicalHeartbeatBytes(signed.heartbeat),
    keyObject,
    Buffer.from(signed.signature, "base64"),
  );
  if (!ok) {
    throw new AuthError("heartbeat signature verification failed", {
      nodeId: signed.heartbeat.nodeId,
    });
  }
}

async function handleHeartbeat(
  deps: NodeRouteDeps,
  nonces: NonceCache,
  now: Clock,
  req: Request,
  res: Response,
): Promise<void> {
  // Express 5 types a path parameter as `string | string[]` because a repeated segment can
  // match more than once; a single `:id` never does, so anything else is a malformed route.
  const raw = req.params["id"];
  const nodeId = typeof raw === "string" ? raw : undefined;
  if (nodeId === undefined || nodeId.length === 0) {
    throw new ValidationError("node id is required");
  }
  const signed = parseOrThrow(
    SignedNodeHeartbeatSchema,
    req.body ?? {},
    "heartbeat",
  ) as SignedNodeHeartbeat;
  const heartbeat = signed.heartbeat;

  // The node must already exist, and we read its operator address from OUR record rather
  // than from the request. Trusting a request-supplied address would make the signature
  // meaningless: an attacker would simply sign with their own key and name it.
  const existing = await deps.store.get(nodeId);
  if (existing === undefined) {
    throw new ValidationError("unknown node; register before sending heartbeats", { nodeId });
  }

  // The signed nodeId must match the path, or a heartbeat signed for node A could be
  // replayed against node B by the same operator.
  if (heartbeat.nodeId !== nodeId) {
    throw new AuthError("heartbeat nodeId does not match the path", {
      nodeId,
      signedNodeId: heartbeat.nodeId,
    });
  }

  // Freshness bounds how long a captured heartbeat stays usable at all...
  assertFreshTimestamp(heartbeat.timestamp, now());
  // ...and the nonce makes it single-use inside that window. Without both, one captured
  // beat would keep a dead node marked healthy indefinitely.
  if (!nonces.claim(heartbeat.nonce)) {
    throw new ValidationError("heartbeat nonce has already been used", { nodeId });
  }

  verifyHeartbeatSignature(signed, existing.registration.operatorAddress);

  const updated = await deps.store.heartbeat(nodeId, now());
  if (updated === undefined) {
    throw new ValidationError("unknown node; register before sending heartbeats", { nodeId });
  }

  res.status(200).json({
    nodeId,
    healthy: updated.health.healthy,
    lastSeenAt: updated.health.lastSeenAt,
    routable: updated.usdcOptedIn || !deps.config.requireUsdcOptIn,
  });
}

async function handleList(deps: NodeRouteDeps, _req: Request, res: Response): Promise<void> {
  const nodes = await deps.store.list();
  res.status(200).json({
    network: deps.config.network,
    count: nodes.length,
    nodes: nodes.map((node) => publicView(node, deps.config)),
  });
}

/**
 * Public projection of a node record.
 *
 * Registrations are self-published and signature-covered, so everything in them is already
 * public; what is withheld is the gateway's *internal* accounting — in-flight counts,
 * consecutive failure counters, lifetime payout totals — which would let a competing
 * operator infer load and time their own registrations against it.
 */
function publicView(node: NodeRecord, config: GatewayConfig): Record<string, unknown> {
  return {
    nodeId: node.registration.nodeId,
    operatorAddress: node.registration.operatorAddress,
    endpoint: node.registration.endpoint,
    network: node.registration.network,
    version: node.registration.version,
    capabilities: node.registration.capabilities,
    healthy: node.health.healthy,
    routable: node.health.healthy && (node.usdcOptedIn || !config.requireUsdcOptIn),
    usdcOptedIn: node.usdcOptedIn,
    latencyMsP50: Math.round(node.health.latencyMsP50),
    latencyMsP95: Math.round(node.health.latencyMsP95),
    uptimeRatio: node.health.uptimeRatio,
    qualityScore: node.health.qualityScore,
    lastSeenAt: node.health.lastSeenAt,
    registeredAt: node.registeredAt,
  };
}

/**
 * Verifies the operator's Ed25519 signature over `canonicalRegistrationBytes`.
 *
 * The verification key is derived from `registration.operatorAddress`, never taken on trust
 * from the payload — an Algorand address is a checksummed Ed25519 public key, so the address
 * that will receive payouts is the same key that must have signed. `signed.publicKey` is
 * cross-checked against that derivation and rejected on mismatch, so a payload cannot claim
 * one key while naming another address.
 *
 * @throws {AuthError} when the address is malformed, the declared key disagrees with the
 * address, or the signature does not verify.
 */
export function verifyRegistrationSignature(signed: SignedNodeRegistration): void {
  const { registration, signature, publicKey } = signed;

  let addressKey: Uint8Array;
  try {
    addressKey = decodeAddress(registration.operatorAddress).publicKey;
  } catch {
    throw new AuthError("operator address is not a valid Algorand address", {
      operatorAddress: registration.operatorAddress,
    });
  }
  if (addressKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new AuthError("operator address did not yield a 32-byte Ed25519 public key");
  }

  const declaredKey = Buffer.from(publicKey, "base64");
  if (!Buffer.from(addressKey).equals(declaredKey)) {
    throw new AuthError("declared public key does not match the operator address", {
      operatorAddress: registration.operatorAddress,
    });
  }

  const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(addressKey)]);
  let keyObject;
  try {
    keyObject = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    throw new AuthError("operator public key could not be imported for verification");
  }

  const message = canonicalRegistrationBytes(registration);
  const signatureBytes = Buffer.from(signature, "base64");
  const ok = verifySignature(null, message, keyObject, signatureBytes);
  if (!ok) {
    throw new AuthError("registration signature verification failed", {
      nodeId: registration.nodeId,
      operatorAddress: registration.operatorAddress,
    });
  }
}

/**
 * Produces the stored record.
 *
 * A re-registration preserves lifetime counters and the existing quality score — an operator
 * restarting their daemon should not get a free reputation reset, in either direction.
 */
function buildRecord(
  registration: NodeRegistration,
  existing: NodeRecord | undefined,
  usdcOptedIn: boolean,
  config: GatewayConfig,
  at: number,
): NodeRecord {
  const health: NodeHealth = {
    nodeId: registration.nodeId,
    healthy: true,
    latencyMsP50: existing?.health.latencyMsP50 ?? 0,
    latencyMsP95: existing?.health.latencyMsP95 ?? 0,
    inFlight: existing?.health.inFlight ?? 0,
    maxConcurrency: existing?.health.maxConcurrency ?? config.maxConcurrentPerNode,
    uptimeRatio: existing?.health.uptimeRatio ?? 1,
    // A brand-new node starts mid-scale: optimistic enough to receive traffic and prove
    // itself, pessimistic enough not to outrank a node with a demonstrated track record.
    qualityScore: existing?.health.qualityScore ?? 0.5,
    consecutiveFailures: 0,
    lastSeenAt: at,
  };

  return {
    registration,
    health,
    usdcOptedIn,
    totalRequests: existing?.totalRequests ?? 0,
    totalPaidAtomic: existing?.totalPaidAtomic ?? "0",
    registeredAt: existing?.registeredAt ?? at,
  };
}
