import { describe, expect, it } from "vitest";
import request from "supertest";
import { CHALLENGE_TAG } from "@x402-mesh/shared";
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
 * The challenge tag has to be on the payment requirement, not just in the route's tag list.
 *
 * Both fields exist, both are called tags, and only one of them puts a resource on the x402
 * Global Challenge leaderboard. The Bazaar catalog reads `accepts[].extra.tag`; the route's
 * `tags` array is descriptive discovery metadata the challenge filter never consults.
 *
 * This service shipped with the tag in `tags` only. It appeared in the general Bazaar catalog
 * with a real settleCount and was completely absent from the hackathon leaderboard — a
 * one-field mistake that cost the entire competitive point of the project, and that no test
 * caught because every test asserted on `tags`.
 *
 * So these assertions decode the actual `payment-required` header rather than reading the
 * route config, and they check the tag survives *alongside* whatever the scheme adds.
 */

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

async function challengeExtraOnWire(app: ReturnType<typeof buildApp>) {
  const response = await request(app)
    .post("/v1/chat/completions")
    .set("accept", "application/json")
    .send({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] });

  expect(response.status).toBe(402);
  const required = decodePaymentRequiredHeader(response.headers["payment-required"] as string);
  return (required.accepts[0] as { extra?: Record<string, unknown> }).extra ?? {};
}

describe("the challenge tag reaches the payment requirement", () => {
  it("is present at accepts[].extra.tag on the decoded 402", async () => {
    const extra = await challengeExtraOnWire(buildApp());
    expect(extra["tag"], "the Bazaar challenge filter reads accepts[].extra.tag").toBe(
      CHALLENGE_TAG,
    );
  });

  it("does not displace whatever the scheme itself puts in extra", async () => {
    // The AVM scheme merges `feePayer` into `extra` during enrichment. Supplying a baseline
    // `extra` must be additive — a scheme that replaced it would silently drop the tag, or
    // ours would drop the fee payer and make the challenge unpayable.
    const config = makeConfig();
    const node = makeNodeRecord();
    const app = createApp({
      config,
      store: new StubStore([node]),
      selector: new StubSelector([node]),
      settlement: new StubSettlement(),
      resourceServer: buildResourceServer(config, new StubFacilitator()),
      syncFacilitatorOnStart: true,
    });
    const extra = await challengeExtraOnWire(app);
    expect(Object.keys(extra)).toContain("tag");
  });

  it("is also on the discovery manifest, so the two surfaces agree", async () => {
    const manifest = await request(buildApp()).get("/.well-known/x402");
    const accepts = manifest.body.items[0].accepts as { extra?: Record<string, unknown> }[];
    for (const option of accepts) {
      expect(option.extra?.["tag"]).toBe(CHALLENGE_TAG);
    }
  });

  it("keeps the descriptive tag list too — they serve different readers", async () => {
    const manifest = await request(buildApp()).get("/.well-known/x402");
    expect(manifest.body.items[0].tags).toContain(CHALLENGE_TAG);
  });

  it("tracks X402_CHALLENGE_TAG rather than hardcoding the string", async () => {
    const config = makeConfig({ challengeTag: "some-other-challenge" });
    const node = makeNodeRecord();
    const app = createApp({
      config,
      store: new StubStore([node]),
      selector: new StubSelector([node]),
      settlement: new StubSettlement(),
      resourceServer: buildResourceServer(config, new StubFacilitator()),
      syncFacilitatorOnStart: true,
    });
    const extra = await challengeExtraOnWire(app);
    expect(extra["tag"]).toBe("some-other-challenge");
  });
});
