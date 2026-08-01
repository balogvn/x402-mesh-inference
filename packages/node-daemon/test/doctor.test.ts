import { describe, expect, it } from "vitest";
import { ALGORAND_TESTNET, usdcAssetId } from "@x402-mesh/shared";
import { formatReport, runDoctor } from "../src/doctor.js";
import type { CheckResult, DoctorOptions, DoctorReport } from "../src/doctor.js";
import { portFromEndpoint } from "../src/commands/start.js";
import { DEFAULT_NODE_PORT } from "../src/server.js";
import { daemonEnv, generateSecretKeyB64, makeResponse, stubFetch } from "./helpers.js";
import type { StubResponse } from "./helpers.js";

/**
 * Pre-flight diagnostics.
 *
 * `doctor` exists to surface the failures that are otherwise invisible until the first paid
 * request. Two properties matter: every check is independent (one failure must not mask
 * another), and the command reports rather than throws.
 */

const ALGOD_BASE = "http://algod.test";

/** A canned answer, or a thunk that throws to simulate a transport failure. */
type BackendAnswer = StubResponse | (() => Response);

interface Backends {
  models?: BackendAnswer;
  gateway?: BackendAnswer;
  account?: BackendAnswer;
  optIn?: BackendAnswer;
}

/** Routes each of doctor's outbound calls to its own canned answer. */
function backends(routes: Backends) {
  const answer = (spec: BackendAnswer | undefined): Response =>
    typeof spec === "function" ? spec() : makeResponse(spec ?? { status: 200, body: {} });

  return stubFetch((call) => {
    if (call.url.includes("/api/tags") || call.url.includes("/v1/models")) {
      return answer(routes.models);
    }
    if (call.url.includes("gateway.test")) return answer(routes.gateway);
    if (call.url.includes("/assets/")) return answer(routes.optIn);
    if (call.url.includes("/v2/accounts/")) return answer(routes.account);
    throw new Error(`unexpected doctor call to ${call.url}`);
  });
}

/** A healthy mesh: every backend answers the way it should. */
function healthyBackends(overrides: Backends = {}) {
  return backends({
    models: { status: 200, body: { models: [{ name: "llama3.1:8b" }] } },
    gateway: { status: 200, body: { status: "ok" } },
    account: {
      status: 200,
      body: { amount: 1_500_000, "min-balance": 200_000, "total-assets-opted-in": 1 },
    },
    optIn: { status: 200, body: { "asset-holding": { amount: 0 } } },
    ...overrides,
  });
}

function run(
  options: Partial<DoctorOptions> & { env?: NodeJS.ProcessEnv } = {},
): Promise<DoctorReport> {
  return runDoctor({
    env: daemonEnv(),
    algod: { baseUrl: ALGOD_BASE },
    ...options,
  });
}

