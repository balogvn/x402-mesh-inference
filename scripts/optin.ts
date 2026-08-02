/**
 * `npm run optin` — opt an Algorand account into the USDC asset.
 *
 * Algorand will not deliver an asset to an account that has not explicitly opted in. Every
 * account in this system needs it — the gateway's `payTo`, and every node operator's payout
 * address — and skipping it is the single most common cause of a payout that fails *after*
 * the client has already been charged. The gateway refuses to register a node whose operator
 * has not opted in, for exactly that reason.
 *
 * An opt-in is a zero-amount asset transfer from the account **to itself**. It moves no value.
 * What it costs is the network fee (0.001 ALGO) and, permanently, 0.1 ALGO of additional
 * minimum balance that stays locked while the opt-in exists.
 *
 * Safety:
 *  - It refuses to run on MainNet without `X402_OPTIN_CONFIRM=I_UNDERSTAND_THIS_USES_REAL_ALGO`,
 *    because there the fee and the locked minimum balance are real money.
 *  - It is idempotent: an account already opted in is reported and left alone.
 *  - It checks the balance first, so it fails with an actionable message rather than an
 *    opaque rejection from algod.
 *  - The private key is read from the environment or a wallet file and is never logged.
 *
 * Exit codes: 0 success (or already opted in), 1 failure, 2 refused by a guard.
 */

import { readFileSync } from "node:fs";

import { normalizeNetwork, toCaip2, toMeshNetwork, usdcAssetId } from "@x402-mesh/shared";
import type { MeshNetwork } from "@x402-mesh/shared";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { getAlgokitSigner, toClientAvmSigner } from "@x402/avm";

import { accountExplorerLink, formatAlgo } from "./lib/algod.js";
import { banner, errorMessage, heading, info, parseArgs, style, wantsHelp } from "./lib/cli.js";

/** Confirmation required before this spends real ALGO on MainNet. */
const CONFIRM_PHRASE = "I_UNDERSTAND_THIS_USES_REAL_ALGO";

/** Exit code used when a guard refuses to proceed. */
const EXIT_REFUSED = 2;

/**
 * Minimum balance an account needs before it can afford one more opt-in.
 *
 * 0.1 ALGO base + 0.1 ALGO for the asset being opted into, plus headroom for the fee.
 */
const REQUIRED_MICRO_ALGO = 210_000n;

function printUsage(): void {
  process.stdout.write(`
${style.bold("optin")} — opt an account into the USDC asset so it can receive payouts

  AVM_PRIVATE_KEY=<base64 64-byte key> npx tsx scripts/optin.ts [options]

Options:
  --wallet <path>    Read ADDRESS/AVM_PRIVATE_KEY from a wallet env file instead.
  --network <name>   mainnet | testnet (default: MESH_NETWORK, else testnet)
  --asset <id>       Override the asset id (default: USDC for the network)
  --help             Show this message.

An opt-in moves no value. It costs the network fee and locks 0.1 ALGO of minimum
balance for as long as the opt-in exists. On MainNet this script refuses to run
unless X402_OPTIN_CONFIRM=${CONFIRM_PHRASE}.
`);
}

/**
 * Loads the signing key, preferring an explicit wallet file over the environment.
 *
 * @param walletPath - Optional path to a `KEY=VALUE` wallet file.
 * @returns The base64 private key, or undefined when none is configured.
 */
