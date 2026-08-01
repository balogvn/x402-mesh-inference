import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { createApp } from "../src/app.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { rateLimit } from "../src/middleware/rateLimit.js";
import { silentLogger } from "../src/logger.js";
import {
  makeClock,
  makeConfig,
  makeNodeRecord,
  StubRouter,
  StubSelector,
  StubSettlement,
  StubStore,
} from "./helpers.js";

/**
 * The limiter is deterministic by construction: its only time source is injected, so these
 * tests advance the clock rather than sleeping, and the exact refill boundary is assertable.
 */

function limitedApp(capacity: number, refillPerSecond: number) {
  const clock = makeClock();
  const app = express();
  app.use(rateLimit({ capacity, refillPerSecond, now: clock.now }));
  app.get("/probe", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler(silentLogger));
  return { app, clock };
}

describe("rateLimit", () => {
  it("allows exactly `capacity` requests before tripping", async () => {
    const { app } = limitedApp(3, 1);

    for (let i = 0; i < 3; i += 1) {
      const response = await request(app).get("/probe");
      expect(response.status, `request ${i + 1} should pass`).toBe(200);
      expect(response.headers["x-ratelimit-remaining"]).toBe(String(2 - i));
    }

    const tripped = await request(app).get("/probe");
    expect(tripped.status).toBe(429);
    expect(tripped.body.error.code).toBe("rate_limited");
  });

  it("advertises Retry-After so a well-behaved agent can back off precisely", async () => {
    const { app } = limitedApp(1, 0.5);

    await request(app).get("/probe");
    const tripped = await request(app).get("/probe");

    expect(tripped.status).toBe(429);
    // At 0.5 tokens/second, one whole token takes 2 seconds.
    expect(tripped.headers["retry-after"]).toBe("2");
    expect(tripped.body.error.details.retryAfterSeconds).toBe(2);
  });

  it("refills at exactly the configured rate", async () => {
    const { app, clock } = limitedApp(2, 2);

    await request(app).get("/probe");
    await request(app).get("/probe");
    expect((await request(app).get("/probe")).status).toBe(429);

    // 499ms buys 0.998 tokens — still short of one.
    clock.advance(499);
    expect((await request(app).get("/probe")).status).toBe(429);

    // 500ms buys exactly one.
    clock.advance(1);
    expect((await request(app).get("/probe")).status).toBe(200);
  });

  it("never refills above capacity", async () => {
    const { app, clock } = limitedApp(2, 100);

    await request(app).get("/probe");
    clock.advance(60_000); // an hour's worth of tokens at this rate

    expect((await request(app).get("/probe")).status).toBe(200);
    expect((await request(app).get("/probe")).status).toBe(200);
    // The bucket refilled to its ceiling of 2, not beyond it.
    expect((await request(app).get("/probe")).status).toBe(429);
  });

  it("guards the paid route on a fully assembled app", async () => {
    const config = makeConfig();
    const node = makeNodeRecord();
    const clock = makeClock();
    const app = createApp({
      config,
      store: new StubStore([node]),
      selector: new StubSelector([node]),
      settlement: new StubSettlement(),
      router: new StubRouter(() => ({ node, body: { id: "x" }, latencyMs: 1, attempts: 1 })),
      now: clock.now,
      rateLimitCapacity: 2,
      rateLimitPerSecond: 1,
    });

    const body = { model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] };
    expect((await request(app).post("/v1/chat/completions").send(body)).status).toBe(200);
    expect((await request(app).post("/v1/chat/completions").send(body)).status).toBe(200);
    expect((await request(app).post("/v1/chat/completions").send(body)).status).toBe(429);

    // The free surface is not behind the limiter, whatever the paid route is doing.
    expect((await request(app).get("/healthz")).status).toBe(200);
    expect((await request(app).get("/.well-known/x402")).status).toBe(200);
  });
});
