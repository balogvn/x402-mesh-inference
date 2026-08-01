import { generateKeyPairSync } from "node:crypto";
import { loadDaemonConfig } from "@x402-mesh/shared";
import type { DaemonConfig } from "@x402-mesh/shared";
import type { FetchLike } from "../src/http.js";

/**
 * Shared fixtures.
 *
 * Nothing here opens a socket: every `fetch` is a stub and every key is generated locally.
 */

/** Generates a fresh, valid base64 Algorand secret key (32-byte seed ‖ 32-byte public key). */
export function generateSecretKeyB64(): string {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.concat([
    pkcs8.subarray(pkcs8.length - 32),
    spki.subarray(spki.length - 32),
  ]).toString("base64");
}

/** A minimal valid daemon environment; override any variable via `overrides`. */
export function daemonEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    MESH_GATEWAY_URL: "https://gateway.test",
    MESH_NODE_ID: "node-test-1",
    MESH_NODE_ENDPOINT: "http://127.0.0.1:8403",
    MESH_MODELS: "llama3.1:8b",
    MESH_NETWORK: "testnet",
    MESH_HEARTBEAT_INTERVAL_MS: "1000",
    MESH_MAX_CONCURRENCY: "2",
    AVM_PRIVATE_KEY: generateSecretKeyB64(),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

/** Builds a fully resolved {@link DaemonConfig} from {@link daemonEnv}. */
export function daemonConfig(overrides: Record<string, string | undefined> = {}): DaemonConfig {
  return loadDaemonConfig(daemonEnv(overrides));
}

/** One recorded outbound request. */
export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stub `fetch` plus the calls it recorded. */
export interface FetchStub {
  fetch: FetchLike;
  calls: RecordedCall[];
}

/** Response description a {@link FetchStub} handler can return. */
export interface StubResponse {
  status?: number;
  body?: unknown;
  /** Raw text body, used when `body` is not JSON-serializable. */
  text?: string;
  headers?: Record<string, string>;
}

/**
 * Builds a `fetch` stub driven by a handler.
 *
 * The handler may return a {@link StubResponse}, a ready-made `Response`, or throw to
 * simulate a transport failure.
 */
export function stubFetch(
  handler: (
    call: RecordedCall,
    index: number,
  ) => StubResponse | Response | Promise<StubResponse | Response>,
): FetchStub {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const rawBody = init?.body;
    let body: unknown = undefined;
    if (typeof rawBody === "string") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
    };
    calls.push(call);

    if (init?.signal?.aborted) throw abortError();

    const result = await handler(call, calls.length - 1);
    if (result instanceof Response) return result;
    return makeResponse(result);
  };
  return { fetch: fetchImpl, calls };
}

/** Builds a `Response` from a {@link StubResponse}. */
export function makeResponse(spec: StubResponse): Response {
  const status = spec.status ?? 200;
  const headers = new Headers(spec.headers ?? {});
  if (spec.text !== undefined) {
    return new Response(spec.text, { status, headers });
  }
  if (spec.body === undefined) {
    return new Response(null, { status, headers });
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(spec.body), { status, headers });
}

/** Builds an SSE `Response` whose body is delivered as the given raw chunks. */
export function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

/** An `AbortError` shaped exactly like the one `fetch` raises on abort. */
export function abortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/** A never-aborted signal, for calls that require one. */
export function liveSignal(): AbortSignal {
  return new AbortController().signal;
}
