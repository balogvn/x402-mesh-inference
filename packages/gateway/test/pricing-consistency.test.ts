import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  isSafeModelId,
  NodeCapabilitySchema,
  parseModelPrices,
  resolveModelPrice,
  usdcToAtomic,
} from "@x402-mesh/shared";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createApp } from "../src/app.js";
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
 * Every surface that quotes a price must agree with the 402 challenge, and no surface may be
 * poisoned by an attacker-chosen model id.
 *
 * Both classes of bug shipped to production. Per-model pricing was wired into `/v1/pricing`,
 * `llms.txt` and the 402 preview but *not* into the discovery manifest, the settlements
 * `economics` block, the landing page or the chat UI — so four public surfaces advertised
 * $0.0020 while every model the mesh could serve cost $0.0060. Separately, the fix that made
 * the quickstart name a live model interpolated that model id straight into JavaScript users
 * are told to run with a private key in their environment.
 *
 * These tests exist because "the feature works" and "every surface agrees" are different
 * claims, and only the second one is what a customer experiences.
 */

const PRICES = { "premium-70b": "0.0100" };

function buildApp(modelPricesUsdc: Record<string, string> = PRICES, model = "premium-70b") {
  const config = makeConfig({ modelPricesUsdc });
  const node = makeNodeRecord(
    {},
    { capabilities: [{ model, contextWindow: 8192, pricePer1kTokensUsdc: "0.0004" }] },
  );
  return {
    config,
    app: createApp({
      config,
      store: new StubStore([node]),
      selector: new StubSelector([node]),
      settlement: new StubSettlement(),
      resourceServer: buildResourceServer(config, new StubFacilitator()),
      syncFacilitatorOnStart: true,
    }),
  };
}

/** The amount the 402 actually demands — from the header, which is the authoritative copy. */
async function challengeAmount(app: ReturnType<typeof buildApp>["app"], model: string) {
  const response = await request(app)
    .post("/v1/chat/completions")
    .set("accept", "application/json")
    .send({ model, messages: [{ role: "user", content: "hi" }] });
  const required = decodePaymentRequiredHeader(response.headers["payment-required"] as string);
  return (required.accepts[0] as { amount: string }).amount;
}

describe("every price-stating surface agrees with the challenge", () => {
  it("the discovery manifest carries a payment option for the premium tier", async () => {
    const { app } = buildApp();
    const quoted = await challengeAmount(app, "premium-70b");
    expect(quoted).toBe("10000");

    const manifest = await request(app).get("/.well-known/x402");
    const item = manifest.body.items[0];
    const amounts = item.accepts.map((a: { amount: string }) => a.amount);

    // The manifest advertised only the flat fallback, so an agent that configured itself from
    // discovery signed 2000 against a 10000 challenge and was rejected.
    expect(amounts).toContain(quoted);
    expect(item.pricing.models[0]).toMatchObject({ model: "premium-70b", amount: "10000" });
  });

  it("the settlements economics block does not contradict a premium settlement", async () => {
    const { app } = buildApp();
    const body = (await request(app).get("/v1/settlements")).body;

    // The bare keys are the fallback tier and must say so; the premium tier must be present.
    expect(body.economics.appliesTo).toMatch(/not listed/);
    expect(body.economics.models).toContainEqual(
      expect.objectContaining({ model: "premium-70b", inboundAtomic: "10000" }),
    );
  });

  it("the landing page quotes a range, not one price, when tiers exist", async () => {
    const html = (await request(buildApp().app).get("/")).text;
    expect(html).toContain("premium-70b");
    expect(html).toMatch(/by model/);
  });

  it("the landing page still quotes a single price under flat pricing", async () => {
    const html = (await request(buildApp({}, "any-model").app).get("/")).text;
    expect(html).not.toMatch(/by model/);
    expect(html).toContain("Every request");
  });

  it("llms.txt does not emit the same key twice with different meanings", async () => {
    const text = (await request(buildApp().app).get("/llms.txt")).text;
    const keys = [...text.matchAll(/^- ([A-Za-z]+):/gm)].map((m) => m[1]);
    // A duplicated key means a parser keeps whichever it saw last and silently drops the
    // other — here, dropping the per-model table and keeping the flat price.
    expect(new Set(keys).size, `duplicate keys in: ${keys.join(", ")}`).toBe(keys.length);
  });
});

