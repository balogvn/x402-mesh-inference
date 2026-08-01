import { describe, expect, it } from "vitest";
import { ConfigError, UpstreamError } from "@x402-mesh/shared";
import type { ChatCompletionChunk, ChatCompletionRequest, DaemonConfig } from "@x402-mesh/shared";
import type { FetchLike } from "../src/http.js";
import {
  OLLAMA_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_BASE_URL,
  OllamaProvider,
  VLLM_DEFAULT_BASE_URL,
  VllmProvider,
  createProvider,
} from "../src/providers/index.js";
import { normalizeChunk, normalizeCompletion } from "../src/providers/openai-compatible.js";
import { SSE_DONE } from "../src/sse.js";
import { abortError, daemonConfig, liveSignal, sseResponse, stubFetch } from "./helpers.js";

/**
 * The inference adapter.
 *
 * The SSE path is the riskiest code in the daemon: a framing mistake shows up only under
 * real network fragmentation, and it corrupts the completion a client already paid for.
 */

const REQUEST: ChatCompletionRequest = {
  model: "llama3.1:8b",
  messages: [{ role: "user", content: "hi" }],
};

/** A frame the OpenAI-compatible backends actually emit, with the given delta text. */
function frame(text: string, index = 0): string {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1_760_000_000,
    model: "llama3.1:8b",
    choices: [{ index, delta: { content: text }, finish_reason: null }],
  });
}

/** Collects every chunk a stream yields. */
async function collect(stream: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/** Text of the first choice's delta, which is what a relay actually forwards. */
function texts(chunks: ChatCompletionChunk[]): string[] {
  return chunks.map((c) => c.choices[0]?.delta.content ?? "");
}

/** A provider whose backend replies to every call with the given SSE chunks. */
function streamingProvider(chunks: string[]) {
  const stub = stubFetch(() => sseResponse(chunks));
  return {
    provider: new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch }),
    stub,
  };
}

describe("chatStream framing", () => {
  it("reassembles a frame split mid-JSON across chunk boundaries", async () => {
    // The split lands inside the JSON string value — a per-chunk JSON.parse dies here.
    const whole = `data: ${frame("hello")}\n\ndata: ${SSE_DONE}\n\n`;
    const cut = whole.indexOf("hello") + 2;
    const { provider } = streamingProvider([whole.slice(0, cut), whole.slice(cut)]);

    expect(texts(await collect(provider.chatStream(REQUEST, liveSignal())))).toEqual(["hello"]);
  });

  it("survives byte-at-a-time delivery of a whole stream", async () => {
    const body = `data: ${frame("a")}\n\ndata: ${frame("b")}\n\ndata: ${SSE_DONE}\n\n`;
    const { provider } = streamingProvider([...body]);

    expect(texts(await collect(provider.chatStream(REQUEST, liveSignal())))).toEqual(["a", "b"]);
  });

  it("emits every frame carried by a single chunk", async () => {
    const body = ["a", "b", "c", "d"].map((t) => `data: ${frame(t)}\n\n`).join("");
    const { provider } = streamingProvider([body, `data: ${SSE_DONE}\n\n`]);

    expect(texts(await collect(provider.chatStream(REQUEST, liveSignal())))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("terminates at [DONE] and ignores anything the backend sends after it", async () => {
    const { provider } = streamingProvider([
      `data: ${frame("kept")}\n\n`,
      `data: ${SSE_DONE}\n\n`,
      `data: ${frame("injected")}\n\n`,
    ]);

    // Bytes after the sentinel must not be able to append content to a paid completion.
    expect(texts(await collect(provider.chatStream(REQUEST, liveSignal())))).toEqual(["kept"]);
  });

  it("handles CRLF line endings", async () => {
    const body = `data: ${frame("crlf")}\r\n\r\ndata: ${SSE_DONE}\r\n\r\n`;
    const { provider } = streamingProvider([body]);

    expect(texts(await collect(provider.chatStream(REQUEST, liveSignal())))).toEqual(["crlf"]);
  });

  it("handles a CRLF split across the chunk boundary", async () => {
    const { provider } = streamingProvider([
      `data: ${frame("split")}\r`,
      `\n\r`,
      `\ndata: ${SSE_DONE}\r\n\r\n`,
    ]);

    expect(texts(await collect(provider.chatStream(REQUEST, liveSignal())))).toEqual(["split"]);
  });

  it("ignores keep-alive comments and blank frames", async () => {
    const { provider } = streamingProvider([
      ": ping\n\n",
      "\n\n",
      `data: ${frame("real")}\n\n`,
      ": another keep-alive\n\n",
      `data: ${SSE_DONE}\n\n`,
    ]);

    expect(texts(await collect(provider.chatStream(REQUEST, liveSignal())))).toEqual(["real"]);
  });

  it("recovers a trailing frame the backend never terminated with a blank line", async () => {
    const { provider } = streamingProvider([`data: ${frame("tail")}`]);
    expect(texts(await collect(provider.chatStream(REQUEST, liveSignal())))).toEqual(["tail"]);
  });

  it("reassembles a multi-byte character split across chunks", async () => {
    const body = `data: ${frame("héllo")}\n\ndata: ${SSE_DONE}\n\n`;
    const bytes = new TextEncoder().encode(body);
    const cut = bytes.indexOf(0xc3) + 1;
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const stub = stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.subarray(0, cut));
              controller.enqueue(bytes.subarray(cut));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const provider = new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });

    expect(decoder.decode(bytes.subarray(cut, cut + 1))).not.toBe("");
    expect(texts(await collect(provider.chatStream(REQUEST, liveSignal())))).toEqual(["héllo"]);
  });
});

