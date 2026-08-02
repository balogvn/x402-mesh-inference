import { describe, expect, it } from "vitest";

import { NodeServer } from "../src/server.js";
import type { InferenceProvider } from "../src/providers/types.js";

/**
 * Regression: the daemon must serve the path the gateway actually calls.
 *
 * The gateway routes paid work to `${endpoint}/v1/chat/completions`. The daemon served only
 * `/infer`, so every routed request came back 404 and every paid request died with
 * `upstream_error: node returned HTTP 404`. The whole suite passed regardless, because the
 * mock node in scripts/lib/mock-node.ts serves `/v1/chat/completions` — the tests exercised
 * the gateway's contract against a stub that honoured it, while the real daemon did not.
 */
const provider: InferenceProvider = {
  name: "openai",
  baseUrl: "http://backend.test",
  listModels: () => Promise.resolve(["m"]),
  chat: () =>
    Promise.resolve({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  chatStream: async function* () {
    yield {
      id: "c",
      object: "chat.completion.chunk" as const,
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
    };
  },
  health: () => Promise.resolve(true),
};

/** Starts the server on an ephemeral port and returns its base URL plus a stopper. */
async function start() {
  const server = new NodeServer({
    provider,
    nodeId: "n1",
    port: 0,
    host: "127.0.0.1",
    models: ["m"],
    maxConcurrency: 2,
  });
  const port = await server.listen();
  return { base: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

describe("daemon HTTP routes", () => {
  it("serves POST /v1/chat/completions — the path the gateway calls", async () => {
    const { base, stop } = await start();
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      // A 404 here means no paid request can ever be routed to this node.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      expect(body.choices[0]?.message.content).toBe("ok");
    } finally {
      await stop();
    }
  });

  it("keeps /infer working as an alias", async () => {
    const { base, stop } = await start();
    try {
      const res = await fetch(`${base}/infer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
    } finally {
      await stop();
    }
  });

  it("still 404s an unknown path", async () => {
    const { base, stop } = await start();
    try {
      expect((await fetch(`${base}/nope`, { method: "POST" })).status).toBe(404);
    } finally {
      await stop();
    }
  });
});
