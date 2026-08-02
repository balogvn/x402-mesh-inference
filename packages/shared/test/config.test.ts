import { describe, expect, it } from "vitest";
import {
  ALGORAND_MAINNET,
  ALGORAND_TESTNET,
  CHALLENGE_TAG,
  ConfigError,
  DEFAULT_INBOUND_USDC,
  DEFAULT_MARGIN_BPS,
  loadDaemonConfig,
  loadGatewayConfig,
} from "../src/index.js";

const ADDRESS = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
const MAINNET_FULL = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const PRIVATE_KEY = Buffer.alloc(64, 9).toString("base64");

const gatewayEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  X402_PAY_TO_ADDRESS: ADDRESS,
  ...extra,
});

const daemonEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MESH_GATEWAY_URL: "https://gateway.example.com",
  MESH_NODE_ID: "node-alpha",
  MESH_NODE_ENDPOINT: "http://127.0.0.1:9090",
  MESH_MODELS: "llama3.1:8b, qwen2.5:7b",
  AVM_PRIVATE_KEY: PRIVATE_KEY,
  ...extra,
});

describe("loadGatewayConfig", () => {
  it("applies the documented defaults", () => {
    const config = loadGatewayConfig(gatewayEnv());
    expect(config).toMatchObject({
      port: 8402,
      host: "0.0.0.0",
      network: ALGORAND_TESTNET,
      meshNetwork: "testnet",
      facilitatorUrl: "https://facilitator.goplausible.xyz",
      payToAddress: ADDRESS,
      inboundPriceUsdc: DEFAULT_INBOUND_USDC,
      marginBps: DEFAULT_MARGIN_BPS,
      publicBaseUrl: "http://localhost:8402",
      requireUsdcOptIn: true,
      nodeRequestTimeoutMs: 120_000,
      maxConcurrentPerNode: 8,
      logLevel: "info",
      otelEnabled: false,
      challengeTag: CHALLENGE_TAG,
    });
    expect(config.redisUrl).toBeUndefined();
    expect(config.otelExporterUrl).toBeUndefined();
  });

  it("exposes the mandatory challenge tag", () => {
    expect(CHALLENGE_TAG).toBe("x402-global-challenge");
  });

  it("requires a pay-to address and names the variable", () => {
    try {
      loadGatewayConfig({});
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain("X402_PAY_TO_ADDRESS");
    }
  });

  it("rejects a malformed pay-to address", () => {
    expect(() => loadGatewayConfig({ X402_PAY_TO_ADDRESS: "nope" })).toThrow(ConfigError);
  });

  it("honours MESH_NETWORK", () => {
    const config = loadGatewayConfig(gatewayEnv({ MESH_NETWORK: "mainnet" }));
    expect(config.network).toBe(ALGORAND_MAINNET);
    expect(config.meshNetwork).toBe("mainnet");
  });

  it("accepts an X402_NETWORK override in full genesis-hash form and normalizes it", () => {
    const config = loadGatewayConfig(gatewayEnv({ X402_NETWORK: MAINNET_FULL }));
    expect(config.network).toBe(ALGORAND_MAINNET);
    expect(config.meshNetwork).toBe("mainnet");
  });

  it("fails when MESH_NETWORK and X402_NETWORK disagree", () => {
    expect(() =>
      loadGatewayConfig(gatewayEnv({ MESH_NETWORK: "testnet", X402_NETWORK: MAINNET_FULL })),
    ).toThrow(ConfigError);
  });

  it("rejects an unsupported X402_NETWORK", () => {
    expect(() => loadGatewayConfig(gatewayEnv({ X402_NETWORK: "eip155:1" }))).toThrow(ConfigError);
  });

  it("validates numeric variables strictly", () => {
    expect(() => loadGatewayConfig(gatewayEnv({ PORT: "not-a-port" }))).toThrow(ConfigError);
    expect(() => loadGatewayConfig(gatewayEnv({ PORT: "0" }))).toThrow(ConfigError);
    expect(() => loadGatewayConfig(gatewayEnv({ PORT: "8402.5" }))).toThrow(ConfigError);
    expect(() => loadGatewayConfig(gatewayEnv({ MESH_MARGIN_BPS: "10001" }))).toThrow(ConfigError);
    expect(loadGatewayConfig(gatewayEnv({ PORT: "3000" })).port).toBe(3000);
  });

  it("rejects an inbound price with more than six decimal places", () => {
    expect(() => loadGatewayConfig(gatewayEnv({ MESH_INBOUND_PRICE_USDC: "0.0000001" }))).toThrow(
      ConfigError,
    );
  });

  it("parses booleans in the usual spellings and rejects nonsense", () => {
    for (const truthy of ["1", "true", "TRUE", "yes", "on"]) {
      expect(loadGatewayConfig(gatewayEnv({ OTEL_ENABLED: truthy })).otelEnabled).toBe(true);
    }
    for (const falsy of ["0", "false", "no", "off"]) {
      expect(
        loadGatewayConfig(gatewayEnv({ MESH_REQUIRE_USDC_OPT_IN: falsy })).requireUsdcOptIn,
      ).toBe(false);
    }
    expect(() => loadGatewayConfig(gatewayEnv({ OTEL_ENABLED: "maybe" }))).toThrow(ConfigError);
  });

  it("treats blank variables as absent", () => {
    const config = loadGatewayConfig(gatewayEnv({ PORT: "   ", REDIS_URL: "" }));
    expect(config.port).toBe(8402);
    expect(config.redisUrl).toBeUndefined();
  });

  it("strips trailing slashes from URLs", () => {
    const config = loadGatewayConfig(
      gatewayEnv({
        X402_FACILITATOR_URL: "https://facilitator.example.com/",
        MESH_PUBLIC_BASE_URL: "https://mesh.example.com//",
      }),
    );
    expect(config.facilitatorUrl).toBe("https://facilitator.example.com");
    expect(config.publicBaseUrl).toBe("https://mesh.example.com");
  });

  it("carries optional values through when set", () => {
    const config = loadGatewayConfig(
      gatewayEnv({
        REDIS_URL: "redis://localhost:6379",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        LOG_LEVEL: "debug",
      }),
    );
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.otelExporterUrl).toBe("http://localhost:4318");
    expect(config.logLevel).toBe("debug");
  });

  it("rejects an unknown log level", () => {
    expect(() => loadGatewayConfig(gatewayEnv({ LOG_LEVEL: "chatty" }))).toThrow(ConfigError);
  });
});

