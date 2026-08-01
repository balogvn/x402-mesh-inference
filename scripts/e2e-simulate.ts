/**
 * `npx tsx scripts/e2e-simulate.ts` — the end-to-end harness CI runs.
 *
 * It drives the whole product loop and asserts each leg:
 *
 *   402 challenge -> pay -> route to a node -> stream the completion -> split the USDC
 *
 * Two modes, chosen automatically:
 *
 * - **stub** (default, no secrets, no network): boots a stub gateway and a mock inference node
 *   in-process. The stub gateway is not a mock of the contract — it validates with the real
 *   `@x402-mesh/shared` schemas, verifies real Ed25519 registration signatures over the real
 *   canonical bytes, and computes the split with the real `computeSplit`. Only the chain is
 *   faked. This is what makes the pull-request pipeline meaningful on a fork with no secrets.
 *
 * - **live** (`MESH_E2E_BASE_URL` set): drives a real gateway over HTTP. The mock inference
 *   node still runs locally and registers itself, so the gateway has something to route to.
 *   With `AVM_PRIVATE_KEY` also set, payments are built by the real `@x402/avm` client scheme
 *   and settled by the real facilitator; without it, the paid legs are skipped rather than
 *   faked, and that is reported.
 *
 * Exit code 0 only when every assertion passes.
 */

import {
  ChatCompletionChunkSchema,
  ChatCompletionResponseSchema,
  SettlementRecordSchema,
  atomicToWire,
  computeSplit,
  formatUsd,
  normalizeNetwork,
  parseOrThrow,
  toCaip2,
  toMeshNetwork,
  usdcAssetId,
  usdcToAtomic,
  wireToAtomic,
  type MeshNetwork,
  type NodeCapability,
  type SettlementRecord,
} from "@x402-mesh/shared";
import * as avm from "@x402/avm";
import { ExactAvmScheme as ClientExactAvmScheme } from "@x402/avm/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { Network, PaymentRequired } from "@x402/core/types";
import {
  Checklist,
  errorMessage,
  heading,
  httpJson,
  info,
  parseArgs,
  style,
  wantsHelp,
} from "./lib/cli.js";
import { buildSignedRegistration, startMockNode, type MockNode } from "./lib/mock-node.js";
import { encodeStubPayment, startStubGateway, type StubGateway } from "./lib/stub-gateway.js";
import { generateKeypair, type AlgorandKeypair } from "./lib/ed25519.js";

/** Price the harness expects the gateway to charge, in decimal USDC. */
const EXPECTED_INBOUND_USDC = "0.0020";

/** Gateway margin the harness expects, in basis points. */
const EXPECTED_MARGIN_BPS = 1500;

/** Model the mock node advertises when nothing else is configured. */
const DEFAULT_MODEL = "llama3.1:8b";

/** Terminal SSE frame emitted by an OpenAI-compatible stream. */
const SSE_DONE = "[DONE]";

/** What the harness learned about the gateway it is driving. */
interface Target {
  /** Base URL of the gateway under test. */
  baseUrl: string;
  /** True when the gateway is the in-process stub. */
  stub: boolean;
  /** Cleanup for anything the harness started. */
  close(): Promise<void>;
}

function printUsage(): void {
  process.stdout.write(`
${style.bold("e2e-simulate")} — assert the 402 -> pay -> route -> stream -> split loop

  npx tsx scripts/e2e-simulate.ts [options]

Options:
  --base-url <url>   Drive this gateway instead of the in-process stub.
                     Also settable as MESH_E2E_BASE_URL.
  --model <name>     Model to request. Also settable as MESH_E2E_MODEL.
  --network <net>    mainnet | testnet. Default: testnet.
  --help             Show this message.

With no options and no secrets this runs entirely in-process: no chain, no network, no
funds. Set AVM_PRIVATE_KEY together with --base-url to pay through the real facilitator.

Exits 0 only when every assertion passes.
`);
}

/** Reads a header case-insensitively from a fetch Response. */
function headerReader(response: Response): (name: string) => string | null {
  return (name: string) => response.headers.get(name);
}

