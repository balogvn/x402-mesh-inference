import { describe, expect, it } from "vitest";
import {
  ALGORAND_TESTNET,
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  NodeCapabilitySchema,
  NodeRegistrationSchema,
  SettlementRecordSchema,
  SignedNodeRegistrationSchema,
  ValidationError,
  parseOrThrow,
} from "../src/index.js";

const ADDRESS = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
const TESTNET_FULL = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const SIGNATURE = Buffer.alloc(64, 7).toString("base64");
const PUBLIC_KEY = Buffer.alloc(32, 3).toString("base64");

function validRegistration() {
  return {
    nodeId: "node-alpha",
    operatorAddress: ADDRESS,
    endpoint: "https://node.example.com",
    capabilities: [{ model: "llama3.1:8b", contextWindow: 8192, pricePer1kTokensUsdc: "0.000500" }],
    network: ALGORAND_TESTNET,
    version: "0.1.0",
    timestamp: 1_760_000_000_000,
    nonce: "0123456789abcdef0123456789abcdef",
  };
}

describe("ChatCompletionRequestSchema", () => {
  const valid = { model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] };

  it("accepts a minimal valid request", () => {
    expect(ChatCompletionRequestSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an empty messages array", () => {
    expect(ChatCompletionRequestSchema.safeParse({ ...valid, messages: [] }).success).toBe(false);
  });

  it("rejects a missing model and an over-long model", () => {
    expect(ChatCompletionRequestSchema.safeParse({ messages: valid.messages }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...valid, model: "" }).success).toBe(false);
    expect(
      ChatCompletionRequestSchema.safeParse({ ...valid, model: "m".repeat(201) }).success,
    ).toBe(false);
    expect(
      ChatCompletionRequestSchema.safeParse({ ...valid, model: "m".repeat(200) }).success,
    ).toBe(true);
  });

  it("rejects non-positive or fractional max_tokens", () => {
    for (const max_tokens of [0, -1, 1.5]) {
      expect(ChatCompletionRequestSchema.safeParse({ ...valid, max_tokens }).success).toBe(false);
    }
    expect(ChatCompletionRequestSchema.safeParse({ ...valid, max_tokens: 1 }).success).toBe(true);
  });

  it("rejects temperature outside [0, 2]", () => {
    for (const temperature of [-0.1, 2.1, Number.NaN]) {
      expect(ChatCompletionRequestSchema.safeParse({ ...valid, temperature }).success).toBe(false);
    }
    for (const temperature of [0, 1, 2]) {
      expect(ChatCompletionRequestSchema.safeParse({ ...valid, temperature }).success).toBe(true);
    }
  });

  it("rejects top_p outside [0, 1]", () => {
    expect(ChatCompletionRequestSchema.safeParse({ ...valid, top_p: 1.5 }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...valid, top_p: 0.9 }).success).toBe(true);
  });

  it("rejects an unknown message role and non-string content", () => {
    expect(
      ChatCompletionRequestSchema.safeParse({
        ...valid,
        messages: [{ role: "tool", content: "x" }],
      }).success,
    ).toBe(false);
    expect(
      ChatCompletionRequestSchema.safeParse({
        ...valid,
        messages: [{ role: "user", content: [{ type: "text" }] }],
      }).success,
    ).toBe(false);
  });

  it("strips unknown keys rather than forwarding them to a node", () => {
    const parsed = ChatCompletionRequestSchema.parse({
      ...valid,
      presence_penalty: 0.5,
      user: "someone",
    });
    expect(parsed).toEqual(valid);
    expect("presence_penalty" in parsed).toBe(false);
  });
});

