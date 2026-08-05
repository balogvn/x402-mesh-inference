import { z } from "zod";
import type { Network } from "@x402/core/types";
import { ValidationError } from "./errors.js";
import { usdcToAtomic } from "./money.js";
import { normalizeNetwork } from "./networks.js";
import type {
  ChatCompletionChoice,
  ChatCompletionChunk,
  ChatCompletionChunkChoice,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionUsage,
  ChatMessage,
  NodeCapability,
  NodeHealth,
  NodeRecord,
  NodeRegistration,
  NodeSelection,
  SettlementRecord,
  SignedNodeRegistration,
} from "./types.js";

/**
 * Runtime validation for every type that crosses a trust boundary.
 *
 * Strictness policy:
 * - Registration, health, record and settlement schemas are `.strict()`. They are either
 *   signature-covered or operator-supplied, so an unexpected key means tampering or a
 *   version skew we must not silently accept.
 * - The OpenAI-compatible request/response schemas use zod's default *strip* behaviour.
 *   Real OpenAI clients send fields we do not implement (`n`, `presence_penalty`, `user`,
 *   …); rejecting them outright would break drop-in compatibility, and stripping is just as
 *   safe because only validated fields are ever forwarded to a node.
 */

/** Algorand addresses are 58 characters of RFC 4648 base32 (A-Z, 2-7). */
const ALGORAND_ADDRESS_RE = /^[A-Z2-7]{58}$/;

/** Canonical base64 with standard alphabet and correct padding. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * True when `value` is canonical base64 decoding to exactly `byteLength` bytes.
 *
 * The re-encode comparison rejects non-canonical padding, which `Buffer.from` would
 * otherwise accept silently.
 */
function isBase64OfLength(value: string, byteLength: number): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_RE.test(value)) return false;
  const buf = Buffer.from(value, "base64");
  return buf.length === byteLength && buf.toString("base64") === value;
}

/**
 * Accepts either CAIP-2 encoding of a supported Algorand network and normalizes it to
 * canonical (truncated genesis hash) form on output.
 */
export const NetworkSchema = z
  .string()
  .min(1, "network is required")
  .superRefine((value, ctx) => {
    try {
      normalizeNetwork(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unsupported network (expected an Algorand CAIP-2 identifier)",
      });
    }
  })
  .transform((value): Network => normalizeNetwork(value));

/** A decimal USDC string with at most 6 decimal places and no floating-point notation. */
export const UsdcAmountSchema = z.string().superRefine((value, ctx) => {
  try {
    usdcToAtomic(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a non-negative decimal USDC amount with at most 6 decimal places",
    });
  }
});

/** A decimal integer string of atomic USDC units, as carried on the wire. */
export const AtomicAmountSchema = z
  .string()
  .regex(/^\d+$/, "must be a non-negative decimal integer of atomic units");

/** Algorand payout address. Checksum validity is verified on-chain at opt-in check time. */
export const AlgorandAddressSchema = z
  .string()
  .regex(ALGORAND_ADDRESS_RE, "must be a 58-character Algorand address");

/** Absolute http(s) endpoint a node can be reached at. */
export const EndpointUrlSchema = z
  .string()
  .url("must be an absolute URL")
  .max(512, "endpoint is too long")
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    "endpoint must use http or https",
  );

/**
 * Characters a model id may contain.
 *
 * Deliberately narrow, and a security boundary rather than a tidiness rule. A model id is
 * **attacker-controlled**: node registration is open, so anyone may register a node
 * advertising any capability string. That string is then interpolated into places where a
 * quote or a backslash changes the meaning of the surrounding text — most sharply into the
 * JavaScript source of `GET /quickstart/pay.mjs`, which developers are told to download and
 * run *with `AVM_PRIVATE_KEY` in their environment*. An unrestricted id there is remote code
 * execution against an integrator's wallet.
 *
 * The set covers every real model id shape in use — `llama-3.3-70b-versatile`, `gpt-4o`,
 * `llama3.1:8b`, `meta-llama/Llama-3-8b`, `mistral-7b-instruct-v0.2` — and contains no
 * quote, backslash, backtick, `$`, whitespace or control character, so it cannot break out
 * of a JS string literal, a single-quoted shell argument, an HTML attribute or a JSON string.
 *
 * Escaping at each sink is still applied; this is the root fix, not a substitute for it.
 */
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]+$/;

/** Shared model-id validator. See {@link MODEL_ID_RE} for why the charset is restricted. */
export const ModelIdSchema = z
  .string()
  .min(1, "model is required")
  .max(200, "model name is too long")
  .regex(MODEL_ID_RE, "model may contain only letters, digits and . _ : / -");

