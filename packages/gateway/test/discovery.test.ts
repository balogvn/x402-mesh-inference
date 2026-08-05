import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { facilitatorNetwork, ALGORAND_TESTNET } from "@x402-mesh/shared";
import { createApp } from "../src/app.js";
import { buildManifest } from "../src/routes/discovery.js";
import { makeConfig, StubSelector, StubSettlement, StubStore, TEST_PAY_TO } from "./helpers.js";

/**
 * Discovery is how an autonomous agent finds and prices this service, so the one thing that
 * must never happen is a manifest advertising a price or a payout address that differs from
 * what the gateway will actually charge and receive.
 */

function buildApp(specDir?: string) {
  const config = makeConfig();
  return {
    config,
    app: createApp({
      config,
      store: new StubStore(),
      selector: new StubSelector([]),
      settlement: new StubSettlement(),
      ...(specDir === undefined ? {} : { specDir }),
    }),
  };
}

/** Writes a spec directory containing a template with deliberately wrong payment fields. */
function templateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-spec-"));
  writeFileSync(
    join(dir, "well-known-x402.json"),
    JSON.stringify({
      x402Version: 2,
      serviceName: "x402 Mesh Inference",
      description: "template description that should survive",
      items: [
        {
          resource: "https://mesh.example.com/v1/chat/completions",
          type: "http",
          accepts: [
            {
              scheme: "exact",
              network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k",
              asset: "31566704",
              amount: "999999",
              payTo: "PLACEHOLDERADDRESSPLACEHOLDERADDRESSPLACEHOLDERADDRESSPLAC",
              maxTimeoutSeconds: 120,
            },
          ],
          tags: ["stale-tag"],
          description: "template item description that should survive",
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "llms.txt"),
    "# Template\n\nCall POST https://mesh.example.com/v1/chat/completions to use this.\n",
  );
  return dir;
}

describe("GET /.well-known/x402", () => {
  it("generates a valid manifest when no template is checked in", async () => {
    const { app } = buildApp("/nonexistent/spec/dir");

    const response = await request(app).get("/.well-known/x402");

    expect(response.status).toBe(200);
    expect(response.body.x402Version).toBe(2);
    const item = response.body.items[0];
    expect(item.resource).toBe("https://mesh.test/v1/chat/completions");
    expect(item.accepts[0].amount).toBe("2000");
    // The FACILITATOR form (full genesis hash), not the canonical truncated id. A client
    // matches the challenge's `network` verbatim, so a manifest advertising the truncated
    // form hands a discovery-configured client the exact "No network/scheme registered"
    // failure the quickstart warns about.
    expect(item.accepts[0].network).toBe(facilitatorNetwork(ALGORAND_TESTNET));
    expect(item.accepts[0].asset).toBe("10458941");
    expect(item.accepts[0].payTo).toBe(TEST_PAY_TO);
    expect(item.tags).toContain("x402-global-challenge");
    expect(item.extensions.bazaar.info.input.bodyType).toBe("json");
  });

  it("keeps template prose but overrides every payment-bearing field", async () => {
    const { app } = buildApp(templateDir());

    const response = await request(app).get("/.well-known/x402");
    const item = response.body.items[0];

    // Prose from the template survives.
    expect(response.body.description).toBe("template description that should survive");
    expect(item.description).toBe("template item description that should survive");

    // Anything that determines where money goes comes from the live configuration.
    expect(item.resource).toBe("https://mesh.test/v1/chat/completions");
    expect(item.accepts[0].amount).toBe("2000");
    // The FACILITATOR form (full genesis hash), not the canonical truncated id. A client
    // matches the challenge's `network` verbatim, so a manifest advertising the truncated
    // form hands a discovery-configured client the exact "No network/scheme registered"
    // failure the quickstart warns about.
    expect(item.accepts[0].network).toBe(facilitatorNetwork(ALGORAND_TESTNET));
    expect(item.accepts[0].asset).toBe("10458941");
    expect(item.accepts[0].payTo).toBe(TEST_PAY_TO);
    expect(item.tags).toContain("x402-global-challenge");
    expect(item.tags).not.toContain("stale-tag");
  });

  it("strips template maintenance comments from the served manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-spec-comment-"));
    writeFileSync(
      join(dir, "well-known-x402.json"),
      JSON.stringify({
        $comment: "note to whoever maintains this template",
        x402Version: 2,
        items: [
          { $comment: "item note", resource: "https://mesh.example.com/v1/chat/completions" },
        ],
      }),
    );
    const { app } = buildApp(dir);

    const response = await request(app).get("/.well-known/x402");

    // These are instructions to ourselves, not part of the contract an agent reads.
    expect(response.body.$comment).toBeUndefined();
    expect(response.body.items[0].$comment).toBeUndefined();
  });

  it("reflects a reconfigured price", () => {
    const config = makeConfig({ inboundPriceUsdc: "0.0500" });
    const manifest = buildManifest(config);
    const item = (manifest["items"] as Array<Record<string, unknown>>)[0];
    const accepts = item?.["accepts"] as Array<Record<string, unknown>>;

    // $0.05 with 6 decimals is 50000 atomic units, computed with integer arithmetic.
    expect(accepts[0]?.["amount"]).toBe("50000");
  });

  it("keeps the tag list within the Bazaar's five-tag ceiling", () => {
    const manifest = buildManifest(makeConfig());
    const item = (manifest["items"] as Array<Record<string, unknown>>)[0];
    const tags = item?.["tags"] as string[];

    // sanitizeTags silently drops everything past the fifth, so the mandatory challenge tag
    // has to be inside the window rather than merely present.
    expect(tags.length).toBeLessThanOrEqual(5);
    expect(tags[0]).toBe("x402-global-challenge");
  });

  it("falls back to generation when the template is not valid JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-spec-bad-"));
    writeFileSync(join(dir, "well-known-x402.json"), "{ not json");
    const { app } = buildApp(dir);

    const response = await request(app).get("/.well-known/x402");

    expect(response.status).toBe(200);
    expect(response.body.items[0].accepts[0].amount).toBe("2000");
  });
});

describe("GET /llms.txt", () => {
  it("serves plain text carrying the live price, network and payout address", async () => {
    const { app } = buildApp("/nonexistent/spec/dir");

    const response = await request(app).get("/llms.txt");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("$0.0020 USDC per request (2000 atomic units");
    expect(response.text).toContain(ALGORAND_TESTNET);
    expect(response.text).toContain(TEST_PAY_TO);
    expect(response.text).toContain("x402-global-challenge");
  });

  it("keeps the template prose and rewrites the placeholder origin", async () => {
    const { app } = buildApp(templateDir());

    const response = await request(app).get("/llms.txt");

    expect(response.text).toContain("# Template");
    expect(response.text).toContain("https://mesh.test/v1/chat/completions");
    expect(response.text).not.toContain("mesh.example.com");
    // The live block is appended so the served copy cannot disagree with the gateway.
    expect(response.text).toContain("## Live configuration");
  });
});

describe("GET /static/icon.svg", () => {
  it("resolves, because the Bazaar iconUrl points at it", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/static/icon.svg");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    // supertest buffers a non-text content type, so read the body rather than `.text`.
    expect(Buffer.from(response.body).toString("utf8")).toContain("<svg");
  });
});
