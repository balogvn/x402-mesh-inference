/**
 * `npm run test:e2e-mainnet` — the one script in this repo that spends real money.
 *
 * It performs a single, real x402 payment on **Algorand MainNet** against a live deployment of
 * the gateway. Its purpose is diagnostic: a real MainNet settlement is what gets the service
 * indexed on the x402 leaderboard, and it is the only way to prove the whole path — challenge,
 * atomic transaction group, facilitator settlement, routing, operator payout — works against
 * the real chain rather than against a stub.
 *
 * Safety model, in order:
 *
 *  1. It refuses to spend unless `X402_MAINNET_CONFIRM` is set to the exact sentence
 *     `I_UNDERSTAND_THIS_SPENDS_REAL_USDC`. `--dry-run` is exempt, because it never submits a
 *     transaction and demanding a spend confirmation in order to *preview* a spend would make
 *     the script's own "run --dry-run first" advice impossible to follow.
 *  2. It prints the exact atomic amount and the exact destination address before spending.
 *  3. It checks the payer account on chain first — funded, opted in, holding enough USDC —
 *     because a failed settlement still costs a fee and still wastes a round trip.
 *  4. It waits, abortably, before sending.
 *  5. `--dry-run` performs every step except the payment.
 *
 * The private key is handed straight to the SDK. It is never logged, never echoed, and never
 * placed in an error message.
 *
 * Exit codes: 0 success, 1 failure, 2 refused by a guard.
 */

import {
  atomicToWire,
  formatUsd,
  normalizeNetwork,
  usdcAssetId,
  wireToAtomic,
  ALGORAND_MAINNET,
  type SettlementRecord,
} from "@x402-mesh/shared";
import * as avm from "@x402/avm";
import type { PaymentRequired } from "@x402/core/types";
import {
  BASE_MBR_MICRO_ALGO,
  PER_ASSET_MBR_MICRO_ALGO,
  accountExplorerLink,
  assetPosition,
  explorerLinks,
  fetchAccount,
  formatAlgo,
  resolveAlgod,
} from "./lib/algod.js";
import { createX402Payer, readChallenge } from "./lib/x402-client.js";
import {
  banner,
  errorMessage,
  heading,
  httpJson,
  info,
  parseArgs,
  style,
  wantsHelp,
} from "./lib/cli.js";

/** The exact value `X402_MAINNET_CONFIRM` must carry. Nothing else unlocks this script. */
const CONFIRM_PHRASE = "I_UNDERSTAND_THIS_SPENDS_REAL_USDC";

/** Seconds the script waits, abortably, between printing the spend and making it. */
const ABORT_WINDOW_SECONDS = 8;

/** Upper bound on what this diagnostic will ever spend, in atomic USDC units. */
const MAX_SPEND_ATOMIC = 10_000n;

/** Exit code used when a guard refuses to proceed. */
const EXIT_REFUSED = 2;

function printUsage(): void {
  process.stdout.write(`
${style.bold("e2e-mainnet")} — send ONE real MainNet USDC micro-payment through the gateway

  X402_MAINNET_CONFIRM=${CONFIRM_PHRASE} \\
  MESH_E2E_BASE_URL=https://your-gateway.example.com \\
  AVM_PRIVATE_KEY=<base64 64-byte key> \\
    npx tsx scripts/e2e-mainnet.ts [options]

Options:
  --base-url <url>   Gateway to pay. Also settable as MESH_E2E_BASE_URL.
  --model <name>     Model to request. Also settable as MESH_E2E_MODEL.
  --dry-run          Run every check and print the exact spend, then stop without paying.
  --no-wait          Skip the ${ABORT_WINDOW_SECONDS}s abort window.
  --help             Show this message.

${style.red("This spends real USDC on Algorand MainNet.")} It refuses to run unless
X402_MAINNET_CONFIRM is set to exactly:

  ${CONFIRM_PHRASE}

Exit codes: 0 success, 1 failure, 2 refused by a guard.
`);
}

/** Prints the refusal banner and the single line needed to proceed. */
function refuse(reason: string, remedy: string[]): number {
  banner(["REFUSING TO RUN.", reason, "", "This script spends REAL USDC on Algorand MainNet."]);
  heading("To proceed");
  for (const line of remedy) info(line);
  process.stdout.write("\n");
  return EXIT_REFUSED;
}