/**
 * Runtime guard for values that did not arrive through a zod schema.
 *
 * Used at interpolation sinks so a record persisted before this constraint existed cannot
 * poison a page rendered today.
 */
export function isSafeModelId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 200 && MODEL_ID_RE.test(value)
  );
}

export const NodeCapabilitySchema = z
  .object({
    model: ModelIdSchema,
    contextWindow: z
      .number()
      .int("contextWindow must be an integer")
      .positive("contextWindow must be positive")
      .max(10_000_000, "contextWindow is implausibly large"),
    pricePer1kTokensUsdc: UsdcAmountSchema,
    quantization: z.string().min(1).max(64).optional(),
  })
  .strict();

/** Operator-chosen node id: an identifier, not free text. Shared by registration and heartbeat. */
export const NodeIdSchema = z
  .string()
  .min(1, "nodeId is required")
  .max(128, "nodeId is too long")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "nodeId contains illegal characters");

/** Single-use random hex. Shared so registration and heartbeat cannot drift apart. */
export const NonceSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{16,128}$/, "nonce must be 16-128 hex characters");

export const NodeRegistrationSchema = z
  .object({
    nodeId: NodeIdSchema,
    operatorAddress: AlgorandAddressSchema,
    endpoint: EndpointUrlSchema,
    capabilities: z
      .array(NodeCapabilitySchema)
      .min(1, "a node must advertise at least one capability")
      .max(64, "too many capabilities"),
    network: NetworkSchema,
    version: z
      .string()
      .min(1, "version is required")
      .max(32, "version is too long")
      .regex(/^[0-9A-Za-z.+-]+$/, "version contains illegal characters"),
    timestamp: z
      .number()
      .int("timestamp must be integer milliseconds")
      .positive("timestamp must be positive")
      .max(Number.MAX_SAFE_INTEGER),
    nonce: NonceSchema,
  })
  .strict();

export const SignedNodeRegistrationSchema = z
  .object({
    registration: NodeRegistrationSchema,
    signature: z
      .string()
      .refine((v) => isBase64OfLength(v, 64), "signature must be 64 base64-encoded bytes"),
    publicKey: z
      .string()
      .refine((v) => isBase64OfLength(v, 32), "publicKey must be 32 base64-encoded bytes"),
  })
  .strict();

/**
 * The seven signed heartbeat fields.
 *
 * `.strict()` matters here: the signature covers exactly this projection, so an unknown
 * property is either a client bug or an attempt to smuggle unsigned data past verification.
 * Rejecting is safer than ignoring.
 */
export const NodeHeartbeatSchema = z
  .object({
    nodeId: NodeIdSchema,
    healthy: z.boolean(),
    inFlight: z.number().int().nonnegative().max(1_000_000),
    maxConcurrency: z.number().int().positive().max(4096),
    version: z.string().min(1).max(64),
    timestamp: z.number().int().positive(),
    nonce: NonceSchema,
  })
  .strict();

export const SignedNodeHeartbeatSchema = z
  .object({
    heartbeat: NodeHeartbeatSchema,
    signature: z
      .string()
      .refine((v) => isBase64OfLength(v, 64), "signature must be 64 base64-encoded bytes"),
    publicKey: z
      .string()
      .refine((v) => isBase64OfLength(v, 32), "publicKey must be 32 base64-encoded bytes"),
  })
  .strict();

export const NodeHealthSchema = z
  .object({
    nodeId: z.string().min(1).max(128),
    healthy: z.boolean(),
    latencyMsP50: z.number().finite().nonnegative(),
    latencyMsP95: z.number().finite().nonnegative(),
    inFlight: z.number().int().nonnegative(),
    maxConcurrency: z.number().int().positive().max(4096),
    uptimeRatio: z.number().min(0).max(1),
    qualityScore: z.number().min(0).max(1),
    consecutiveFailures: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative(),
  })
  .strict();

export const NodeRecordSchema = z
  .object({
    registration: NodeRegistrationSchema,
    health: NodeHealthSchema,
    usdcOptedIn: z.boolean(),
    totalRequests: z.number().int().nonnegative(),
    totalPaidAtomic: AtomicAmountSchema,
    registeredAt: z.number().int().nonnegative(),
  })
  .strict();

export const NodeSelectionSchema = z
  .object({
    node: NodeRecordSchema,
    score: z.number().finite(),
    reason: z.string().max(512),
  })
  .strict();

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export const ChatCompletionRequestSchema = z.object({
  model: ModelIdSchema,
  messages: z.array(ChatMessageSchema).min(1, "messages must not be empty").max(512),
  stream: z.boolean().optional(),
  max_tokens: z
    .number()
    .int("max_tokens must be an integer")
    .positive("max_tokens must be positive")
    .max(1_000_000)
    .optional(),
  temperature: z
    .number()
    .min(0, "temperature must be >= 0")
    .max(2, "temperature must be <= 2")
    .optional(),
  top_p: z.number().min(0, "top_p must be >= 0").max(1, "top_p must be <= 1").optional(),
  stop: z.array(z.string()).max(4, "at most 4 stop sequences").optional(),
});

