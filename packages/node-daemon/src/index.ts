/**
 * `@x402-mesh/node-daemon` — the provider side of the mesh.
 *
 * A GPU operator runs this to advertise a local inference backend, prove liveness to the
 * gateway with signed heartbeats, and serve the paid requests the gateway routes to it. The
 * daemon never handles a payment: the gateway settles with the client and pays the operator's
 * Algorand address out of band, which is why registration is signed — the address in a
 * registration is a claim about where money should go, and it must be provable.
 *
 * Everything is exported so the e2e harness can drive a node in-process; the CLI in
 * `cli.ts` is the supported operator interface.
 */
export { canonicalJson, domainSeparatedBytes } from "./canonical.js";
export { AlgodReader, defaultAlgodUrl } from "./algod.js";
export type { AccountSummary, AlgodReaderOptions } from "./algod.js";
export { runDoctor, formatReport } from "./doctor.js";
export type { CheckResult, CheckStatus, DoctorOptions, DoctorReport } from "./doctor.js";
export {
  HeartbeatLoop,
  HEARTBEAT_DOMAIN,
  canonicalHeartbeatBytes,
  defaultHeartbeatPath,
  signHeartbeat,
} from "./heartbeat.js";
export type {
  HeartbeatOptions,
  HeartbeatSnapshot,
  HeartbeatTickResult,
  NodeHeartbeat,
  Scheduler,
  SignedNodeHeartbeat,
} from "./heartbeat.js";
export {
  DEFAULT_CONTROL_TIMEOUT_MS,
  baseHeaders,
  errorSnippet,
  isAbort,
  joinUrl,
  scopedSignal,
  transportError,
  upstreamErrorFrom,
} from "./http.js";
export type { FetchLike, ScopedSignal } from "./http.js";
export {
  ED25519_SIGNATURE_BYTES,
  algorandAddressFromPublicKey,
  loadOperatorKey,
  verifySignatureB64,
} from "./keys.js";
export type { OperatorKey } from "./keys.js";
export { createLogger } from "./logger.js";
export type { Logger } from "./logger.js";
export {
  DEFAULT_INFERENCE_TIMEOUT_MS,
  OLLAMA_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_BASE_URL,
  OllamaProvider,
  OpenAiCompatibleProvider,
  VLLM_DEFAULT_BASE_URL,
  VllmProvider,
  createProvider,
} from "./providers/index.js";
export type {
  CreateProviderOverrides,
  InferenceProvider,
  ProviderOptions,
} from "./providers/index.js";
export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_PRICE_PER_1K_TOKENS_USDC,
  REGISTER_PATH,
  backoffMs,
  buildCapabilities,
  buildRegistration,
  isRetryableStatus,
  registerNode,
  signRegistration,
} from "./registration.js";
export type {
  BuildRegistrationOptions,
  CapabilityOverrides,
  RegisterNodeOptions,
  RegisterNodeResult,
} from "./registration.js";
export { Semaphore } from "./semaphore.js";
export type { Release } from "./semaphore.js";
export { DEFAULT_NODE_PORT, NodeServer, readJsonBody } from "./server.js";
export type { NodeServerOptions, ServerLoad } from "./server.js";
export { SSE_DONE, SseParser, iterateSseJson } from "./sse.js";
export type { ByteStream, SseEvent } from "./sse.js";
export { DAEMON_USER_AGENT, DAEMON_VERSION } from "./version.js";

export { addressCommand } from "./commands/address.js";
export type { AddressCommandOptions } from "./commands/address.js";
export { doctorCommand } from "./commands/doctor.js";
export type { DoctorCommandOptions } from "./commands/doctor.js";
export { registerCommand } from "./commands/register.js";
export type { RegisterCommandOptions, RegisterCommandResult } from "./commands/register.js";
export { portFromEndpoint, startCommand } from "./commands/start.js";
export type { RunningDaemon, StartCommandOptions } from "./commands/start.js";