describe("chatStream failure modes", () => {
  it("delivers the frames that arrived before a malformed one, then raises UpstreamError", async () => {
    const { provider } = streamingProvider([
      `data: ${frame("good")}\n\n`,
      "data: {not json}\n\n",
      `data: ${frame("never seen")}\n\n`,
    ]);

    const seen: ChatCompletionChunk[] = [];
    const failure = await (async () => {
      try {
        for await (const chunk of provider.chatStream(REQUEST, liveSignal())) seen.push(chunk);
        return null;
      } catch (cause) {
        return cause;
      }
    })();

    expect(texts(seen)).toEqual(["good"]);
    expect(failure).toBeInstanceOf(UpstreamError);
    expect((failure as UpstreamError).message).toContain("malformed SSE frame");
  });

  it("maps a non-2xx upstream status to UpstreamError", async () => {
    const stub = stubFetch(() => ({ status: 502, text: "bad gateway from vllm" }));
    const provider = new VllmProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });

    const failure = await collect(provider.chatStream(REQUEST, liveSignal())).catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(UpstreamError);
    expect((failure as UpstreamError).details).toMatchObject({ status: 502, upstream: "vllm" });
    expect((failure as UpstreamError).details?.["body"]).toContain("bad gateway from vllm");
  });

  it("raises UpstreamError when a 200 arrives with no body", async () => {
    const stub = stubFetch(() => new Response(null, { status: 200 }));
    const provider = new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });

    await expect(collect(provider.chatStream(REQUEST, liveSignal()))).rejects.toThrow(
      /streaming response with no body/,
    );
  });

  it("raises UpstreamError on a mid-stream error frame sent with HTTP 200", async () => {
    const { provider } = streamingProvider([
      `data: ${frame("partial")}\n\n`,
      `data: ${JSON.stringify({ error: { message: "CUDA out of memory" } })}\n\n`,
    ]);

    const failure = await collect(provider.chatStream(REQUEST, liveSignal())).catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(UpstreamError);
    expect((failure as UpstreamError).details?.["detail"]).toContain("CUDA out of memory");
  });

  it("wraps a transport failure as UpstreamError", async () => {
    const stub = stubFetch(() => {
      throw new Error("ECONNREFUSED 127.0.0.1:11434");
    });
    const provider = new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });

    const failure = await collect(provider.chatStream(REQUEST, liveSignal())).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(UpstreamError);
    expect((failure as UpstreamError).message).toContain("ECONNREFUSED");
  });
});