function check(report: DoctorReport, name: string): CheckResult {
  const found = report.checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name}: ${report.checks.map((c) => c.name).join()}`);
  return found;
}

describe("runDoctor on a healthy node", () => {
  it("passes every check", async () => {
    const report = await run({ fetchImpl: healthyBackends().fetch });

    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      "configuration",
      "operator key",
      "provider reachable",
      "models present",
      "gateway reachable",
      "account funded",
      "USDC opt-in",
    ]);
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("reports the derived address but never the key", async () => {
    const env = daemonEnv();
    const report = await run({ env, fetchImpl: healthyBackends().fetch });
    const rendered = formatReport(report);

    expect(check(report, "operator key").detail).toMatch(/address [A-Z2-7]{58}/);
    expect(rendered).not.toContain(env["AVM_PRIVATE_KEY"]);
  });

  it("checks opt-in against the USDC asset for the configured network", async () => {
    const stub = healthyBackends();
    await run({ fetchImpl: stub.fetch });

    const assetCall = stub.calls.find((c) => c.url.includes("/assets/"));
    expect(assetCall?.url).toContain(usdcAssetId(ALGORAND_TESTNET));
  });
});

describe("runDoctor configuration failures", () => {
  it("reports a bad environment instead of throwing, and stops there", async () => {
    const env = daemonEnv();
    delete env["MESH_GATEWAY_URL"];

    const report = await runDoctor({ env, fetchImpl: healthyBackends().fetch });

    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(check(report, "configuration").status).toBe("fail");
    expect(check(report, "configuration").detail).toContain("MESH_GATEWAY_URL");
  });

  it("flags a key whose halves disagree and skips the chain checks", async () => {
    // 64 bytes, so `loadDaemonConfig` accepts it; only `loadOperatorKey` can catch the splice.
    const a = Buffer.from(generateSecretKeyB64(), "base64");
    const b = Buffer.from(generateSecretKeyB64(), "base64");
    const spliced = Buffer.concat([a.subarray(0, 32), b.subarray(32)]).toString("base64");

    const report = await run({
      env: daemonEnv({ AVM_PRIVATE_KEY: spliced }),
      fetchImpl: healthyBackends().fetch,
    });

    expect(report.ok).toBe(false);
    expect(check(report, "operator key").status).toBe("fail");
    // Without a key there is no address to look up, but the provider check still ran.
    expect(check(report, "provider reachable").status).toBe("pass");
    expect(check(report, "account funded").status).toBe("skip");
    expect(check(report, "USDC opt-in").status).toBe("skip");
  });
});

describe("runDoctor offline mode", () => {
  it("verifies configuration and the key without touching the network", async () => {
    const stub = healthyBackends();
    const report = await run({ offline: true, fetchImpl: stub.fetch });

    expect(stub.calls).toHaveLength(0);
    expect(report.ok).toBe(true);
    expect(report.checks.filter((c) => c.status === "skip")).toHaveLength(5);
  });
});

describe("runDoctor backend checks", () => {
  it("fails the provider check and skips the model check when the backend is down", async () => {
    const report = await run({
      fetchImpl: healthyBackends({
        models: () => {
          throw new Error("ECONNREFUSED 127.0.0.1:11434");
        },
      }).fetch,
    });

    expect(report.ok).toBe(false);
    expect(check(report, "provider reachable").status).toBe("fail");
    expect(check(report, "provider reachable").detail).toContain("ECONNREFUSED");
    // A model check against an unknown model list would be a guess, not a diagnosis.
    expect(check(report, "models present").status).toBe("skip");
  });

  it("names the models the operator advertised but never pulled", async () => {
    const report = await run({
      env: daemonEnv({ MESH_MODELS: "llama3.1:8b,mistral:7b" }),
      fetchImpl: healthyBackends().fetch,
    });

    const models = check(report, "models present");
    expect(models.status).toBe("fail");
    expect(models.detail).toContain("mistral:7b");
    expect(models.detail).not.toContain("llama3.1:8b");
  });
});

describe("runDoctor gateway check", () => {
  it("treats any HTTP answer as proof the gateway is up", async () => {
    const report = await run({ fetchImpl: healthyBackends({ gateway: { status: 404 } }).fetch });

    // The daemon does not own the gateway's routes; a 404 still proves the URL resolves.
    expect(check(report, "gateway reachable").status).toBe("warn");
    expect(check(report, "gateway reachable").detail).toContain("HTTP 404");
    expect(report.ok).toBe(true);
  });

  it("fails only on a transport error", async () => {
    const report = await run({
      fetchImpl: healthyBackends({
        gateway: () => {
          throw new Error("EAI_AGAIN gateway.test");
        },
      }).fetch,
    });

    expect(check(report, "gateway reachable").status).toBe("fail");
    expect(report.ok).toBe(false);
  });
});

describe("runDoctor funding check", () => {
  it("tells an operator to fund an address that does not exist yet", async () => {
    const report = await run({ fetchImpl: healthyBackends({ account: { status: 404 } }).fetch });

    const funded = check(report, "account funded");
    expect(funded.status).toBe("fail");
    expect(funded.detail).toContain("does not exist on chain");
  });

  it("requires headroom for one more ASA opt-in", async () => {
    const short = await run({
      fetchImpl: healthyBackends({
        // 0.25 ALGO held, 0.2 min balance + 0.1 for the next opt-in = 0.3 required.
        account: { status: 200, body: { amount: 250_000, "min-balance": 200_000 } },
      }).fetch,
    });
    expect(check(short, "account funded").status).toBe("fail");
    expect(check(short, "account funded").detail).toContain("0.3 ALGO needed");

    const exact = await run({
      fetchImpl: healthyBackends({
        account: { status: 200, body: { amount: 300_000, "min-balance": 200_000 } },
      }).fetch,
    });
    expect(check(exact, "account funded").status).toBe("pass");
  });

  it("renders microALGO with integer arithmetic, not floating point", async () => {
    const report = await run({
      fetchImpl: healthyBackends({
        account: { status: 200, body: { amount: 1_234_500, "min-balance": 100_000 } },
      }).fetch,
    });

    expect(check(report, "account funded").detail).toContain("1.2345 ALGO available");
    expect(check(report, "account funded").detail).toContain("min balance 0.1 ALGO");
  });

  it("reports an algod failure as a failed check rather than crashing", async () => {
    const report = await run({
      fetchImpl: healthyBackends({ account: { status: 500, text: "algod is unhappy" } }).fetch,
    });

    expect(check(report, "account funded").status).toBe("fail");
    // The opt-in check still runs: one chain failure must not hide another.
    expect(check(report, "USDC opt-in").status).toBe("pass");
  });
});

describe("runDoctor opt-in check", () => {
  it("explains that payouts fail until the operator opts in", async () => {
    const report = await run({ fetchImpl: healthyBackends({ optIn: { status: 404 } }).fetch });

    const optIn = check(report, "USDC opt-in");
    expect(optIn.status).toBe("fail");
    expect(optIn.detail).toContain("payouts will fail");
    expect(report.ok).toBe(false);
  });

  it("reports an algod failure as a failed check", async () => {
    const report = await run({
      fetchImpl: healthyBackends({ optIn: { status: 503, text: "catching up" } }).fetch,
    });
    expect(check(report, "USDC opt-in").status).toBe("fail");
  });
});

describe("formatReport", () => {
  it("aligns the checklist and ends with a pass summary", () => {
    const rendered = formatReport({
      ok: true,
      checks: [
        { name: "configuration", status: "pass", detail: "fine" },
        { name: "USDC opt-in", status: "warn", detail: "hmm" },
      ],
    });
    const lines = rendered.split("\n");

    expect(lines[0]).toBe("[PASS] configuration  fine");
    expect(lines[1]).toBe("[WARN] USDC opt-in    hmm");
    expect(lines.at(-1)).toContain("all checks passed");
  });

  it("counts the failures in the summary", () => {
    const rendered = formatReport({
      ok: false,
      checks: [
        { name: "a", status: "fail", detail: "x" },
        { name: "b", status: "fail", detail: "y" },
        { name: "c", status: "skip", detail: "z" },
      ],
    });
    expect(rendered).toContain("doctor: 2 check(s) failed");
  });
});

describe("portFromEndpoint", () => {
  it("binds the port the operator advertised", () => {
    expect(portFromEndpoint("http://127.0.0.1:8403")).toBe(8403);
    expect(portFromEndpoint("https://node.example.com:9443/infer")).toBe(9443);
  });

  it("falls back to the scheme's default port", () => {
    expect(portFromEndpoint("http://node.example.com")).toBe(80);
    expect(portFromEndpoint("https://node.example.com")).toBe(443);
  });

  it("falls back to the daemon default for an unparseable endpoint", () => {
    expect(portFromEndpoint("not a url")).toBe(DEFAULT_NODE_PORT);
    expect(portFromEndpoint("")).toBe(DEFAULT_NODE_PORT);
  });
});