describe("an attacker-chosen model id cannot poison a served page", () => {
  const HOSTILE = '";import("node:child_process").then(m=>m.execSync("id"));//';

  it("is rejected at registration", () => {
    const parsed = NodeCapabilitySchema.safeParse({
      model: HOSTILE,
      contextWindow: 8192,
      pricePer1kTokensUsdc: "0.0004",
    });
    expect(parsed.success).toBe(false);
  });

  it("is rejected by the runtime guard, for records stored before the schema existed", () => {
    expect(isSafeModelId(HOSTILE)).toBe(false);
    expect(isSafeModelId("llama-3.3-70b-versatile")).toBe(true);
    expect(isSafeModelId("meta-llama/Llama-3-8b")).toBe(true);
    expect(isSafeModelId("llama3.1:8b")).toBe(true);
    expect(isSafeModelId("has space")).toBe(false);
    expect(isSafeModelId("back`tick")).toBe(false);
    expect(isSafeModelId("dollar${x}")).toBe(false);
  });

  it("never reaches the served quickstart even if a hostile record exists", async () => {
    // Bypass the schema the way a pre-existing stored record would.
    const node = makeNodeRecord({}, { capabilities: [] });
    (node.registration as { capabilities: unknown[] }).capabilities = [
      { model: HOSTILE, contextWindow: 8192, pricePer1kTokensUsdc: "0.0004" },
    ];
    const config = makeConfig();
    const app = createApp({
      config,
      store: new StubStore([node]),
      selector: new StubSelector([node]),
      settlement: new StubSettlement(),
    });

    const snippet = (await request(app).get("/quickstart/pay.mjs")).text;
    expect(snippet).not.toContain("child_process");
    expect(snippet).not.toContain("execSync");
    // And what it does emit must still be valid JS, not a broken string literal.
    expect(snippet).toMatch(/model: "[A-Za-z0-9._:/-]+",/);
  });
});

describe("model-id lookups cannot fall through to Object.prototype", () => {
  it("resolveModelPrice returns the fallback for prototype member names", () => {
    for (const hostile of ["constructor", "__proto__", "toString", "valueOf"]) {
      const price = resolveModelPrice(PRICES, "0.0020", hostile);
      expect(typeof price, `${hostile} must resolve to a string`).toBe("string");
      expect(price).toBe("0.0020");
      // And it must still be parseable as money, which a function or object would not be.
      expect(() => usdcToAtomic(price)).not.toThrow();
    }
  });

  it("parseModelPrices builds a table with no inherited members", () => {
    const table = parseModelPrices('{"a":"0.0020"}');
    expect(Object.getPrototypeOf(table)).toBeNull();
    expect(resolveModelPrice(table, "0.0030", "constructor")).toBe("0.0030");
  });

  it("quotes the fallback price on the wire for a prototype-named model", async () => {
    const { app } = buildApp();
    expect(await challengeAmount(app, "constructor")).toBe("2000");
  });
});

describe("a malformed request is the caller's error, not the server's", () => {
  it("answers 400 for unparseable JSON, not 500", async () => {
    const response = await request(buildApp().app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send('{"model": "premium-70b", ');

    // A 500 here tells the caller the server broke, gives them nothing to fix, and inflates
    // any error-rate alarm with traffic that is behaving exactly as designed.
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/not valid JSON/);
  });

  it("answers 413 for an oversized body", async () => {
    const response = await request(buildApp().app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send(JSON.stringify({ model: "premium-70b", padding: "x".repeat(2_000_000) }));

    expect(response.status).toBe(413);
  });
});
