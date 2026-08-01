import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { landingEconomics, renderLanding } from "../src/routes/landing.js";
import {
  makeConfig,
  makeNodeRecord,
  StubChain,
  StubSelector,
  StubSettlement,
  StubStore,
} from "./helpers.js";

/**
 * The human front door.
 *
 * Two things matter and neither is cosmetic: the page must never sit behind the paywall (a
 * browser being asked to pay to read what the service *is* is absurd), and the numbers it
 * quotes must be derived from the same code the 402 uses, so the page cannot advertise a
 * price the gateway would not honour.
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

describe("GET /", () => {
  it("serves HTML, not JSON", async () => {
    const res = await request(buildApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("<!doctype html>");
  });

  it("is free — never behind the paywall", async () => {
    // A 402 here would mean a browser is asked to pay to find out what this service is.
    const res = await request(buildApp()).get("/");
    expect(res.status).not.toBe(402);
    expect(res.status).toBe(200);
  });

  it("quotes the same economics the settlement path computes", () => {
    const config = makeConfig();
    const e = landingEconomics(config);
    // The published split: 2000 = 1700 + 300 atomic.
    expect(e.inboundAtomic).toBe("2000");
    expect(e.payoutAtomic).toBe("1700");
    expect(e.marginAtomic).toBe("300");
    expect(BigInt(e.inboundAtomic)).toBe(BigInt(e.payoutAtomic) + BigInt(e.marginAtomic));
  });

  it("advertises the correct USDC asset for the configured network", () => {
    expect(landingEconomics(makeConfig()).asset).toBe("10458941");
  });

  it("renders the atomic figures into the page", async () => {
    const res = await request(buildApp()).get("/");
    expect(res.text).toContain("2000");
    expect(res.text).toContain("1700");
    expect(res.text).toContain("300");
    expect(res.text).toContain("10458941");
  });

  it("is fully self-contained — no external CDN, font or script", () => {
    const html = renderLanding(makeConfig());
    // A gateway serves payments, not assets. An external reference is a hard dependency on
    // someone else's uptime and a CSP problem waiting to happen.
    const external = html.match(/(?:src|href)="https?:\/\/[^"]+"/g) ?? [];
    const offenders = external.filter(
      (ref) => !ref.includes("lora.algokit.io") && !ref.includes("facilitator"),
    );
    expect(offenders).toEqual([]);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it("escapes interpolated configuration rather than trusting it", () => {
    const html = renderLanding(
      makeConfig({ facilitatorUrl: 'https://evil.test/"><script>alert(1)</script>' }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("links the agent-facing surface", async () => {
    const res = await request(buildApp()).get("/");
    for (const href of ["/.well-known/x402", "/llms.txt", "/v1/nodes", "/v1/settlements"]) {
      expect(res.text).toContain(`href="${href}"`);
    }
  });

  it("does not shadow the API routes it sits alongside", async () => {
    const app = buildApp();
    expect((await request(app).get("/healthz")).status).toBe(200);
    expect((await request(app).get("/v1/nodes")).status).toBe(200);
  });
});