function loadKey(walletPath: string | undefined): string | undefined {
  if (walletPath !== undefined) {
    const line = readFileSync(walletPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("AVM_PRIVATE_KEY="));
    return line?.slice("AVM_PRIVATE_KEY=".length).trim() || undefined;
  }
  const fromEnv = process.env["AVM_PRIVATE_KEY"]?.trim();
  return fromEnv === "" ? undefined : fromEnv;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) {
    printUsage();
    return 0;
  }

  const selector = (args.options.get("network") ??
    process.env["MESH_NETWORK"] ??
    "testnet") as MeshNetwork;
  if (selector !== "mainnet" && selector !== "testnet") {
    banner(["REFUSING TO RUN.", `--network must be mainnet or testnet, got "${selector}".`]);
    return EXIT_REFUSED;
  }
  const network = normalizeNetwork(toCaip2(selector));
  const meshNetwork = toMeshNetwork(network);

  // MainNet locks real ALGO into the minimum balance and spends a real fee.
  if (meshNetwork === "mainnet" && process.env["X402_OPTIN_CONFIRM"]?.trim() !== CONFIRM_PHRASE) {
    banner([
      "REFUSING TO RUN ON MAINNET.",
      "X402_OPTIN_CONFIRM is not set to the confirmation phrase.",
      "",
      "An opt-in moves no value, but it spends a real fee and permanently locks",
      "0.1 ALGO of minimum balance while it exists.",
    ]);
    heading("To proceed");
    info(`  export X402_OPTIN_CONFIRM=${CONFIRM_PHRASE}`);
    process.stdout.write("\n");
    return EXIT_REFUSED;
  }

  const key = loadKey(args.options.get("wallet"));
  if (key === undefined) {
    banner(["REFUSING TO RUN.", "No key: set AVM_PRIVATE_KEY or pass --wallet <path>."]);
    return EXIT_REFUSED;
  }

  let address: string;
  let algorand: AlgorandClient;
  try {
    const signer = toClientAvmSigner(key);
    address = signer.address;
    algorand = meshNetwork === "mainnet" ? AlgorandClient.mainNet() : AlgorandClient.testNet();
    const algokitSigner = getAlgokitSigner(signer);
    if (algokitSigner === null) throw new Error("no algokit transaction signer");
    algorand.setSignerFromAccount(algokitSigner);
  } catch (cause) {
    banner(["REFUSING TO RUN.", "AVM_PRIVATE_KEY is not a valid Algorand secret key."]);
    info(`  ${errorMessage(cause)}`);
    return EXIT_REFUSED;
  }

  const assetId = BigInt(args.options.get("asset") ?? usdcAssetId(network));

  heading("Opt-in");
  info(`  network   ${meshNetwork} (${network})`);
  info(`  account   ${address}`);
  info(`  asset     ${assetId.toString(10)}`);

  // Idempotent: an account already holding the asset position needs nothing.
  try {
    await algorand.asset.getAccountInformation(address, assetId);
    info(`  ${style.green("already opted in — nothing to do")}`);
    process.stdout.write("\n");
    return 0;
  } catch {
    // Not opted in; continue.
  }

  const account = await algorand.account.getInformation(address);
  const micro = BigInt(account.balance.microAlgo);
  if (micro < REQUIRED_MICRO_ALGO) {
    banner([
      "REFUSING TO RUN.",
      `Account holds ${formatAlgo(micro)}, below the ${formatAlgo(REQUIRED_MICRO_ALGO)} needed.`,
      "",
      "Algorand requires 0.1 ALGO of minimum balance per account plus 0.1 per",
      "opted-in asset, and the opt-in itself costs a fee.",
    ]);
    heading("Fund it first");
    info(`  ${accountExplorerLink(meshNetwork, address)}`);
    if (meshNetwork === "testnet") info("  https://lora.algokit.io/testnet/fund");
    process.stdout.write("\n");
    return EXIT_REFUSED;
  }

  info(`  balance   ${formatAlgo(micro)}`);
  info("  submitting a zero-amount transfer to self…");

  try {
    const result = await algorand.send.assetTransfer({
      sender: address,
      receiver: address, // an opt-in is a transfer to oneself
      assetId,
      amount: 0n,
      note: "x402-mesh/optin",
      suppressLog: true,
    });
    const txId = result.txIds[0] ?? "(none)";
    heading("Opted in");
    info(`  txid      ${txId}`);
    info(`  account   ${accountExplorerLink(meshNetwork, address)}`);
    info(`  ${style.green("this account can now receive USDC")}`);
    process.stdout.write("\n");
    return 0;
  } catch (cause) {
    banner(["OPT-IN FAILED.", errorMessage(cause)]);
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    banner(["OPT-IN FAILED.", errorMessage(cause)]);
    process.exitCode = 1;
  });
