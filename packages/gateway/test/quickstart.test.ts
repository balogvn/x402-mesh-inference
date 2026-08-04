import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { quickstartClient } from "../src/routes/quickstart.js";
import { EXAMPLE_REQUEST } from "../src/x402/routes.js";
import { buildResourceServer } from "../src/x402/server.js";
import {
  makeConfig,
  makeNodeRecord,
  StubFacilitator,
  StubSelector,
  StubSettlement,
  StubStore,
} from "./helpers.js";

/**
 * The quickstart is documentation that ships as code, so it is tested as code.
 *
 * A published snippet that does not parse, or that has quietly regressed to advising the
 * wrong header, is worse than no snippet: a developer trusts it, fails, and blames the
 * service. The syntax check below is the load-bearing one — the snippet is assembled by
 * string interpolation inside a template literal, which is exactly the construction where a
 * stray backtick or `${` produces something that reads fine and does not run.
 */

const scratch = mkdtempSync(join(tmpdir(), "x402-quickstart-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A model id distinct from the static example, so a fallback cannot masquerade as a hit. */
const MODEL = "some-live-model";

function buildApp() {
  const config = makeConfig();
  const node = makeNodeRecord();
  return createApp({
    config,
    store: new StubStore([node]),
    selector: new StubSelector([node]),
    settlement: new StubSettlement(),
    resourceServer: buildResourceServer(config, new StubFacilitator()),
    syncFacilitatorOnStart: true,
  });
}

describe("quickstart", () => {
  it("emits a snippet that actually parses as an ES module", () => {
    const file = join(scratch, "pay.mjs");
    writeFileSync(file, quickstartClient(makeConfig(), MODEL), "utf8");
    // `node --check` parses without executing, so this needs no wallet and makes no network
    // call. It throws a non-zero exit on a syntax error, failing the test with the location.
    expect(() => execFileSync(process.execPath, ["--check", file])).not.toThrow();
  });

  it("keeps the two corrections that make a first integration succeed", () => {
    const snippet = quickstartClient(makeConfig(), MODEL);
    // The header, not the body — reading the body yields an empty `accepts[]`.
    expect(snippet).toContain("decodePaymentRequiredHeader");
    expect(snippet).toContain('headers.get("payment-required")');
    // The wildcard, not the canonical network constant.
    expect(snippet).toContain('register("algorand:*"');
    // The SDK's header map, spread verbatim — never a hand-written header name. The comment
    // in the snippet names `X-PAYMENT` to warn against it, so this asserts on the quoted
    // form: a header key, not a mention.
    expect(snippet).toContain("encodePaymentSignatureHeader");
    expect(snippet).not.toContain('"X-PAYMENT"');
    expect(snippet).not.toContain("'X-PAYMENT'");
  });

  it("points at the deployment it was served from, not a placeholder", () => {
    const snippet = quickstartClient(makeConfig({ publicBaseUrl: "https://live.example" }), MODEL);
    expect(snippet).toContain("https://live.example/v1/chat/completions");
    expect(snippet).not.toContain("mesh.example.com");
  });

  it("never embeds a key, only reads one from the environment", () => {
    const snippet = quickstartClient(makeConfig(), MODEL);
    expect(snippet).toContain("process.env.AVM_PRIVATE_KEY");
  });

  it("serves plain text to curl and HTML to a browser, both free", async () => {
    const app = buildApp();

    const text = await request(app).get("/quickstart").set("accept", "text/plain");
    expect(text.status).toBe(200);
    expect(text.headers["content-type"]).toMatch(/text\/plain/);
    expect(text.text).toContain("npm i @x402/core @x402/avm");

    const html = await request(app).get("/quickstart").set("accept", "text/html");
    expect(html.status).toBe(200);
    expect(html.headers["content-type"]).toMatch(/text\/html/);
    expect(html.text).toContain("<!doctype html>");
  });

  it("serves the runnable file directly", async () => {
    const response = await request(buildApp()).get("/quickstart/pay.mjs");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/javascript/);
    expect(response.text).toContain("x402HTTPClient");
  });

  /**
   * The regression that reached production. The shipped snippet named the static example
   * model, no registered node served it, and a developer running it verbatim paid the
   * fallback price and then failed to route — the "60-second integration" failing at second
   * 61, having already taken their money.
   *
   * The original tests all passed: they asserted the snippet contained the right SDK calls
   * and never that the model it named could actually be served.
   */
  it("names a model the mesh can actually serve", async () => {
    // The advertised model must differ from the static example, otherwise this test passes
    // just as happily when the lookup silently falls back — which is the bug, not the fix.
    const served = "mixtral-8x22b-live";
    expect(served).not.toBe(EXAMPLE_REQUEST.model);

    const node = makeNodeRecord(
      {},
      { capabilities: [{ model: served, contextWindow: 8192, pricePer1kTokensUsdc: "0.0004" }] },
    );
    const config = makeConfig();
    const app = createApp({
      config,
      store: new StubStore([node]),
      selector: new StubSelector([node]),
      settlement: new StubSettlement(),
    });

    for (const path of ["/quickstart/pay.mjs", "/quickstart"]) {
      const response = await request(app).get(path).set("accept", "text/plain");
      expect(response.text, `${path} must name the servable model`).toContain(served);
      expect(response.text, `${path} must not name the static example`).not.toContain(
        EXAMPLE_REQUEST.model,
      );
    }
  });

  it("falls back to the static example when the mesh is empty", async () => {
    // Better a stale example than a crash: the page must still render for someone
    // evaluating the service before any node has registered.
    const config = makeConfig();
    const app = createApp({
      config,
      store: new StubStore([]),
      selector: new StubSelector([]),
      settlement: new StubSettlement(),
    });
    const response = await request(app).get("/quickstart/pay.mjs");
    expect(response.status).toBe(200);
    expect(response.text).toContain("model:");
  });

  it("escapes interpolated configuration into the HTML view", async () => {
    // The base URL reaches the page from configuration, so it must not be able to close a tag.
    const config = makeConfig({ publicBaseUrl: 'https://x.test/"><script>alert(1)</script>' });
    const app = createApp({
      config,
      store: new StubStore([]),
      selector: new StubSelector([]),
      settlement: new StubSettlement(),
    });
    const response = await request(app).get("/quickstart").set("accept", "text/html");
    expect(response.text).not.toContain("<script>alert(1)</script>");
    expect(response.text).toContain("&lt;script&gt;");
  });
});
