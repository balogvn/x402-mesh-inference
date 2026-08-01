import { describe, expect, it } from "vitest";
import {
  AuthError,
  ConfigError,
  MeshError,
  NoCapacityError,
  PaymentError,
  PricingError,
  RateLimitError,
  SettlementError,
  UpstreamError,
  ValidationError,
  toErrorResponse,
} from "../src/index.js";

describe("MeshError subclasses", () => {
  it("carry the contracted code and status", () => {
    const cases: [MeshError, string, number][] = [
      [new ConfigError("x"), "config_error", 500],
      [new PricingError("x"), "pricing_error", 500],
      [new ValidationError("x"), "validation_error", 400],
      [new PaymentError("x"), "payment_error", 402],
      [new SettlementError("x"), "settlement_error", 502],
      [new NoCapacityError("x"), "no_capacity", 503],
      [new UpstreamError("x"), "upstream_error", 502],
      [new AuthError("x"), "auth_error", 401],
      [new RateLimitError("x"), "rate_limited", 429],
    ];
    for (const [err, code, status] of cases) {
      expect(err).toBeInstanceOf(MeshError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(status);
      expect(err.name).toBe(err.constructor.name);
    }
  });

  it("serializes to the contracted envelope", () => {
    const err = new ValidationError("bad thing", { field: "model" });
    expect(err.toJSON()).toEqual({
      error: { code: "validation_error", message: "bad thing", details: { field: "model" } },
    });
  });

  it("omits details when there are none", () => {
    expect(new AuthError("nope").toJSON()).toEqual({
      error: { code: "auth_error", message: "nope" },
    });
  });

  it("redacts secret-looking detail keys", () => {
    const err = new ConfigError("bad env", {
      AVM_PRIVATE_KEY: "c2VjcmV0",
      apiToken: "abc123",
      password: "hunter2",
      safe: "visible",
    });
    const body = err.toJSON();
    const details = body.error.details as Record<string, unknown>;
    expect(details["AVM_PRIVATE_KEY"]).toBe("[redacted]");
    expect(details["apiToken"]).toBe("[redacted]");
    expect(details["password"]).toBe("[redacted]");
    expect(details["safe"]).toBe("visible");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("never serializes a nested Error's stack", () => {
    const cause = new Error("boom at /Users/secret/path/file.ts:1:1");
    const err = new UpstreamError("upstream failed", { cause });
    expect(JSON.stringify(err.toJSON())).not.toContain("/Users/secret/path");
  });
});

describe("toErrorResponse", () => {
  it("passes MeshError through with its status", () => {
    const { status, body } = toErrorResponse(new NoCapacityError("no nodes", { model: "llama3" }));
    expect(status).toBe(503);
    expect(body).toEqual({
      error: { code: "no_capacity", message: "no nodes", details: { model: "llama3" } },
    });
  });

  it("collapses unknown throwables to an opaque 500 with no stack trace", () => {
    const leaky = new Error("ENOENT: /Users/kayode/.algorand/keyfile — secret sk=deadbeef");
    const { status, body } = toErrorResponse(leaky);
    const serialized = JSON.stringify(body);
    expect(status).toBe(500);
    expect(serialized).not.toContain("deadbeef");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("at ");
    expect(serialized).not.toContain(leaky.stack ?? "###");
    expect(body).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
  });

  it("handles non-Error throwables", () => {
    for (const thrown of ["a string", 42, null, undefined, { secret: "x" }]) {
      const { status, body } = toErrorResponse(thrown);
      expect(status).toBe(500);
      expect(body).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    }
  });

  it("returns a fresh body each call, so a caller cannot mutate the shared constant", () => {
    const first = toErrorResponse(new Error("a")).body as { error: { message: string } };
    first.error.message = "mutated";
    const second = toErrorResponse(new Error("b")).body as { error: { message: string } };
    expect(second.error.message).toBe("Internal server error");
  });
});