describe("loadDaemonConfig", () => {
  it("applies the documented defaults", () => {
    const config = loadDaemonConfig(daemonEnv());
    expect(config).toEqual({
      gatewayUrl: "https://gateway.example.com",
      nodeId: "node-alpha",
      endpoint: "http://127.0.0.1:9090",
      provider: "ollama",
      providerBaseUrl: "http://127.0.0.1:11434",
      models: ["llama3.1:8b", "qwen2.5:7b"],
      network: ALGORAND_TESTNET,
      heartbeatIntervalMs: 15_000,
      maxConcurrency: 8,
      privateKeyB64: PRIVATE_KEY,
    });
  });

  it("picks the provider-specific base URL default", () => {
    expect(loadDaemonConfig(daemonEnv({ MESH_PROVIDER: "vllm" })).providerBaseUrl).toBe(
      "http://127.0.0.1:8000",
    );
    expect(loadDaemonConfig(daemonEnv({ MESH_PROVIDER: "openai" })).providerBaseUrl).toBe(
      "https://api.openai.com",
    );
    expect(() => loadDaemonConfig(daemonEnv({ MESH_PROVIDER: "bedrock" }))).toThrow(ConfigError);
  });

  it("requires at least one model", () => {
    expect(() => loadDaemonConfig(daemonEnv({ MESH_MODELS: "" }))).toThrow(ConfigError);
    expect(() => loadDaemonConfig(daemonEnv({ MESH_MODELS: " , , " }))).toThrow(ConfigError);
  });

  it("validates the private key by decoded length without echoing it", () => {
    try {
      loadDaemonConfig(daemonEnv({ AVM_PRIVATE_KEY: Buffer.alloc(32).toString("base64") }));
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as ConfigError;
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain("AVM_PRIVATE_KEY");
      const serialized = JSON.stringify(err.toJSON());
      expect(serialized).not.toContain(Buffer.alloc(32).toString("base64"));
    }
  });

  it("never places the private key value in a serialized error", () => {
    try {
      loadDaemonConfig(daemonEnv({ AVM_PRIVATE_KEY: PRIVATE_KEY, MESH_NODE_ID: "!!bad" }));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(JSON.stringify((e as ConfigError).toJSON())).not.toContain(PRIVATE_KEY);
    }
  });

  it("names every missing required variable", () => {
    try {
      loadDaemonConfig({});
      expect.unreachable("should have thrown");
    } catch (e) {
      const message = (e as ConfigError).message;
      for (const name of [
        "AVM_PRIVATE_KEY",
        "MESH_GATEWAY_URL",
        "MESH_MODELS",
        "MESH_NODE_ENDPOINT",
        "MESH_NODE_ID",
      ]) {
        expect(message, name).toContain(name);
      }
    }
  });

  it("resolves the network the same way the gateway does", () => {
    expect(loadDaemonConfig(daemonEnv({ MESH_NETWORK: "mainnet" })).network).toBe(ALGORAND_MAINNET);
    expect(loadDaemonConfig(daemonEnv({ X402_NETWORK: MAINNET_FULL })).network).toBe(
      ALGORAND_MAINNET,
    );
  });
});

