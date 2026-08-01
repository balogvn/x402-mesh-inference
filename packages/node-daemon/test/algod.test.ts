import { describe, expect, it } from "vitest";
import { ALGORAND_MAINNET, ALGORAND_TESTNET, UpstreamError, usdcAssetId } from "@x402-mesh/shared";
import { AlgodReader, defaultAlgodUrl } from "../src/algod.js";
import { stubFetch } from "./helpers.js";

/**
 * Read-only algod access.
 *
 * `doctor` uses this to answer two questions that decide whether an operator gets paid: is
 * the account funded, and has it opted in to USDC. Balances are microALGO integers, so they
 * are read as `bigint` — a float would quietly round a large balance.
 */

const ADDRESS = "A".repeat(58);

describe("defaultAlgodUrl", () => {
  it("picks the public endpoint matching the network", () => {
    expect(defaultAlgodUrl(ALGORAND_MAINNET)).toBe("https://mainnet-api.algonode.cloud");
    expect(defaultAlgodUrl(ALGORAND_TESTNET)).toBe("https://testnet-api.algonode.cloud");
  });
});

describe("AlgodReader.accountSummary", () => {
  it("requests the account with the large arrays excluded", async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: { amount: 1_000_000, "min-balance": 100_000, "total-assets-opted-in": 1 },
    }));
    const reader = new AlgodReader(ALGORAND_TESTNET, {
      baseUrl: "http://algod.test/",
      fetchImpl: stub.fetch,
    });

    const summary = await reader.accountSummary(ADDRESS);

    expect(reader.baseUrl).toBe("http://algod.test");
    expect(stub.calls[0]!.url).toBe(`http://algod.test/v2/accounts/${ADDRESS}?exclude=all`);
    expect(stub.calls[0]!.method).toBe("GET");
    expect(summary).toEqual({
      microAlgos: 1_000_000n,
      minBalanceMicroAlgos: 100_000n,
      assetsOptedIn: 1,
      exists: true,
    });
  });

  it("reads balances as bigint whichever way algod encodes them", async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: {
        // Above 2^53: a float would lose the low digits of a whale account.
        amount: "9007199254740993000",
        "min-balance": 100_000,
        "total-assets-opted-in": 3,
      },
    }));
    const reader = new AlgodReader(ALGORAND_TESTNET, {
      baseUrl: "http://algod.test",
      fetchImpl: stub.fetch,
    });

    expect((await reader.accountSummary(ADDRESS)).microAlgos).toBe(9007199254740993000n);
  });

  it("treats missing or unusable numeric fields as zero", async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: { amount: -5, "min-balance": "not a number" },
    }));
    const reader = new AlgodReader(ALGORAND_TESTNET, {
      baseUrl: "http://algod.test",
      fetchImpl: stub.fetch,
    });

    expect(await reader.accountSummary(ADDRESS)).toEqual({
      microAlgos: 0n,
      minBalanceMicroAlgos: 0n,
      assetsOptedIn: 0,
      exists: true,
    });
  });

  it("reports an unfunded address as non-existent rather than as an error", async () => {
    const stub = stubFetch(() => ({ status: 404, body: { message: "no accounts found" } }));
    const reader = new AlgodReader(ALGORAND_TESTNET, {
      baseUrl: "http://algod.test",
      fetchImpl: stub.fetch,
    });

    expect(await reader.accountSummary(ADDRESS)).toEqual({
      microAlgos: 0n,
      minBalanceMicroAlgos: 0n,
      assetsOptedIn: 0,
      exists: false,
    });
  });

  it("raises UpstreamError on any other failure status", async () => {
    const stub = stubFetch(() => ({ status: 500, text: "algod is unhappy" }));
    const reader = new AlgodReader(ALGORAND_TESTNET, {
      baseUrl: "http://algod.test",
      fetchImpl: stub.fetch,
    });

    const failure = await reader.accountSummary(ADDRESS).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(UpstreamError);
    expect((failure as UpstreamError).details).toMatchObject({ status: 500, upstream: "algod" });
  });

  it("raises UpstreamError when algod is unreachable", async () => {
    const stub = stubFetch(() => {
      throw new Error("EAI_AGAIN");
    });
    const reader = new AlgodReader(ALGORAND_TESTNET, {
      baseUrl: "http://algod.test",
      fetchImpl: stub.fetch,
    });

    await expect(reader.accountSummary(ADDRESS)).rejects.toThrow(UpstreamError);
  });

  it("sends the API token only when one is configured", async () => {
    const withToken = stubFetch(() => ({ status: 200, body: {} }));
    await new AlgodReader(ALGORAND_TESTNET, {
      baseUrl: "http://algod.test",
      fetchImpl: withToken.fetch,
      token: "secret-node-token",
    }).accountSummary(ADDRESS);
    expect(withToken.calls[0]!.headers["x-algo-api-token"]).toBe("secret-node-token");

    const withoutToken = stubFetch(() => ({ status: 200, body: {} }));
    await new AlgodReader(ALGORAND_TESTNET, {
      baseUrl: "http://algod.test",
      fetchImpl: withoutToken.fetch,
    }).accountSummary(ADDRESS);
    expect(withoutToken.calls[0]!.headers).not.toHaveProperty("x-algo-api-token");
  });
});

describe("AlgodReader.isOptedIn", () => {
  it("reads the asset-holding route for the address", async () => {
    const stub = stubFetch(() => ({ status: 200, body: { "asset-holding": { amount: 0 } } }));
    const reader = new AlgodReader(ALGORAND_TESTNET, {
      baseUrl: "http://algod.test",
      fetchImpl: stub.fetch,
    });

    expect(await reader.isOptedIn(ADDRESS, "10458941")).toBe(true);
    expect(stub.calls[0]!.url).toBe(`http://algod.test/v2/accounts/${ADDRESS}/assets/10458941`);
  });

  it("treats 404 as a definite no, not an error", async () => {
    const stub = stubFetch(() => ({ status: 404, body: { message: "asset not found" } }));
    const reader = new AlgodReader(ALGORAND_TESTNET, {
      baseUrl: "http://algod.test",
      fetchImpl: stub.fetch,
    });

    // Algorand is opt-in: an operator who skips this silently fails every payout.
    expect(await reader.isOptedIn(ADDRESS, "10458941")).toBe(false);
  });

  it("raises UpstreamError on any other failure status", async () => {
    const stub = stubFetch(() => ({ status: 503, text: "catching up" }));
    const reader = new AlgodReader(ALGORAND_TESTNET, {
      baseUrl: "http://algod.test",
      fetchImpl: stub.fetch,
    });

    // Answering "not opted in" for a transient algod fault would be a false diagnosis.
    await expect(reader.isOptedIn(ADDRESS, "10458941")).rejects.toThrow(UpstreamError);
  });

  it("resolves the USDC asset id from the network", async () => {
    for (const network of [ALGORAND_MAINNET, ALGORAND_TESTNET]) {
      const stub = stubFetch(() => ({ status: 200, body: {} }));
      const reader = new AlgodReader(network, {
        baseUrl: "http://algod.test",
        fetchImpl: stub.fetch,
      });

      await reader.isOptedInToUsdc(ADDRESS, network);
      expect(stub.calls[0]!.url).toContain(`/assets/${usdcAssetId(network)}`);
    }
  });
});
