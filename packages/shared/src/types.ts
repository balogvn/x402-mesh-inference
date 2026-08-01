import type { Network } from "@x402/core/types";

/**
 * Wire contract shared by the gateway, the registry and the node daemon.
 *
 * Monetary fields on these interfaces are **strings**, not bigints: they cross JSON
 * boundaries. Fields suffixed `Atomic` carry a decimal integer of atomic USDC units;
 * fields suffixed `Usdc` carry a decimal USDC amount. Convert at the boundary with
 * `wireToAtomic` / `usdcToAtomic` and do all arithmetic in bigint.
 */

/** One model a node advertises, with its context window and quoted price. */
export interface NodeCapability {
  /** Model identifier as the provider names it, e.g. "llama3.1:8b". */
  model: string;
  /** Maximum prompt + completion tokens the node will accept for this model. */
  contextWindow: number;
  /** Operator's quoted price per 1000 tokens, as a decimal USDC string. */
  pricePer1kTokensUsdc: string;
  /** Optional quantization label, e.g. "q4_K_M". */
  quantization?: string;
}

/** A node's self-declaration. This exact object is what gets signed. */
export interface NodeRegistration {
  /** Stable operator-chosen id, unique within the mesh. */
  nodeId: string;
  /** Algorand address that receives payouts. Must be opted in to USDC. */
  operatorAddress: string;
  /** Absolute http(s) URL the gateway forwards inference requests to. */
  endpoint: string;
  /** Models this node can serve. Must be non-empty. */
  capabilities: NodeCapability[];
  /** Canonical CAIP-2 network the node settles on. */
  network: Network;
  /** Node daemon version string. */
  version: string;
  /** Unix epoch milliseconds at signing time; checked against the replay skew window. */
  timestamp: number;
  /** Single-use random hex, 128 bits. */
  nonce: string;
}

/** A registration plus the Ed25519 proof that the operator key produced it. */
export interface SignedNodeRegistration {
  registration: NodeRegistration;
  /** Base64 Ed25519 signature over `canonicalRegistrationBytes(registration)`. */
  signature: string;
  /** Base64 Ed25519 public key; must correspond to `registration.operatorAddress`. */
  publicKey: string;
}

/**
 * Liveness and load report a node sends the gateway on every interval.
 *
 * Carries `timestamp` and `nonce` for the same reason a registration does: the gateway treats
 * a heartbeat as proof the operator is alive, so a captured one must not stay replayable.
 */
export interface NodeHeartbeat {
  /** Node id the gateway registered this daemon under. */
  nodeId: string;
  /** False when the local inference backend is not answering. */
  healthy: boolean;
  /** Requests currently executing on this node. */
  inFlight: number;
  /** Configured concurrency ceiling, so the gateway can compute headroom. */
  maxConcurrency: number;
  /** Daemon version string. */
  version: string;
  /** Unix epoch milliseconds at signing time. */
  timestamp: number;
  /** Single-use random hex, 128 bits. */
  nonce: string;
}

/** A heartbeat plus the Ed25519 proof that the operator key produced it. */
export interface SignedNodeHeartbeat {
  heartbeat: NodeHeartbeat;
  /** Base64 Ed25519 signature over `canonicalHeartbeatBytes`. */
  signature: string;
  /** Base64 Ed25519 public key; must match the node's registered operator address. */
  publicKey: string;
}

/** Rolling liveness and quality signal the registry maintains per node. */
export interface NodeHealth {
  nodeId: string;
  /** False once the node trips the failure threshold or misses heartbeats. */
  healthy: boolean;
  latencyMsP50: number;
  latencyMsP95: number;
  /** Requests currently in flight to this node. */
  inFlight: number;
  maxConcurrency: number;
  /** Fraction of heartbeat windows the node was reachable, in [0, 1]. */
  uptimeRatio: number;
  /** Composite routing score in [0, 1]; higher is better. */
  qualityScore: number;
  consecutiveFailures: number;
  /** Unix epoch milliseconds of the last successful heartbeat. */
  lastSeenAt: number;
}

/** Everything the registry stores about a node. */
export interface NodeRecord {
  registration: NodeRegistration;
  health: NodeHealth;
  /** Verified on-chain: the operator address holds the USDC ASA. */
  usdcOptedIn: boolean;
  totalRequests: number;
  /** Lifetime payout in atomic USDC units, as a decimal integer string. */
  totalPaidAtomic: string;
  registeredAt: number;
}

/** Router output: the chosen node plus why it won. */
export interface NodeSelection {
  node: NodeRecord;
  score: number;
  /** Operator-readable explanation, surfaced in logs and the debug header. */
  reason: string;
}

/** OpenAI-compatible chat message. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** OpenAI-compatible `POST /v1/chat/completions` request body. */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
}

/** OpenAI-compatible token accounting. */
export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** One completion alternative. */
export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

/** OpenAI-compatible non-streaming completion response. */
export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

/** One SSE frame of a streamed completion. */
export interface ChatCompletionChunkChoice {
  index: number;
  delta: Partial<ChatMessage>;
  finish_reason: string | null;
}

/** OpenAI-compatible streaming chunk. */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

/** Audit trail for one request's two-legged settlement. */
export interface SettlementRecord {
  requestId: string;
  nodeId: string;
  /** Algorand address that paid the gateway. */
  payerAddress: string;
  /** Algorand address that receives the operator payout. */
  operatorAddress: string;
  /** Atomic USDC decimal integer strings; `inbound - payout === margin`. */
  inboundAtomic: string;
  payoutAtomic: string;
  marginAtomic: string;
  /** Confirmed inbound (client -> gateway) transaction id. */
  inboundTxId: string;
  /** Confirmed payout (gateway -> operator) transaction id; null until settled. */
  payoutTxId: string | null;
  status: "pending" | "settled" | "failed";
  /** Operator-actionable failure reason when `status === "failed"`. */
  error?: string;
  createdAt: number;
  settledAt: number | null;
}