/**
 * Regression: the daemon's listen port must be overridable independently of its public URL.
 *
 * The port used to be derived solely from `MESH_NODE_ENDPOINT`, so an `https://…` endpoint
 * implied 443. Behind a TLS terminator — Fly, Render, Railway, anything fronted by nginx —
 * the public URL is :443 while the container must bind an unprivileged port, and a non-root
 * container died on boot with `EACCES: permission denied 0.0.0.0:443`. Only a real deploy
 * caught it.
 */
describe("loadDaemonConfig listen port", () => {
  const base = {
    MESH_GATEWAY_URL: "https://gateway.test",
    MESH_NODE_ID: "node-1",
    MESH_NODE_ENDPOINT: "https://node.test",
    MESH_PROVIDER: "openai",
    MESH_PROVIDER_BASE_URL: "https://api.groq.com/openai",
    MESH_MODELS: "llama-3.3-70b-versatile",
    MESH_NETWORK: "testnet",
    AVM_PRIVATE_KEY: Buffer.alloc(64, 7).toString("base64"),
  } as NodeJS.ProcessEnv;

  it("is undefined by default, leaving the endpoint to imply it", () => {
    expect(loadDaemonConfig(base).listenPort).toBeUndefined();
  });

  it("honours MESH_NODE_PORT when the public URL's port is unbindable", () => {
    expect(loadDaemonConfig({ ...base, MESH_NODE_PORT: "8500" }).listenPort).toBe(8500);
  });

  it("rejects a port outside the valid TCP range", () => {
    expect(() => loadDaemonConfig({ ...base, MESH_NODE_PORT: "0" })).toThrow();
    expect(() => loadDaemonConfig({ ...base, MESH_NODE_PORT: "70000" })).toThrow();
  });

  it("rejects a non-numeric port rather than silently binding a default", () => {
    expect(() => loadDaemonConfig({ ...base, MESH_NODE_PORT: "http" })).toThrow();
  });
});