/** Decodes the base64 JSON `PAYMENT-RESPONSE` header the server returns after settling. */
function decodeSettleHeader(response: Response): Record<string, unknown> | undefined {
  const raw =
    response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  if (raw === null || raw.trim() === "") return undefined;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Splits an SSE body into its `data:` payloads, dropping comments and blank lines. */
function parseSseFrames(body: string): string[] {
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((frame) => frame.length > 0);
}

/** Asserts a condition, recording the outcome on the checklist. Returns the condition. */
function expect(checklist: Checklist, condition: boolean, name: string, detail?: string): boolean {
  if (condition) checklist.pass(name, detail);
  else checklist.fail(name, detail);
  return condition;
}

/** Brings up the gateway under test: the in-process stub, or a real one over HTTP. */
async function resolveTarget(
  baseUrlOption: string | undefined,
  network: Network,
  payTo: string,
): Promise<Target> {
  if (baseUrlOption !== undefined && baseUrlOption.trim() !== "") {
    const baseUrl = baseUrlOption.trim().replace(/\/+$/, "");
    return { baseUrl, stub: false, close: async () => {} };
  }
  const gateway: StubGateway = await startStubGateway({
    network,
    payTo,
    inboundPriceUsdc: EXPECTED_INBOUND_USDC,
    marginBps: EXPECTED_MARGIN_BPS,
    challengeTag: "x402-global-challenge",
  });
  return { baseUrl: gateway.url, stub: true, close: () => gateway.close() };
}

/** Waits for the gateway to answer `/healthz`, so a slow container start is not a failure. */
async function waitForGateway(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never attempted";
  while (Date.now() < deadline) {
    try {
      await httpJson<unknown>(`${baseUrl}/healthz`, { timeoutMs: 3_000 });
      return;
    } catch (e) {
      lastError = errorMessage(e);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`gateway at ${baseUrl} never became healthy: ${lastError}`);
}

/** Everything the harness needs in order to pay a challenge. */
interface Payer {
  /** Human label for the checklist. */
  kind: "stub" | "real";
  /**
   * Builds the `X-PAYMENT` header value for a challenge.
   *
   * @throws when the challenge cannot be paid, which the caller turns into a failed check.
   */
  buildHeader(challenge: PaymentRequired): Promise<string>;
}

/** A payer that produces the stub facilitator's transfer descriptor. */
function stubPayer(keypair: AlgorandKeypair): Payer {
  return {
    kind: "stub",
    buildHeader: async (challenge) => {
      const requirements = challenge.accepts[0];
      if (requirements === undefined) throw new Error("challenge carried no accepts[] entry");
      return encodeStubPayment({
        network: requirements.network,
        assetId: requirements.asset,
        amountAtomic: requirements.amount,
        payTo: requirements.payTo,
        payer: keypair.address,
        feePayer: String(requirements.extra?.["feePayer"] ?? keypair.address),
      });
    },
  };
}

/**
 * A payer that builds a genuine Algorand atomic transaction group through `@x402/avm`.
 *
 * Only reachable when `AVM_PRIVATE_KEY` is present. The key is passed straight to the SDK and
 * never logged, never echoed and never included in an error message.
 */
function realPayer(privateKeyB64: string, network: Network): Payer {
  const signer = avm.toClientAvmSigner(privateKeyB64);
  const client = new x402Client().register(network, new ClientExactAvmScheme(signer));
  const http = new x402HTTPClient(client);
  return {
    kind: "real",
    buildHeader: async (challenge) => {
      const payload = await http.createPaymentPayload(challenge);
      const headers = http.encodePaymentSignatureHeader(payload);
      const value = headers["X-PAYMENT"] ?? Object.values(headers)[0];
      if (value === undefined) throw new Error("client produced no X-PAYMENT header");
      return value;
    },
  };
}

/** Issues the unpaid request and validates the 402 challenge it comes back with. */
async function assertChallenge(
  checklist: Checklist,
  baseUrl: string,
  model: string,
  network: Network,
): Promise<PaymentRequired | undefined> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }] }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!expect(checklist, response.status === 402, "402 challenge", `status ${response.status}`)) {
    return undefined;
  }

  const challenge = (await response.json()) as PaymentRequired;
  expect(checklist, challenge.x402Version === 2, "challenge is x402 v2");

  const requirements = challenge.accepts?.[0];
  if (requirements === undefined) {
    checklist.fail("challenge accepts[]", "empty");
    return undefined;
  }

  expect(checklist, requirements.scheme === "exact", "scheme", requirements.scheme);

  const advertised = normalizeNetwork(requirements.network);
  expect(
    checklist,
    advertised === network,
    "challenge network",
    `${requirements.network} -> ${advertised}`,
  );

  const expectedAsset = usdcAssetId(network);
  expect(
    checklist,
    requirements.asset === expectedAsset,
    "challenge asset",
    `ASA ${requirements.asset} (expected ${expectedAsset})`,
  );

  const expectedAtomic = usdcToAtomic(EXPECTED_INBOUND_USDC);
  const advertisedAtomic = wireToAtomic(requirements.amount);
  expect(
    checklist,
    advertisedAtomic === expectedAtomic,
    "challenge amount",
    `${requirements.amount} atomic (${formatUsd(advertisedAtomic)})`,
  );

  expect(
    checklist,
    avm.isValidAlgorandAddress(requirements.payTo),
    "challenge payTo",
    requirements.payTo,
  );

  const tags = challenge.resource?.tags ?? [];
  expect(
    checklist,
    tags.includes("x402-global-challenge"),
    "challenge carries the discovery tag",
    tags.join(", "),
  );

  return challenge;
}