export const ChatCompletionUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

export const ChatCompletionChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  message: ChatMessageSchema,
  finish_reason: z.string().nullable(),
});

export const ChatCompletionResponseSchema = z.object({
  id: z.string().min(1),
  object: z.literal("chat.completion"),
  created: z.number().int().nonnegative(),
  model: z.string().min(1),
  choices: z.array(ChatCompletionChoiceSchema),
  usage: ChatCompletionUsageSchema,
});

export const ChatCompletionChunkChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  delta: ChatMessageSchema.partial(),
  finish_reason: z.string().nullable(),
});

export const ChatCompletionChunkSchema = z.object({
  id: z.string().min(1),
  object: z.literal("chat.completion.chunk"),
  created: z.number().int().nonnegative(),
  model: z.string().min(1),
  choices: z.array(ChatCompletionChunkChoiceSchema),
});

export const SettlementRecordSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    nodeId: z.string().min(1).max(128),
    payerAddress: AlgorandAddressSchema,
    operatorAddress: AlgorandAddressSchema,
    inboundAtomic: AtomicAmountSchema,
    payoutAtomic: AtomicAmountSchema,
    marginAtomic: AtomicAmountSchema,
    inboundTxId: z.string().min(1).max(128),
    payoutTxId: z.string().min(1).max(128).nullable(),
    batchId: z.string().min(1).max(128).nullable().optional(),
    status: z.enum(["pending", "accrued", "settled", "failed"]),
    error: z.string().max(1024).optional(),
    createdAt: z.number().int().nonnegative(),
    settledAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

/**
 * Parses `data` with `schema`, converting a zod failure into a {@link ValidationError} that
 * carries the flattened issues.
 *
 * The `Input` type parameter is widened to `unknown` so that schemas containing transforms
 * (such as {@link NetworkSchema}) are accepted; `T` is still inferred from the schema's
 * output, so call sites are unchanged.
 *
 * @param what - Short noun naming what is being validated, used in the error message.
 */
export function parseOrThrow<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  data: unknown,
  what: string,
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const flat = result.error.flatten();
  throw new ValidationError(`invalid ${what}`, {
    what,
    fieldErrors: flat.fieldErrors,
    formErrors: flat.formErrors,
  });
}

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

/**
 * Compile-time proof that every schema's inferred output matches its hand-written interface
 * in `types.ts`. Purely a type — it has no runtime representation. If a schema and its
 * interface drift apart, this alias fails to compile.
 */
export type SchemaContractProof = [
  Expect<MutuallyAssignable<z.infer<typeof NodeCapabilitySchema>, NodeCapability>>,
  Expect<MutuallyAssignable<z.infer<typeof NodeRegistrationSchema>, NodeRegistration>>,
  Expect<MutuallyAssignable<z.infer<typeof SignedNodeRegistrationSchema>, SignedNodeRegistration>>,
  Expect<MutuallyAssignable<z.infer<typeof NodeHealthSchema>, NodeHealth>>,
  Expect<MutuallyAssignable<z.infer<typeof NodeRecordSchema>, NodeRecord>>,
  Expect<MutuallyAssignable<z.infer<typeof NodeSelectionSchema>, NodeSelection>>,
  Expect<MutuallyAssignable<z.infer<typeof ChatMessageSchema>, ChatMessage>>,
  Expect<MutuallyAssignable<z.infer<typeof ChatCompletionRequestSchema>, ChatCompletionRequest>>,
  Expect<MutuallyAssignable<z.infer<typeof ChatCompletionUsageSchema>, ChatCompletionUsage>>,
  Expect<MutuallyAssignable<z.infer<typeof ChatCompletionChoiceSchema>, ChatCompletionChoice>>,
  Expect<MutuallyAssignable<z.infer<typeof ChatCompletionResponseSchema>, ChatCompletionResponse>>,
  Expect<
    MutuallyAssignable<z.infer<typeof ChatCompletionChunkChoiceSchema>, ChatCompletionChunkChoice>
  >,
  Expect<MutuallyAssignable<z.infer<typeof ChatCompletionChunkSchema>, ChatCompletionChunk>>,
  Expect<MutuallyAssignable<z.infer<typeof SettlementRecordSchema>, SettlementRecord>>,
];