describe("ChatCompletionResponseSchema", () => {
  it("requires the literal object discriminator", () => {
    const base = {
      id: "cmpl-1",
      object: "chat.completion",
      created: 1,
      model: "llama3.1:8b",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    expect(ChatCompletionResponseSchema.safeParse(base).success).toBe(true);
    expect(
      ChatCompletionResponseSchema.safeParse({ ...base, object: "chat.completion.chunk" }).success,
    ).toBe(false);
  });
});

describe("NodeCapabilitySchema", () => {
  it("rejects a price with more than six decimal places", () => {
    expect(
      NodeCapabilitySchema.safeParse({
        model: "m",
        contextWindow: 1,
        pricePer1kTokensUsdc: "0.0000001",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys at this trust boundary", () => {
    expect(
      NodeCapabilitySchema.safeParse({
        model: "m",
        contextWindow: 1,
        pricePer1kTokensUsdc: "0.5",
        rogue: true,
      }).success,
    ).toBe(false);
  });
});

describe("NodeRegistrationSchema", () => {
  it("accepts a well-formed registration", () => {
    expect(NodeRegistrationSchema.parse(validRegistration())).toMatchObject({
      nodeId: "node-alpha",
      network: ALGORAND_TESTNET,
    });
  });

  it("normalizes the network to canonical form on output", () => {
    const parsed = NodeRegistrationSchema.parse({
      ...validRegistration(),
      network: TESTNET_FULL,
    });
    expect(parsed.network).toBe(ALGORAND_TESTNET);
  });

  it("rejects a non-Algorand network", () => {
    expect(
      NodeRegistrationSchema.safeParse({ ...validRegistration(), network: "eip155:1" }).success,
    ).toBe(false);
  });

  it("rejects a malformed operator address", () => {
    for (const bad of ["", "short", ADDRESS.toLowerCase(), `${ADDRESS}A`]) {
      expect(
        NodeRegistrationSchema.safeParse({ ...validRegistration(), operatorAddress: bad }).success,
        bad,
      ).toBe(false);
    }
  });

  it("rejects a non-http endpoint and an empty capability list", () => {
    expect(
      NodeRegistrationSchema.safeParse({ ...validRegistration(), endpoint: "ftp://x.example" })
        .success,
    ).toBe(false);
    expect(
      NodeRegistrationSchema.safeParse({ ...validRegistration(), capabilities: [] }).success,
    ).toBe(false);
  });

  it("rejects a non-hex or too-short nonce", () => {
    expect(NodeRegistrationSchema.safeParse({ ...validRegistration(), nonce: "zz" }).success).toBe(
      false,
    );
    expect(
      NodeRegistrationSchema.safeParse({ ...validRegistration(), nonce: "abcdef" }).success,
    ).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(NodeRegistrationSchema.safeParse({ ...validRegistration(), extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("SignedNodeRegistrationSchema", () => {
  it("accepts a 64-byte signature and 32-byte public key", () => {
    const parsed = SignedNodeRegistrationSchema.parse({
      registration: validRegistration(),
      signature: SIGNATURE,
      publicKey: PUBLIC_KEY,
    });
    expect(parsed.signature).toBe(SIGNATURE);
  });

  it("rejects wrong-length key material", () => {
    expect(
      SignedNodeRegistrationSchema.safeParse({
        registration: validRegistration(),
        signature: Buffer.alloc(32).toString("base64"),
        publicKey: PUBLIC_KEY,
      }).success,
    ).toBe(false);
    expect(
      SignedNodeRegistrationSchema.safeParse({
        registration: validRegistration(),
        signature: SIGNATURE,
        publicKey: "not base64!!",
      }).success,
    ).toBe(false);
  });
});

describe("SettlementRecordSchema", () => {
  it("requires atomic amounts to be decimal integers, not decimals", () => {
    const base = {
      requestId: "req-1",
      nodeId: "node-alpha",
      payerAddress: ADDRESS,
      operatorAddress: ADDRESS,
      inboundAtomic: "2000",
      payoutAtomic: "1700",
      marginAtomic: "300",
      inboundTxId: "TX1",
      payoutTxId: null,
      status: "pending",
      createdAt: 1,
      settledAt: null,
    };
    expect(SettlementRecordSchema.safeParse(base).success).toBe(true);
    expect(SettlementRecordSchema.safeParse({ ...base, inboundAtomic: "0.002" }).success).toBe(
      false,
    );
    expect(SettlementRecordSchema.safeParse({ ...base, status: "refunded" }).success).toBe(false);
  });
});

describe("parseOrThrow", () => {
  it("returns the parsed value on success", () => {
    const parsed = parseOrThrow(
      ChatCompletionRequestSchema,
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      "chat completion request",
    );
    expect(parsed.model).toBe("m");
  });

  it("converts a zod failure into a ValidationError carrying flattened issues", () => {
    try {
      parseOrThrow(ChatCompletionRequestSchema, { model: "m", messages: [] }, "chat request");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const err = e as ValidationError;
      expect(err.httpStatus).toBe(400);
      expect(err.message).toBe("invalid chat request");
      const body = err.toJSON();
      const details = body.error.details as { fieldErrors: Record<string, string[]> };
      expect(details.fieldErrors["messages"]).toContain("messages must not be empty");
    }
  });

  it("works with a schema that contains a transform", () => {
    const parsed = parseOrThrow(
      NodeRegistrationSchema,
      { ...validRegistration(), network: TESTNET_FULL },
      "node registration",
    );
    expect(parsed.network).toBe(ALGORAND_TESTNET);
  });
});