/** Pays a challenge and asserts the buffered completion and the settlement header. */
async function assertPaidCompletion(
  checklist: Checklist,
  baseUrl: string,
  model: string,
  challenge: PaymentRequired,
  payer: Payer,
): Promise<string | undefined> {
  let header: string;
  try {
    header = await payer.buildHeader(challenge);
  } catch (e) {
    checklist.fail("build X-PAYMENT", errorMessage(e));
    return undefined;
  }
  checklist.pass("build X-PAYMENT", `${payer.kind} payer, ${header.length} chars`);

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-PAYMENT": header },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Explain the x402 protocol in one sentence." }],
      max_tokens: 64,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status !== 200) {
    const body = (await response.text()).slice(0, 400);
    checklist.fail("paid completion", `status ${response.status}: ${body}`);
    return undefined;
  }

  const settle = decodeSettleHeader(response);
  const txId = typeof settle?.["transaction"] === "string" ? settle["transaction"] : undefined;
  expect(
    checklist,
    settle !== undefined && settle["success"] === true,
    "PAYMENT-RESPONSE header",
    txId === undefined ? "no transaction id" : `tx ${txId}`,
  );

  const completion = parseOrThrow(
    ChatCompletionResponseSchema,
    await response.json(),
    "chat completion response",
  );
  expect(
    checklist,
    completion.choices.length > 0 && (completion.choices[0]?.message.content.length ?? 0) > 0,
    "completion routed to a node",
    completion.choices[0]?.message.content.slice(0, 60),
  );
  expect(
    checklist,
    completion.usage.total_tokens > 0,
    "usage reported",
    `${completion.usage.total_tokens} tokens`,
  );

  const nodeId = headerReader(response)("X-Mesh-Node-Id");
  if (nodeId !== null) checklist.pass("routed node reported", nodeId);

  return response.headers.get("X-Mesh-Request-Id") ?? undefined;
}

/** Pays a fresh challenge and asserts the SSE variant streams valid chunks. */
async function assertPaidStream(
  checklist: Checklist,
  baseUrl: string,
  model: string,
  challenge: PaymentRequired,
  payer: Payer,
): Promise<void> {
  let header: string;
  try {
    header = await payer.buildHeader(challenge);
  } catch (e) {
    checklist.fail("build X-PAYMENT (stream)", errorMessage(e));
    return;
  }

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-PAYMENT": header },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Stream me one sentence." }],
      stream: true,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status !== 200) {
    const body = (await response.text()).slice(0, 400);
    checklist.fail("paid stream", `status ${response.status}: ${body}`);
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  expect(checklist, contentType.includes("text/event-stream"), "stream content-type", contentType);

  const frames = parseSseFrames(await response.text());
  expect(checklist, frames.length > 1, "stream produced frames", `${frames.length} data frames`);
  expect(
    checklist,
    frames[frames.length - 1] === SSE_DONE,
    "stream terminated with [DONE]",
    frames[frames.length - 1],
  );

  let assembled = "";
  let malformed = 0;
  for (const frame of frames.slice(0, -1)) {
    try {
      const chunk = parseOrThrow(ChatCompletionChunkSchema, JSON.parse(frame), "stream chunk");
      assembled += chunk.choices[0]?.delta.content ?? "";
    } catch {
      malformed += 1;
    }
  }
  expect(checklist, malformed === 0, "every frame is a valid chunk", `${malformed} malformed`);
  expect(
    checklist,
    assembled.trim().length > 0,
    "stream assembled a completion",
    assembled.slice(0, 60),
  );
}