describe("chatStream cancellation", () => {
  /** A fetch that only ever settles by being aborted. */
  const hangingFetch: FetchLike = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });

  it("aborts an in-flight request when the caller's signal fires", async () => {
    const provider = new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: hangingFetch });
    const controller = new AbortController();

    const pending = collect(provider.chatStream(REQUEST, controller.signal)).catch(
      (cause: unknown) => cause,
    );
    // Nothing has settled yet; the abort is what ends it.
    controller.abort();

    expect(((await pending) as Error).name).toBe("AbortError");
  });

  it("aborts when the request timeout elapses", async () => {
    const provider = new OllamaProvider({
      baseUrl: "http://gpu.test",
      fetchImpl: hangingFetch,
      requestTimeoutMs: 10,
    });

    const failure = await collect(provider.chatStream(REQUEST, liveSignal())).catch(
      (cause: unknown) => cause,
    );
    expect(((failure ?? {}) as Error).name).toBe("AbortError");
  });

  it("cancels the upstream body when the consumer abandons the stream", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stub = stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${frame("first")}\n\n`));
              controller.enqueue(encoder.encode(`data: ${frame("second")}\n\n`));
              // Never closed: only a cancel can end this stream.
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const provider = new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });

    for await (const chunk of provider.chatStream(REQUEST, liveSignal())) {
      expect(chunk.choices[0]?.delta.content).toBe("first");
      break;
    }

    // Abandoning the iterator must tear the upstream down, not leave the GPU generating
    // tokens nobody will read.
    expect(cancelled).toBe(true);
  });
});

describe("chatStream request shaping", () => {
  it("posts to the OpenAI-compatible chat path with stream forced on", async () => {
    const { provider, stub } = streamingProvider([`data: ${SSE_DONE}\n\n`]);
    await collect(provider.chatStream({ ...REQUEST, stream: false }, liveSignal()));

    expect(stub.calls[0]!.url).toBe("http://gpu.test/v1/chat/completions");
    expect(stub.calls[0]!.method).toBe("POST");
    expect(stub.calls[0]!.headers["accept"]).toBe("text/event-stream");
    expect(stub.calls[0]!.body).toMatchObject({ model: "llama3.1:8b", stream: true });
  });

  it("attaches a bearer token only when one is configured", async () => {
    const withKey = stubFetch(() => sseResponse([`data: ${SSE_DONE}\n\n`]));
    await collect(
      new OllamaProvider({
        baseUrl: "http://gpu.test",
        fetchImpl: withKey.fetch,
        apiKey: "sk-secret",
      }).chatStream(REQUEST, liveSignal()),
    );
    expect(withKey.calls[0]!.headers["authorization"]).toBe("Bearer sk-secret");

    const withoutKey = stubFetch(() => sseResponse([`data: ${SSE_DONE}\n\n`]));
    await collect(
      new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: withoutKey.fetch }).chatStream(
        REQUEST,
        liveSignal(),
      ),
    );
    expect(withoutKey.calls[0]!.headers).not.toHaveProperty("authorization");
  });

  it("keeps the bearer token out of an upstream error", async () => {
    const stub = stubFetch(() => ({ status: 401, text: "unauthorized" }));
    const provider = new OllamaProvider({
      baseUrl: "http://gpu.test",
      fetchImpl: stub.fetch,
      apiKey: "sk-do-not-leak",
    });

    const failure = await collect(provider.chatStream(REQUEST, liveSignal())).catch(
      (cause: unknown) => cause,
    );
    expect(JSON.stringify(failure)).not.toContain("sk-do-not-leak");
  });

  it("strips trailing slashes from the configured base URL", () => {
    expect(new OllamaProvider({ baseUrl: "http://gpu.test///" }).baseUrl).toBe("http://gpu.test");
  });
});

describe("chat (non-streaming)", () => {
  it("normalizes a well-formed completion and forces stream off", async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: {
        id: "chatcmpl-9",
        object: "chat.completion",
        created: 1_760_000_000,
        model: "llama3.1:8b",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      },
    }));
    const provider = new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });

    const completion = await provider.chat({ ...REQUEST, stream: true }, liveSignal());

    expect(completion.choices[0]?.message.content).toBe("hi");
    expect(completion.usage.total_tokens).toBe(10);
    expect(stub.calls[0]!.body).toMatchObject({ stream: false });
  });

  it("maps a non-2xx status to UpstreamError", async () => {
    const stub = stubFetch(() => ({ status: 500, text: "model not loaded" }));
    const provider = new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });

    const failure = await provider.chat(REQUEST, liveSignal()).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(UpstreamError);
    expect((failure as UpstreamError).details).toMatchObject({ status: 500, upstream: "ollama" });
  });

  it("maps a non-JSON body to UpstreamError", async () => {
    const stub = stubFetch(() => ({ status: 200, text: "<html>oops</html>" }));
    const provider = new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });

    await expect(provider.chat(REQUEST, liveSignal())).rejects.toThrow(/non-JSON completion/);
  });
});

describe("normalizeCompletion", () => {
  const minimal = {
    choices: [{ message: { role: "assistant", content: "ok" } }],
  };

  it("fills in the fields real backends omit", () => {
    const before = Math.floor(Date.now() / 1000);
    const completion = normalizeCompletion(minimal, "llama3.1:8b", "ollama");

    expect(completion.id).toMatch(/^chatcmpl-/);
    expect(completion.object).toBe("chat.completion");
    expect(completion.model).toBe("llama3.1:8b");
    expect(completion.created).toBeGreaterThanOrEqual(before);
    expect(completion.choices[0]?.finish_reason).toBeNull();
  });

  it("flattens a null content to an empty string", () => {
    const completion = normalizeCompletion(
      { choices: [{ message: { role: "assistant", content: null } }] },
      "m",
      "ollama",
    );
    expect(completion.choices[0]?.message.content).toBe("");
  });

  it("numbers choices that arrive without an index", () => {
    const completion = normalizeCompletion(
      {
        choices: [
          { message: { role: "assistant", content: "a" } },
          { message: { role: "assistant", content: "b" } },
        ],
      },
      "m",
      "ollama",
    );
    expect(completion.choices.map((c) => c.index)).toEqual([0, 1]);
  });

  it("coerces an unexpected role to assistant", () => {
    const completion = normalizeCompletion(
      { choices: [{ message: { role: "tool", content: "x" } }] },
      "m",
      "ollama",
    );
    expect(completion.choices[0]?.message.role).toBe("assistant");
  });

  it("derives the token total from its parts", () => {
    const completion = normalizeCompletion(
      { ...minimal, usage: { prompt_tokens: 11, completion_tokens: 4 } },
      "m",
      "ollama",
    );
    expect(completion.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 4,
      total_tokens: 15,
    });
  });

  it("back-fills the parts when only a total is reported", () => {
    const completion = normalizeCompletion(
      { ...minimal, usage: { total_tokens: 20, prompt_tokens: 12 } },
      "m",
      "ollama",
    );
    expect(completion.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    });
  });

  it("reports zeros rather than guessing when usage is absent", () => {
    expect(normalizeCompletion(minimal, "m", "ollama").usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("ignores implausible usage values instead of trusting them", () => {
    const completion = normalizeCompletion(
      { ...minimal, usage: { prompt_tokens: -5, completion_tokens: 1.5, total_tokens: "12" } },
      "m",
      "ollama",
    );
    expect(completion.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("treats a missing or non-array choices field as no choices", () => {
    expect(normalizeCompletion({}, "m", "ollama").choices).toEqual([]);
    expect(normalizeCompletion({ choices: "nope" }, "m", "ollama").choices).toEqual([]);
  });

  it("rejects a body that is not an object", () => {
    expect(() => normalizeCompletion(null, "m", "ollama")).toThrow(UpstreamError);
    expect(() => normalizeCompletion("text", "m", "ollama")).toThrow(UpstreamError);
    expect(() => normalizeCompletion(42, "m", "ollama")).toThrow(UpstreamError);
  });

  it("rejects a completion that is still unusable after normalization", () => {
    // No model reported and none requested: nothing can name what produced this.
    expect(() => normalizeCompletion(minimal, "", "ollama")).toThrow(/unusable completion/);
  });
});

describe("normalizeChunk", () => {
  it("keeps only the delta fields the contract defines", () => {
    const chunk = normalizeChunk(
      { choices: [{ index: 0, delta: { role: "assistant", content: "hi", extra: 1 } }] },
      "m",
      "ollama",
    );
    expect(chunk.choices[0]?.delta).toEqual({ role: "assistant", content: "hi" });
    expect(chunk.object).toBe("chat.completion.chunk");
  });

  it("emits an empty delta for a frame that only carries a finish reason", () => {
    const chunk = normalizeChunk(
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "m",
      "ollama",
    );
    expect(chunk.choices[0]?.delta).toEqual({});
    expect(chunk.choices[0]?.finish_reason).toBe("stop");
  });

  it("rejects a frame that is not an object", () => {
    expect(() => normalizeChunk(null, "m", "ollama")).toThrow(UpstreamError);
    expect(() => normalizeChunk("text", "m", "ollama")).toThrow(/not an object/);
    expect(() => normalizeChunk(7, "m", "ollama")).toThrow(/not an object/);
  });

  it("degrades a structurally odd frame to an empty chunk rather than failing the stream", () => {
    // A JSON array is `typeof "object"`, so it survives the guard and normalizes to a chunk
    // with no choices — a relay forwards nothing, which is the harmless outcome.
    expect(normalizeChunk([1, 2], "m", "ollama").choices).toEqual([]);
    expect(normalizeChunk({ choices: "nope" }, "m", "ollama").choices).toEqual([]);
  });

  it("raises on an embedded error object, whatever its shape", () => {
    expect(() => normalizeChunk({ error: "overloaded" }, "m", "ollama")).toThrow(
      /error mid-stream/,
    );
    expect(() => normalizeChunk({ error: { code: 500 } }, "m", "ollama")).toThrow(
      /error mid-stream/,
    );
    // `null` is not an error report; it is a backend that always includes the key.
    expect(() => normalizeChunk({ error: null, choices: [] }, "m", "ollama")).not.toThrow();
  });
});

describe("listModels", () => {
  it("reads Ollama's native /api/tags", async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: {
        models: [
          { name: "llama3.1:8b" },
          { model: "mistral:7b" },
          { name: "" },
          "not-an-object",
          null,
        ],
      },
    }));
    const provider = new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });

    expect(await provider.listModels()).toEqual(["llama3.1:8b", "mistral:7b"]);
    expect(stub.calls[0]!.url).toBe("http://gpu.test/api/tags");
    expect(provider.tagsUrl).toBe("http://gpu.test/api/tags");
  });

  it("reads the OpenAI-compatible /v1/models for vLLM", async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: { data: [{ id: "Qwen/Qwen2.5-7B" }, { id: "" }, {}] },
    }));
    const provider = new VllmProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });

    expect(await provider.listModels()).toEqual(["Qwen/Qwen2.5-7B"]);
    expect(stub.calls[0]!.url).toBe("http://gpu.test/v1/models");
  });

  it("raises UpstreamError when the listing has the wrong shape", async () => {
    const ollama = stubFetch(() => ({ status: 200, body: { models: "nope" } }));
    await expect(
      new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: ollama.fetch }).listModels(),
    ).rejects.toThrow(/models array/);

    const vllm = stubFetch(() => ({ status: 200, body: {} }));
    await expect(
      new VllmProvider({ baseUrl: "http://gpu.test", fetchImpl: vllm.fetch }).listModels(),
    ).rejects.toThrow(/data array/);
  });

  it("raises UpstreamError on a non-2xx or non-JSON listing", async () => {
    const notFound = stubFetch(() => ({ status: 404, text: "no such route" }));
    await expect(
      new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: notFound.fetch }).listModels(),
    ).rejects.toThrow(UpstreamError);

    const html = stubFetch(() => ({ status: 200, text: "<html/>" }));
    await expect(
      new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: html.fetch }).listModels(),
    ).rejects.toThrow(/non-JSON model listing/);
  });
});

describe("health", () => {
  it("is true when the backend answers a model listing", async () => {
    const stub = stubFetch(() => ({ status: 200, body: { models: [] } }));
    const provider = new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });
    expect(await provider.health()).toBe(true);
  });

  it("is false — never a throw — when the backend is down", async () => {
    const stub = stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const provider = new OllamaProvider({ baseUrl: "http://gpu.test", fetchImpl: stub.fetch });
    // The heartbeat calls this on every beat; a throw here would kill the loop.
    expect(await provider.health()).toBe(false);
  });
});

describe("createProvider", () => {
  const base = daemonConfig();

  it("builds the adapter named by the configuration", () => {
    expect(createProvider({ ...base, provider: "ollama" }).name).toBe("ollama");
    expect(createProvider({ ...base, provider: "vllm" }).name).toBe("vllm");
    expect(createProvider({ ...base, provider: "openai" }).name).toBe("openai");
  });

  it("uses the per-provider default base URL resolved by the config loader", () => {
    expect(daemonConfig({ MESH_PROVIDER: "ollama" }).providerBaseUrl).toBe(OLLAMA_DEFAULT_BASE_URL);
    expect(daemonConfig({ MESH_PROVIDER: "vllm" }).providerBaseUrl).toBe(VLLM_DEFAULT_BASE_URL);
    expect(daemonConfig({ MESH_PROVIDER: "openai" }).providerBaseUrl).toBe(OPENAI_DEFAULT_BASE_URL);
  });

  it("passes overrides through to the adapter", () => {
    const stub = stubFetch(() => ({ status: 200, body: { models: [] } }));
    const provider = createProvider(
      { ...base, providerBaseUrl: "http://elsewhere.test" },
      { fetchImpl: stub.fetch, requestTimeoutMs: 5, controlTimeoutMs: 5, apiKey: "sk-x" },
    );

    expect(provider.baseUrl).toBe("http://elsewhere.test");
  });

  it("rejects a provider it does not implement", () => {
    const unsupported = { ...base, provider: "llamacpp" } as unknown as DaemonConfig;
    expect(() => createProvider(unsupported)).toThrow(ConfigError);
  });
});
