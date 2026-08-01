import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { renderChatUi } from "../src/routes/chat-ui.js";
import {
  makeConfig,
  makeNodeRecord,
  StubChain,
  StubSelector,
  StubSettlement,
  StubStore,
} from "./helpers.js";

/**
 * The browser chat client.
 *
 * What matters here is the same as for the landing page: it must be free, self-contained, and
 * must not invent numbers. Plus one thing specific to chat — it must reuse the official
 * paywall for payment rather than reimplementing wallet signing.
 */
function buildApp() {
  const record = makeNodeRecord();
  return createApp({
    config: makeConfig(),
    store: new StubStore([record]),
    selector: new StubSelector([record]),
    settlement: new StubSettlement(),
    chain: new StubChain(true),
  });
}

describe("GET /chat", () => {
  it("serves an HTML document", async () => {
    const res = await request(buildApp()).get("/chat");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("<!doctype html>");
  });

  it("is free — the page costs nothing, only the completions do", async () => {
    const res = await request(buildApp()).get("/chat");
    expect(res.status).not.toBe(402);
  });

  it("quotes the configured price", async () => {
    const res = await request(buildApp()).get("/chat");
    expect(res.text).toContain("0.002000");
  });

  it("requests the paywall via Accept: text/html rather than signing anything itself", () => {
    const html = renderChatUi(makeConfig());
    // The wallet flow must be the protocol's own. If this page ever started building
    // transactions directly it would drift from the spec and duplicate signing logic.
    expect(html).toContain('accept: "text/html"');
    expect(html).not.toMatch(/algosdk|signTransaction|mnemonic|privateKey/i);
  });

  it("parses SSE with a buffer, so a frame split across chunks is not lost", () => {
    const html = renderChatUi(makeConfig());
    // The naive implementation JSON.parses each chunk and silently drops torn frames.
    expect(html).toContain("[DONE]");
    expect(html).toContain("parts.pop()");
  });

  it("handles the three response states a caller can actually hit", () => {
    const html = renderChatUi(makeConfig());
    expect(html).toContain("res.status === 402");
    expect(html).toContain("res.status === 503");
  });

  it("is self-contained — no external script or stylesheet", () => {
    const html = renderChatUi(makeConfig());
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });

  it("sandboxes the embedded paywall frame", () => {
    // The paywall is first-party, but it is still a 3 MB third-party-authored document being
    // injected into our origin; constraining it costs nothing.
    expect(renderChatUi(makeConfig())).toContain("sandbox=");
  });

  it("does not shadow the paid route it calls", async () => {
    const res = await request(buildApp())
      .post("/v1/chat/completions")
      .set("accept", "application/json")
      .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });
    // Unguarded in this fixture (no resourceServer), so it must reach the router, not the page.
    expect(res.headers["content-type"]).not.toMatch(/text\/html/);
  });
});
