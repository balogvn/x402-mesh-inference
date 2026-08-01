import * as avm from "@x402/avm";
import { describe, expect, it } from "vitest";

import { ALGORAND_MAINNET, ALGORAND_TESTNET, facilitatorNetwork } from "@x402-mesh/shared";

import { buildPaymentOption, buildRoutesConfig } from "../src/x402/routes.js";
import { makeConfig } from "./helpers.js";

/**
 * Regression tests for the CAIP-2 truncation trap.
 *
 * Algorand CAIP-2 truncates the genesis hash to 32 characters and `@x402/avm` exports the
 * constants in that form, but the GoPlausible facilitator's `/supported` response advertises
 * the full padded hash. `x402HTTPResourceServer.initialize` compares the two verbatim, so
 * declaring the canonical form made the gateway refuse to start in production:
 *
 *   RouteConfigurationError: Facilitator does not support scheme "exact" on network
 *   "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe"  (reason: missing_facilitator)
 *
 * Every unit test stubbed the facilitator, so only a real boot caught it. These tests pin the
 * wire format so it cannot silently regress.
 */
describe("facilitator network identifiers", () => {
  it("maps canonical ids to the full padded genesis hash", () => {
    expect(facilitatorNetwork(ALGORAND_MAINNET)).toBe(
      `algorand:${avm.ALGORAND_MAINNET_GENESIS_HASH}`,
    );
    expect(facilitatorNetwork(ALGORAND_TESTNET)).toBe(
      `algorand:${avm.ALGORAND_TESTNET_GENESIS_HASH}`,
    );
  });

  it("produces ids that differ from the canonical form and end in base64 padding", () => {
    // If these ever became equal, the mapping would be a silent no-op and the boot failure
    // would return without any test noticing.
    expect(facilitatorNetwork(ALGORAND_MAINNET)).not.toBe(ALGORAND_MAINNET);
    expect(facilitatorNetwork(ALGORAND_TESTNET)).not.toBe(ALGORAND_TESTNET);
    expect(facilitatorNetwork(ALGORAND_MAINNET).endsWith("=")).toBe(true);
  });

  it("is a strict extension of the canonical id, not a different hash", () => {
    // The canonical id is the first 32 chars of the same genesis hash, so the facilitator
    // form must start with it. Catches a transposed or wrong-network constant.
    for (const net of [ALGORAND_MAINNET, ALGORAND_TESTNET]) {
      expect(facilitatorNetwork(net).startsWith(net)).toBe(true);
    }
  });

  it("round-trips back to canonical through the SDK normalizer", () => {
    for (const net of [ALGORAND_MAINNET, ALGORAND_TESTNET]) {
      expect(avm.normalizeAlgorandNetwork(facilitatorNetwork(net))).toBe(net);
    }
  });

  it("rejects a network it has no mapping for", () => {
    expect(() => facilitatorNetwork("eip155:8453" as never)).toThrow(/no facilitator network/);
  });

  it("declares the facilitator form on the paid route, not the canonical one", () => {
    for (const meshNetwork of ["mainnet", "testnet"] as const) {
      const config = makeConfig({
        meshNetwork,
        network: meshNetwork === "mainnet" ? ALGORAND_MAINNET : ALGORAND_TESTNET,
      });
      const option = buildPaymentOption(config);
      expect(option.network).toBe(facilitatorNetwork(config.network));
      expect(option.network).not.toBe(config.network);
    }
  });

  it("keeps the unpaid preview's network consistent with the payment requirement", async () => {
    const config = makeConfig();
    const routes = buildRoutesConfig(config) as unknown as Record<string, Record<string, unknown>>;
    const route = routes["POST /v1/chat/completions"];
    expect(route).toBeDefined();

    const unpaid = route?.["unpaidResponseBody"] as
      | ((ctx: unknown) => { body: { network?: string } } | Promise<{ body: { network?: string } }>)
      | undefined;
    expect(unpaid).toBeTypeOf("function");

    const preview = await unpaid?.({});
    // An agent builds its payment from this preview; a mismatch here hands it a network id
    // the facilitator will reject.
    expect(preview?.body.network).toBe(buildPaymentOption(config).network);
  });

  it("still resolves the USDC asset from the canonical id", async () => {
    // The mapping must not leak into asset lookup: USDC_CONFIG is keyed by canonical CAIP-2,
    // so a facilitator-form key would throw or silently pick the wrong ASA.
    const { usdcAssetId } = await import("@x402-mesh/shared");
    expect(usdcAssetId(ALGORAND_MAINNET)).toBe("31566704");
    expect(usdcAssetId(ALGORAND_TESTNET)).toBe("10458941");
  });
});
