import { describe, expect, it } from "vitest";
import { UpstreamError } from "@x402-mesh/shared";
import {
  baseHeaders,
  errorSnippet,
  isAbort,
  joinUrl,
  scopedSignal,
  transportError,
  upstreamErrorFrom,
} from "../src/http.js";
import { DAEMON_USER_AGENT } from "../src/version.js";
import { abortError } from "./helpers.js";

/**
 * Shared HTTP plumbing.
 *
 * `scopedSignal` is the piece with teeth: a long-running daemon that leaks one timer per
 * request eventually cannot exit, and a signal that is not chained cannot cancel work the
 * caller has already walked away from.
 */

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe("joinUrl", () => {
  it("tolerates a trailing slash on either side", () => {
    expect(joinUrl("https://gw.test", "/v1/x")).toBe("https://gw.test/v1/x");
    expect(joinUrl("https://gw.test/", "/v1/x")).toBe("https://gw.test/v1/x");
    expect(joinUrl("https://gw.test/", "v1/x")).toBe("https://gw.test/v1/x");
    expect(joinUrl("https://gw.test", "v1/x")).toBe("https://gw.test/v1/x");
  });

  it("keeps a base path", () => {
    expect(joinUrl("https://gw.test/api", "/v1/x")).toBe("https://gw.test/api/v1/x");
  });
});

describe("baseHeaders", () => {
  it("always identifies the daemon and lets callers add headers", () => {
    expect(baseHeaders()).toEqual({ "user-agent": DAEMON_USER_AGENT });
    expect(baseHeaders({ accept: "application/json" })).toEqual({
      "user-agent": DAEMON_USER_AGENT,
      accept: "application/json",
    });
  });

  it("lets a caller override the user agent deliberately", () => {
    expect(baseHeaders({ "user-agent": "custom" })["user-agent"]).toBe("custom");
  });
});

describe("scopedSignal", () => {
  it("aborts once the deadline passes", async () => {
    const scope = scopedSignal(5);
    expect(scope.signal.aborted).toBe(false);

    await settled();
    expect(scope.signal.aborted).toBe(true);
    expect((scope.signal.reason as Error).message).toContain("timed out after 5ms");
    scope.dispose();
  });

  it("stops the deadline firing once disposed", async () => {
    const scope = scopedSignal(5);
    scope.dispose();

    // The timer surviving dispose is what makes a daemon accumulate one timer per request.
    await settled();
    expect(scope.signal.aborted).toBe(false);
  });

  it("propagates an outer abort that happens later", () => {
    const outer = new AbortController();
    const scope = scopedSignal(10_000, outer.signal);

    outer.abort(new Error("client hung up"));
    expect(scope.signal.aborted).toBe(true);
    expect((scope.signal.reason as Error).message).toBe("client hung up");
    scope.dispose();
  });

  it("is already aborted when the outer signal was", () => {
    const outer = new AbortController();
    outer.abort(new Error("too late"));
    const scope = scopedSignal(10_000, outer.signal);

    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
  });

  it("detaches from the outer signal on dispose", () => {
    const outer = new AbortController();
    const scope = scopedSignal(10_000, outer.signal);
    scope.dispose();

    outer.abort(new Error("after the call finished"));
    expect(scope.signal.aborted).toBe(false);
  });

  it("disables the deadline for a non-positive or non-finite timeout", async () => {
    const outer = new AbortController();
    const scoped = scopedSignal(0, outer.signal);
    expect(scoped.signal).toBe(outer.signal);

    const bare = scopedSignal(Number.NaN);
    await settled();
    expect(bare.signal.aborted).toBe(false);
    bare.dispose();
    scoped.dispose();
  });
});

describe("errorSnippet", () => {
  it("bounds the body it echoes", async () => {
    const snippet = await errorSnippet(new Response("x".repeat(5_000), { status: 500 }));
    expect(snippet).toHaveLength(400);
  });

  it("returns an empty string rather than masking the original failure", async () => {
    const res = new Response("already read", { status: 500 });
    await res.text();
    // A second read throws; the caller is mid-error-path and must not see a new one.
    expect(await errorSnippet(res)).toBe("");
  });
});

describe("upstreamErrorFrom", () => {
  it("carries the status, the upstream label and a body snippet", async () => {
    const error = await upstreamErrorFrom(
      "ollama",
      new Response("model not found", { status: 404 }),
      "chat completion",
    );

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toBe("ollama chat completion failed with HTTP 404");
    expect(error.details).toEqual({
      status: 404,
      upstream: "ollama",
      body: "model not found",
    });
  });

  it("omits the body key when the response had none", async () => {
    const error = await upstreamErrorFrom("ollama", new Response(null, { status: 500 }), "probe");
    expect(error.details).not.toHaveProperty("body");
  });
});

describe("transportError", () => {
  it("wraps a connection failure as UpstreamError", () => {
    const error = transportError("ollama", "chat completion", new Error("ECONNREFUSED"));
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toBe("ollama chat completion failed: ECONNREFUSED");
  });

  it("stringifies a non-Error cause", () => {
    expect(transportError("gateway", "heartbeat", "socket hang up").message).toContain(
      "socket hang up",
    );
  });

  it("lets a deliberate abort through unchanged", () => {
    const cause = abortError();
    // A caller-initiated abort is not the upstream misbehaving.
    expect(transportError("ollama", "chat completion", cause)).toBe(cause);
  });
});

describe("isAbort", () => {
  it("recognizes an AbortError however it is shaped", () => {
    expect(isAbort(abortError())).toBe(true);
    expect(isAbort({ name: "AbortError" })).toBe(true);
  });

  it("does not mistake anything else for an abort", () => {
    expect(isAbort(new Error("boom"))).toBe(false);
    expect(isAbort(new UpstreamError("boom"))).toBe(false);
    expect(isAbort("AbortError")).toBe(false);
    expect(isAbort(null)).toBe(false);
    expect(isAbort(undefined)).toBe(false);
  });
});
