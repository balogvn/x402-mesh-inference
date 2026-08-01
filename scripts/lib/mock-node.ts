/**
 * A real, small OpenAI-compatible inference node used by the end-to-end harnesses.
 *
 * It is a genuine HTTP server rather than a function stub so that the gateway under test
 * exercises its actual proxy, timeout and SSE-relay paths. The "model" is deterministic text,
 * which keeps assertions exact and means CI needs no GPU, no Ollama and no network egress.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  canonicalRegistrationBytes,
  registrationNonce,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type NodeCapability,
  type NodeRegistration,
  type SignedNodeRegistration,
} from "@x402-mesh/shared";
import type { Network } from "@x402/core/types";
import { signBytes, type AlgorandKeypair } from "./ed25519.js";

/** Counters the harness asserts against to prove the request really reached the node. */
export interface MockNodeStats {
  /** Buffered (non-streaming) completions served. */
  completions: number;
  /** Streaming completions served. */
  streams: number;
  /** Models this node was asked for, in order. */
  modelsRequested: string[];
}

/** A running mock node. */
export interface MockNode {
  /** Absolute base URL, e.g. `http://127.0.0.1:53124`. */
  url: string;
  stats: MockNodeStats;
  close(): Promise<void>;
}

/** Options for {@link startMockNode}. */
export interface MockNodeOptions {
  /** Models to claim support for. Requests for anything else get a 404. */
  models: string[];
  /** Milliseconds between SSE frames. Kept tiny so CI is fast but the relay is still real. */
  streamDelayMs?: number;
}

/** The canned completion, split into the tokens the streaming path emits one at a time. */
const CANNED_TOKENS = [
  "x402",
  " turns",
  " HTTP",
  " 402",
  " into",
  " a",
  " working",
  " payment",
  " handshake",
  ".",
];

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString(10),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Rough, deterministic token accounting. Exactness does not matter; determinism does. */
function countTokens(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function completionId(): string {
  return `chatcmpl-mock-${Date.now().toString(36)}`;
}

/**
 * Starts the mock node on an ephemeral loopback port.
 *
 * @returns The running server; always `await close()` it, or the harness will not exit.
 */
export async function startMockNode(options: MockNodeOptions): Promise<MockNode> {
  const stats: MockNodeStats = { completions: 0, streams: 0, modelsRequested: [] };
  const streamDelayMs = options.streamDelayMs ?? 2;

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: { message: e instanceof Error ? e.message : "error" } });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://node.invalid");

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
      jsonResponse(res, 200, { status: "ok", models: options.models });
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      jsonResponse(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
      return;
    }

    const body = (await readJsonBody(req)) as ChatCompletionRequest | undefined;
    if (body === undefined || typeof body.model !== "string" || !Array.isArray(body.messages)) {
      jsonResponse(res, 400, { error: { message: "model and messages are required" } });
      return;
    }
    stats.modelsRequested.push(body.model);
    if (!options.models.includes(body.model)) {
      jsonResponse(res, 404, { error: { message: `model ${body.model} is not loaded` } });
      return;
    }

    const promptTokens = body.messages.reduce((n, m) => n + countTokens(String(m.content)), 0);
    const id = completionId();
    const created = Math.floor(Date.now() / 1000);

    if (body.stream === true) {
      stats.streams += 1;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      const write = (chunk: ChatCompletionChunk): void => {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };
      write({
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
      for (const token of CANNED_TOKENS) {
        await new Promise((resolve) => setTimeout(resolve, streamDelayMs));
        write({
          id,
          object: "chat.completion.chunk",
          created,
          model: body.model,
          choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
        });
      }
      write({
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.end("data: [DONE]\n\n");
      return;
    }

    stats.completions += 1;
    const content = CANNED_TOKENS.join("");
    const completion: ChatCompletionResponse = {
      id,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: CANNED_TOKENS.length,
        total_tokens: promptTokens + CANNED_TOKENS.length,
      },
    };
    jsonResponse(res, 200, completion);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    stats,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

/** Inputs for {@link buildSignedRegistration}. */
export interface RegistrationInput {
  nodeId: string;
  keypair: AlgorandKeypair;
  endpoint: string;
  network: Network;
  capabilities: NodeCapability[];
  version?: string;
}

/**
 * Builds a registration and signs it exactly the way the node daemon does.
 *
 * The signing payload comes from `canonicalRegistrationBytes` in `@x402-mesh/shared`, so if
 * the daemon and the gateway ever disagree about the canonical form, this harness fails too —
 * which is the point.
 */
export function buildSignedRegistration(input: RegistrationInput): SignedNodeRegistration {
  const registration: NodeRegistration = {
    nodeId: input.nodeId,
    operatorAddress: input.keypair.address,
    endpoint: input.endpoint,
    capabilities: input.capabilities,
    network: input.network,
    version: input.version ?? "0.1.0",
    timestamp: Date.now(),
    nonce: registrationNonce(),
  };
  const signature = signBytes(input.keypair.secretKeyB64, canonicalRegistrationBytes(registration));
  return {
    registration,
    signature: signature.toString("base64"),
    publicKey: input.keypair.publicKey.toString("base64"),
  };
}