/** Reads the settlement ledger and asserts the published economics hold exactly. */
async function assertSettlementSplit(
  checklist: Checklist,
  baseUrl: string,
  expectedNodeId: string,
): Promise<void> {
  let body: { settlements?: unknown[]; count?: number };
  try {
    body = await httpJson<{ settlements?: unknown[]; count?: number }>(`${baseUrl}/v1/settlements`);
  } catch (e) {
    checklist.fail("settlement ledger", errorMessage(e));
    return;
  }

  const raw = body.settlements ?? [];
  if (raw.length === 0) {
    checklist.fail("settlement ledger", "no settlement records were written");
    return;
  }

  let records: SettlementRecord[];
  try {
    records = raw.map((r) => parseOrThrow(SettlementRecordSchema, r, "settlement record"));
  } catch (e) {
    checklist.fail("settlement record schema", errorMessage(e));
    return;
  }
  checklist.pass("settlement ledger", `${records.length} record(s)`);

  const mine = records.filter((r) => r.nodeId === expectedNodeId);
  expect(
    checklist,
    mine.length > 0,
    "settlement attributed to the mock node",
    `${mine.length} of ${records.length}`,
  );

  const expected = computeSplit(usdcToAtomic(EXPECTED_INBOUND_USDC), EXPECTED_MARGIN_BPS);
  let violations = 0;
  let mismatches = 0;
  for (const record of mine) {
    const inbound = wireToAtomic(record.inboundAtomic);
    const payout = wireToAtomic(record.payoutAtomic);
    const margin = wireToAtomic(record.marginAtomic);
    if (inbound - payout !== margin || payout < 0n || margin < 0n) violations += 1;
    if (inbound !== expected.inbound || payout !== expected.payout || margin !== expected.margin) {
      mismatches += 1;
    }
  }

  expect(
    checklist,
    violations === 0,
    "invariant inbound - payout == margin",
    `${mine.length} record(s) checked`,
  );
  expect(
    checklist,
    mismatches === 0,
    "split matches the published economics",
    `${atomicToWire(expected.inbound)} = ${atomicToWire(expected.payout)} + ` +
      `${atomicToWire(expected.margin)} atomic USDC`,
  );

  const settledWithTx = mine.filter((r) => r.status === "settled" && r.payoutTxId !== null);
  expect(
    checklist,
    settledWithTx.length === mine.length,
    "operator payout leg settled",
    `${settledWithTx.length}/${mine.length}`,
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) {
    printUsage();
    return 0;
  }

  const networkArg = args.options.get("network") ?? process.env["MESH_NETWORK"] ?? "testnet";
  if (networkArg !== "mainnet" && networkArg !== "testnet") {
    process.stderr.write(`${style.red("error")}: --network must be "mainnet" or "testnet"\n`);
    return 2;
  }
  const meshNetwork: MeshNetwork = networkArg;
  const network = toCaip2(meshNetwork);
  const model = args.options.get("model") ?? process.env["MESH_E2E_MODEL"] ?? DEFAULT_MODEL;
  const baseUrlOption = args.options.get("base-url") ?? process.env["MESH_E2E_BASE_URL"];
  const privateKey = process.env["AVM_PRIVATE_KEY"]?.trim();

  // The gateway's payTo only needs to be a real address in live mode; in stub mode the harness
  // owns both ends, so it mints one rather than requiring configuration.
  const gatewayKeypair = generateKeypair();
  const operatorKeypair = generateKeypair();
  const clientKeypair = generateKeypair();

  const checklist = new Checklist("x402 mesh end-to-end simulation");
  let target: Target | undefined;
  let node: MockNode | undefined;

  try {
    target = await resolveTarget(baseUrlOption, network, gatewayKeypair.address);
    const mode = target.stub ? "stub (in-process, no chain)" : `live (${target.baseUrl})`;
    checklist.pass("mode", mode);

    node = await startMockNode({ models: [model] });
    checklist.pass("mock node", `${node.url} serving ${model}`);

    await waitForGateway(target.baseUrl);
    checklist.pass("gateway healthy", `${target.baseUrl}/healthz`);

    const nodeId = `e2e-mock-${Date.now().toString(36)}`;
    const capabilities: NodeCapability[] = [
      { model, contextWindow: 8192, pricePer1kTokensUsdc: "0.000180", quantization: "q4_K_M" },
    ];
    const registration = buildSignedRegistration({
      nodeId,
      keypair: operatorKeypair,
      endpoint: node.url,
      network,
      capabilities,
    });

    const registerResponse = await fetch(`${target.baseUrl}/v1/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registration),
      signal: AbortSignal.timeout(20_000),
    });
    const registered = registerResponse.status === 200 || registerResponse.status === 201;
    expect(
      checklist,
      registered,
      "mock node registered",
      registered
        ? `${nodeId} -> ${operatorKeypair.address}`
        : `status ${registerResponse.status}: ${(await registerResponse.text()).slice(0, 300)}`,
    );
    if (!registered) return checklist.summarize();

    const challenge = await assertChallenge(checklist, target.baseUrl, model, network);
    if (challenge === undefined) return checklist.summarize();

    let payer: Payer | undefined;
    if (target.stub) {
      payer = stubPayer(clientKeypair);
    } else if (privateKey !== undefined && privateKey.length > 0) {
      payer = realPayer(privateKey, network);
      checklist.pass("payer", "real AVM client scheme (AVM_PRIVATE_KEY is set)");
    } else {
      checklist.skip(
        "paid legs",
        "AVM_PRIVATE_KEY is not set — the challenge was validated, but no payment was made",
      );
    }

    if (payer !== undefined) {
      await assertPaidCompletion(checklist, target.baseUrl, model, challenge, payer);

      const streamChallenge = await assertChallenge(checklist, target.baseUrl, model, network);
      if (streamChallenge !== undefined) {
        await assertPaidStream(checklist, target.baseUrl, model, streamChallenge, payer);
      }

      await assertSettlementSplit(checklist, target.baseUrl, nodeId);

      expect(
        checklist,
        node.stats.completions >= 1,
        "node served the buffered request",
        `${node.stats.completions} completion(s)`,
      );
      expect(
        checklist,
        node.stats.streams >= 1,
        "node served the streamed request",
        `${node.stats.streams} stream(s)`,
      );
    }

    heading("Economics asserted");
    const split = computeSplit(usdcToAtomic(EXPECTED_INBOUND_USDC), EXPECTED_MARGIN_BPS);
    info(`network        ${toMeshNetwork(network)} (${network})`);
    info(`usdc asset     ASA ${usdcAssetId(network)}`);
    info(`client pays    ${atomicToWire(split.inbound)} atomic  ${formatUsd(split.inbound)}`);
    info(`operator gets  ${atomicToWire(split.payout)} atomic  ${formatUsd(split.payout)}`);
    info(`gateway keeps  ${atomicToWire(split.margin)} atomic  ${formatUsd(split.margin)}`);
    if (target.stub) {
      info("");
      info(
        style.yellow(
          "stub mode: no Algorand transaction was submitted. Run scripts/e2e-mainnet.ts " +
            "for a real settlement.",
        ),
      );
    }
  } catch (e) {
    checklist.fail("harness", errorMessage(e));
  } finally {
    await node?.close().catch(() => {});
    await target?.close().catch(() => {});
  }

  return checklist.summarize();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`\n${style.red("e2e-simulate crashed")}: ${errorMessage(e)}\n`);
    process.exitCode = 1;
  });
