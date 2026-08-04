import { describe, expect, it } from "vitest";
import request from "supertest";
import { ConfigError, parseModelPrices, priceTiers, resolveModelPrice } from "@x402-mesh/shared";
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
 * Per-model pricing, checked at the wire rather than at the helper.
 *
 * The load-bearing claim is not "the config parses" — it is that the 402 a client receives
 * quotes the price of the model that client asked for. That price lives in the base64
 * `payment-required` header, so every assertion here decodes the header. Asserting on the
 * JSON preview body instead would pass even if the actual payment requirement were wrong,
 * which is precisely the failure this feature can produce.
 */

const PRICES = {
  "premium-70b": "0.0100",
  "cheap-8b": "0.0005",
};

function buildApp(modelPricesUsdc: Record<string, string>) {
  const config = makeConfig({ modelPricesUsdc });
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

/** Decodes the amount a 402 actually demands, in atomic USDC units. */
async function quotedAtomic(app: ReturnType<typeof buildApp>, model: unknown): Promise<string> {
  const response = await request(app)
    .post("/v1/chat/completions")
    .set("accept", "application/json")
    .send({ model, messages: [{ role: "user", content: "hi" }] });

  expect(response.status).toBe(402);
  const required = decodePaymentRequiredHeader(response.headers["payment-required"] as string);
  const accepts = required.accepts[0];
  expect(accepts, "402 must carry at least one payment option").toBeDefined();
  return (accepts as { amount: string }).amount;
}

describe("per-model pricing on the wire", () => {
  it("quotes the premium price for the premium model", async () => {
    expect(await quotedAtomic(buildApp(PRICES), "premium-70b")).toBe("10000");
  });

  it("quotes the cheap price for the cheap model in the same deployment", async () => {
    // Same app instance, so this also proves the tiers are genuinely independent middlewares
    // and not one shared object being rewritten per request.
    const app = buildApp(PRICES);
    expect(await quotedAtomic(app, "premium-70b")).toBe("10000");
    expect(await quotedAtomic(app, "cheap-8b")).toBe("500");
    expect(await quotedAtomic(app, "premium-70b")).toBe("10000");
  });

  it("does not let concurrent requests for different models cross-quote", async () => {
    const app = buildApp(PRICES);
    const [premium, cheap] = await Promise.all([
      quotedAtomic(app, "premium-70b"),
      quotedAtomic(app, "cheap-8b"),
    ]);
    expect(premium).toBe("10000");
    expect(cheap).toBe("500");
  });

  it("falls back to the flat price for an unlisted model", async () => {
    expect(await quotedAtomic(buildApp(PRICES), "some-other-model")).toBe("2000");
  });

  it("matches a model id case-insensitively", async () => {
    expect(await quotedAtomic(buildApp(PRICES), "Premium-70B")).toBe("10000");
  });

  it("falls back to the flat price when the model is absent or not a string", async () => {
    const app = buildApp(PRICES);
    expect(await quotedAtomic(app, undefined)).toBe("2000");
    expect(await quotedAtomic(app, 42)).toBe("2000");
  });

  it("keeps the flat price when no per-model prices are configured", async () => {
    expect(await quotedAtomic(buildApp({}), "premium-70b")).toBe("2000");
  });

  it("serves the whole table from the free /v1/pricing endpoint", async () => {
    const response = await request(buildApp(PRICES)).get("/v1/pricing");

    expect(response.status).toBe(200);
    expect(response.body.default.usdc).toBe("0.0020");
    // Cheapest first, so an agent optimising for cost reads the top of the list.
    expect(response.body.models.map((m: { model: string }) => m.model)).toEqual([
      "cheap-8b",
      "premium-70b",
    ]);
    expect(response.body.models[0].atomic).toBe("500");
  });

  it("advertises the table inside the 402 preview body", async () => {
    const response = await request(buildApp(PRICES))
      .post("/v1/chat/completions")
      .set("accept", "application/json")
      .send({ model: "premium-70b", messages: [{ role: "user", content: "hi" }] });

    expect(response.body.price.usdc).toBe("0.0100");
    expect(response.body.pricing.models).toHaveLength(2);
  });
});

describe("parseModelPrices", () => {
  it("returns an empty table for absent or blank input", () => {
    expect(parseModelPrices(undefined)).toEqual({});
    expect(parseModelPrices("   ")).toEqual({});
  });

  it("lowercases model ids so lookup is total across the three sources", () => {
    expect(parseModelPrices('{"Llama-3.3-70B":"0.004"}')).toEqual({ "llama-3.3-70b": "0.004" });
  });

  it("rejects a malformed price at boot rather than at payment time", () => {
    expect(() => parseModelPrices('{"a":"0.00000001"}')).toThrow(ConfigError);
    expect(() => parseModelPrices('{"a":"-1"}')).toThrow(ConfigError);
    expect(() => parseModelPrices('{"a":"free"}')).toThrow(ConfigError);
  });

  it("rejects structurally wrong input", () => {
    expect(() => parseModelPrices("not json")).toThrow(ConfigError);
    expect(() => parseModelPrices('["0.002"]')).toThrow(ConfigError);
    expect(() => parseModelPrices('{"a":0.002}')).toThrow(ConfigError);
    expect(() => parseModelPrices('{"":"0.002"}')).toThrow(ConfigError);
  });

  it("caps distinct tiers, because each one costs a facilitator sync at boot", () => {
    const many = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`m${i}`, `0.00${String(i).padStart(4, "0")}`]),
    );
    expect(() => parseModelPrices(JSON.stringify(many))).toThrow(/maximum is 16/);
  });

  it("counts distinct prices, not models, against the cap", () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`m${i}`, "0.0020"]));
    expect(() => parseModelPrices(JSON.stringify(many))).not.toThrow();
  });
});

describe("resolveModelPrice and priceTiers", () => {
  it("resolves overrides and falls back otherwise", () => {
    expect(resolveModelPrice(PRICES, "0.0020", "premium-70b")).toBe("0.0100");
    expect(resolveModelPrice(PRICES, "0.0020", "unknown")).toBe("0.0020");
    expect(resolveModelPrice(PRICES, "0.0020", undefined)).toBe("0.0020");
  });

  it("lists the fallback first and deduplicates shared prices", () => {
    expect(priceTiers(PRICES, "0.0020")).toEqual(["0.0020", "0.0100", "0.0005"]);
    expect(priceTiers({ a: "0.0020", b: "0.0020" }, "0.0020")).toEqual(["0.0020"]);
  });
});