/** Sleeps, printing a countdown that the operator can interrupt with Ctrl-C. */
async function abortWindow(seconds: number): Promise<void> {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    process.stdout.write(
      `\r  ${style.yellow(`Sending in ${remaining}s — press Ctrl-C to abort.`)}   `,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  process.stdout.write("\r  Sending now.                                            \n");
}

/** Fetches the 402 challenge, or throws with the server's own explanation. */
async function fetchChallenge(
  baseUrl: string,
  model: string,
): Promise<{ challenge: PaymentRequired; resourceUrl: string }> {
  const resourceUrl = `${baseUrl}/v1/chat/completions`;
  const response = await fetch(resourceUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 402) {
    const body = (await response.text()).slice(0, 400);
    throw new Error(`expected 402 from ${resourceUrl}, got ${response.status}: ${body}`);
  }
  // Shared with e2e-simulate.ts: the challenge lives in the base64 `payment-required` header,
  // never in the body. Both scripts once read the body and both were wrong.
  const challenge = readChallenge(response);
  if (challenge === undefined) {
    throw new Error(`${resourceUrl} answered 402 without a decodable payment-required header`);
  }
  return { challenge, resourceUrl };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) {
    printUsage();
    return 0;
  }

  // ---- Guard 1: the explicit, unambiguous confirmation ------------------------------------
  //
  // `--dry-run` is exempt. It performs every check and prints the exact spend without ever
  // submitting a transaction, so requiring the spend confirmation to preview a spend is both
  // pointless and self-contradictory — the refusal message itself tells the operator to
  // "add --dry-run first", advice that could not be followed while this guard blocked it.
  // The confirmation still gates every path that actually moves money.
  const isDryRun = args.flags.has("dry-run");
  const confirm = process.env["X402_MAINNET_CONFIRM"]?.trim();
  if (!isDryRun && confirm !== CONFIRM_PHRASE) {
    return refuse(
      confirm === undefined || confirm === ""
        ? "X402_MAINNET_CONFIRM is not set."
        : "X402_MAINNET_CONFIRM does not carry the exact confirmation phrase.",
      [
        "Set the confirmation for this one invocation only — do not put it in .env:",
        "",
        `  export X402_MAINNET_CONFIRM=${CONFIRM_PHRASE}`,
        "",
        "Then re-run. Add --dry-run first to see exactly what would be spent.",
      ],
    );
  }

  // ---- Guard 2: the things it cannot run without ------------------------------------------
  const baseUrlRaw = args.options.get("base-url") ?? process.env["MESH_E2E_BASE_URL"];
  if (baseUrlRaw === undefined || baseUrlRaw.trim() === "") {
    return refuse("No gateway to pay: MESH_E2E_BASE_URL (or --base-url) is not set.", [
      "  export MESH_E2E_BASE_URL=https://your-gateway.example.com",
    ]);
  }
  const baseUrl = baseUrlRaw.trim().replace(/\/+$/, "");

  const privateKey = process.env["AVM_PRIVATE_KEY"]?.trim();
  if (privateKey === undefined || privateKey === "") {
    return refuse("No payer key: AVM_PRIVATE_KEY is not set.", [
      "  Generate one with `npm run keygen --  --network mainnet`,",
      "  fund it with ALGO, and opt it in to USDC (ASA 31566704).",
    ]);
  }
  if (Buffer.from(privateKey, "base64").length !== 64) {
    return refuse("AVM_PRIVATE_KEY does not decode to a 64-byte Algorand secret key.", [
      "  It must be base64 of the 32-byte seed followed by the 32-byte public key.",
    ]);
  }

  const dryRun = isDryRun;
  const model = args.options.get("model") ?? process.env["MESH_E2E_MODEL"] ?? "llama3.1:8b";

  // This script is MainNet by definition; an inherited MESH_NETWORK must not redirect it.
  const network = ALGORAND_MAINNET;
  const expectedAsset = usdcAssetId(network);
  if (process.env["MESH_NETWORK"] !== undefined && process.env["MESH_NETWORK"] !== "mainnet") {
    process.stderr.write(
      `${style.yellow("notice")}: MESH_NETWORK is "${process.env["MESH_NETWORK"]}" but this ` +
        `script always uses MainNet.\n`,
    );
  }

  let payerAddress: string;
  try {
    payerAddress = avm.toClientAvmSigner(privateKey).address;
  } catch (e) {
    // Deliberately does not echo the key, only the reason it was unusable.
    return refuse(`AVM_PRIVATE_KEY could not be turned into a signer: ${errorMessage(e)}`, [
      "  Regenerate it with `npm run keygen -- --network mainnet`.",
    ]);
  }

  banner(
    [
      "MAINNET DIAGNOSTIC — THIS SPENDS REAL USDC.",
      "",
      `Payer     ${payerAddress}`,
      `Gateway   ${baseUrl}`,
      `Network   Algorand MainNet (${network})`,
      `Asset     USDC, ASA ${expectedAsset}`,
      dryRun
        ? "Mode      DRY RUN — nothing will be sent."
        : "Mode      LIVE — a payment will be sent.",
    ],
    dryRun ? "notice" : "danger",
  );

  // ---- Guard 3: is the payer actually able to pay? ------------------------------------------
  heading("Payer account (Algorand MainNet)");
  const algod = resolveAlgod("mainnet");
  const account = await fetchAccount(algod, payerAddress);
  if (account === undefined) {
    return refuse(`${payerAddress} does not exist on MainNet.`, [
      "  Send it ALGO first; an Algorand account is created by its first funding.",
      `  ${accountExplorerLink("mainnet", payerAddress)}`,
    ]);
  }
  const algoBalance = BigInt(account.amount);
  const requiredAlgo = BASE_MBR_MICRO_ALGO + PER_ASSET_MBR_MICRO_ALGO;
  info(`balance        ${formatAlgo(algoBalance)}`);
  if (algoBalance < requiredAlgo) {
    return refuse(
      `${payerAddress} holds ${formatAlgo(algoBalance)}, below the ` +
        `${formatAlgo(requiredAlgo)} minimum balance requirement.`,
      ["  Top it up with ALGO before retrying."],
    );
  }

  const position = assetPosition(account, expectedAsset);
  if (!position.optedIn) {
    return refuse(`${payerAddress} has not opted in to USDC (ASA ${expectedAsset}).`, [
      "  An Algorand account cannot hold or send an asset it has not opted into.",
      "  An opt-in is a zero-amount asset transfer to itself.",
      `  ${accountExplorerLink("mainnet", payerAddress)}`,
    ]);
  }
  if (position.frozen) {
    return refuse("The payer's USDC holding is frozen by the asset manager.", [
      "  Use a different account.",
    ]);
  }
  info(
    `usdc holding   ${atomicToWire(position.balanceAtomic)} atomic ` +
      `(${formatUsd(position.balanceAtomic)})`,
  );

  // ---- The challenge: what exactly will be spent, and to whom? ------------------------------
  heading("Payment challenge");
  const { challenge, resourceUrl } = await fetchChallenge(baseUrl, model);
  const requirements = challenge.accepts?.[0];
  if (requirements === undefined) {
    return refuse("The gateway's 402 challenge carried no accepts[] entry.", [
      `  Check ${resourceUrl} and the gateway logs.`,
    ]);
  }

  const advertisedNetwork = normalizeNetwork(requirements.network);
  if (advertisedNetwork !== network) {
    return refuse(
      `The gateway is settling on ${advertisedNetwork}, not MainNet. ` +
        "This script only pays MainNet challenges.",
      ["  Point MESH_E2E_BASE_URL at a MainNet deployment, or use scripts/e2e-simulate.ts."],
    );
  }
  if (requirements.asset !== expectedAsset) {
    return refuse(
      `The challenge asks for ASA ${requirements.asset}, not USDC (${expectedAsset}).`,
      ["  Refusing to pay an unexpected asset."],
    );
  }

  const amountAtomic = wireToAtomic(requirements.amount);
  if (amountAtomic > MAX_SPEND_ATOMIC) {
    return refuse(
      `The challenge asks for ${atomicToWire(amountAtomic)} atomic USDC ` +
        `(${formatUsd(amountAtomic)}), above this script's hard cap of ` +
        `${atomicToWire(MAX_SPEND_ATOMIC)} (${formatUsd(MAX_SPEND_ATOMIC)}).`,
      ["  This is a micro-payment diagnostic, not a funding tool."],
    );
  }
  if (position.balanceAtomic < amountAtomic) {
    return refuse(
      `Payer holds ${formatUsd(position.balanceAtomic)} but the challenge asks for ` +
        `${formatUsd(amountAtomic)}.`,
      ["  Fund the account with USDC on the Algorand network (not another chain)."],
    );
  }

  info(`resource       ${resourceUrl}`);
  info(`scheme         ${requirements.scheme}`);
  info(`network        ${requirements.network}`);
  info(`asset          USDC, ASA ${requirements.asset}`);
  info(
    `${style.bold("AMOUNT")}         ${style.bold(atomicToWire(amountAtomic))} atomic USDC = ${style.bold(formatUsd(amountAtomic))}`,
  );
  info(`${style.bold("DESTINATION")}    ${style.bold(requirements.payTo)}`);
  const feePayer = requirements.extra?.["feePayer"];
  info(
    typeof feePayer === "string"
      ? `fee sponsor    ${feePayer} (the ALGO fee is not paid by you)`
      : "fee sponsor    none advertised — you pay the ALGO transaction fee",
  );

  if (dryRun) {
    heading("Dry run complete");
    info("Every guard passed. Nothing was sent. Re-run without --dry-run to pay.");
    process.stdout.write("\n");
    return 0;
  }

  if (!args.flags.has("no-wait")) {
    process.stdout.write("\n");
    await abortWindow(ABORT_WINDOW_SECONDS);
  }

  // ---- The payment --------------------------------------------------------------------------
  heading("Paying");
  // Shared with e2e-simulate.ts, which is what keeps the wildcard registration and the header
  // naming identical in both scripts.
  const paymentHeaders = await createX402Payer(privateKey).buildHeaders(challenge);
  info(`built an atomic transaction group for ${formatUsd(amountAtomic)}`);

  const response = await fetch(resourceUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...paymentHeaders },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Explain the x402 protocol in one sentence." }],
      max_tokens: 64,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (response.status !== 200) {
    const body = (await response.text()).slice(0, 600);
    process.stderr.write(
      `\n${style.red("payment failed")}: gateway returned ${response.status}\n${body}\n\n`,
    );
    return 1;
  }

  const settleHeader =
    response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  let txId: string | undefined;
  if (settleHeader !== null && settleHeader.trim() !== "") {
    try {
      const settle = JSON.parse(Buffer.from(settleHeader, "base64").toString("utf8")) as {
        transaction?: string;
        success?: boolean;
      };
      if (settle.success === true && typeof settle.transaction === "string") {
        txId = settle.transaction;
      }
    } catch {
      // Fall through to the "no transaction id" branch below; the body still tells us more.
    }
  }

  const requestId = response.headers.get("X-Mesh-Request-Id");
  const nodeId = response.headers.get("X-Mesh-Node-Id");
  const completion = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  heading("Settled");
  info(`spent          ${atomicToWire(amountAtomic)} atomic USDC = ${formatUsd(amountAtomic)}`);
  info(`to             ${requirements.payTo}`);
  if (nodeId !== null) info(`served by      ${nodeId}`);
  if (requestId !== null) info(`request id     ${requestId}`);
  const answer = completion.choices?.[0]?.message?.content ?? "";
  if (answer !== "") info(`completion     ${answer.slice(0, 120)}`);

  if (txId === undefined) {
    process.stderr.write(
      `\n${style.yellow("warning")}: the gateway returned 200 but no usable ` +
        `PAYMENT-RESPONSE header, so there is no transaction id to show.\n\n`,
    );
    return 1;
  }

  heading("Transaction");
  info(`${style.bold("TX ID")}          ${style.cyan(txId)}`);
  for (const link of explorerLinks("mainnet", txId)) info(`               ${link}`);

  // The operator payout is the second leg; it lands asynchronously, so report what is there.
  try {
    const ledger = await httpJson<{ settlements?: SettlementRecord[] }>(
      `${baseUrl}/v1/settlements?limit=10`,
      { timeoutMs: 15_000 },
    );
    const record = (ledger.settlements ?? []).find(
      (r) => r.inboundTxId === txId || (requestId !== null && r.requestId === requestId),
    );
    if (record !== undefined) {
      heading("Settlement record");
      info(`inbound        ${record.inboundAtomic} atomic -> ${record.inboundTxId}`);
      info(
        `payout         ${record.payoutAtomic} atomic -> ` +
          `${record.payoutTxId ?? "(pending)"} (${record.operatorAddress})`,
      );
      info(`margin         ${record.marginAtomic} atomic`);
      const inbound = wireToAtomic(record.inboundAtomic);
      const payout = wireToAtomic(record.payoutAtomic);
      const margin = wireToAtomic(record.marginAtomic);
      info(
        inbound - payout === margin
          ? style.green("invariant      inbound - payout == margin holds")
          : style.red("invariant      VIOLATED: inbound - payout != margin"),
      );
      if (record.payoutTxId !== null) {
        for (const link of explorerLinks("mainnet", record.payoutTxId))
          info(`               ${link}`);
      }
    }
  } catch {
    info("settlement ledger was not readable; the inbound transaction above is confirmed");
  }

  process.stdout.write(`\n${style.green("MainNet diagnostic complete.")}\n\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`\n${style.red("e2e-mainnet failed")}: ${errorMessage(e)}\n\n`);
    process.exitCode = 1;
  });
