/**
 * `npm run keygen` — generate a fresh Algorand account for the mesh.
 *
 * Prints the public ADDRESS and the base64 64-byte secret key to put in `AVM_PRIVATE_KEY`,
 * then the opt-in steps that are mandatory before the account can hold or receive USDC.
 *
 * The key is generated locally with `node:crypto` and is never transmitted, never written to
 * disk and never sent to a log aggregator by this script. What happens to it after it leaves
 * this process is entirely on the operator, which is why the warning is as loud as it is.
 *
 * Usage:
 *   npx tsx scripts/keygen.ts [--network mainnet|testnet] [--count N] [--quiet]
 */

import * as avm from "@x402/avm";
import { toCaip2, usdcAssetId, type MeshNetwork } from "@x402-mesh/shared";
import { faucetHints } from "./lib/algod.js";
import { banner, errorMessage, heading, info, parseArgs, style, wantsHelp } from "./lib/cli.js";
import { generateKeypair } from "./lib/ed25519.js";

/** A generated account. The secret is held only for as long as it takes to print it. */
interface GeneratedAccount {
  address: string;
  /** Base64 of the 64-byte secret key. */
  secretKeyB64: string;
}

/**
 * Generates one Algorand account and cross-checks the address two independent ways.
 *
 * `generateKeypair` derives the address from the public key with `sha512-256` directly;
 * `avm.toClientAvmSigner` derives it through the SDK. A keygen tool that prints an address not
 * matching its key is the worst possible failure mode, because the mistake only surfaces once
 * funds have already been sent somewhere unrecoverable — so the two must agree before anything
 * is displayed.
 *
 * @throws {Error} if the derivations disagree or the address fails SDK validation.
 */
function generateAccount(): GeneratedAccount {
  const keypair = generateKeypair();
  const sdkAddress = avm.toClientAvmSigner(keypair.secretKeyB64).address;
  if (sdkAddress !== keypair.address) {
    throw new Error("address derivation mismatch between @x402/avm and the local derivation");
  }
  if (!avm.isValidAlgorandAddress(sdkAddress)) {
    throw new Error("generated address failed Algorand address validation");
  }
  return { address: sdkAddress, secretKeyB64: keypair.secretKeyB64 };
}

function printUsage(): void {
  process.stdout.write(`
${style.bold("keygen")} — generate an Algorand account for the x402 mesh

  npx tsx scripts/keygen.ts [options]

Options:
  --network <mainnet|testnet>  Network the opt-in instructions target. Default: testnet.
  --count <n>                  Generate n accounts (1-10). Default: 1.
  --quiet                      Print only "ADDRESS<tab>SECRET" lines, no guidance.
  --help                       Show this message.

The secret key is printed to stdout. Nothing is written to disk.
`);
}

function parseNetwork(raw: string | undefined): MeshNetwork {
  if (raw === undefined || raw === "testnet") return "testnet";
  if (raw === "mainnet") return "mainnet";
  throw new Error(`--network must be "mainnet" or "testnet", got "${raw}"`);
}

function parseCount(raw: string | undefined): number {
  if (raw === undefined) return 1;
  if (!/^\d+$/.test(raw)) throw new Error(`--count must be a positive integer, got "${raw}"`);
  const n = Number(raw);
  if (n < 1 || n > 10) throw new Error("--count must be between 1 and 10");
  return n;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) {
    printUsage();
    return 0;
  }

  let network: MeshNetwork;
  let count: number;
  try {
    network = parseNetwork(args.options.get("network"));
    count = parseCount(args.options.get("count"));
  } catch (e) {
    process.stderr.write(`${style.red("error")}: ${errorMessage(e)}\n`);
    printUsage();
    return 2;
  }

  const quiet = args.flags.has("quiet");
  const accounts = Array.from({ length: count }, () => generateAccount());

  if (quiet) {
    for (const account of accounts) {
      process.stdout.write(`${account.address}\t${account.secretKeyB64}\n`);
    }
    return 0;
  }

  banner([
    "THE LINE BELOW MARKED AVM_PRIVATE_KEY IS A LIVE SECRET KEY.",
    "Anyone who reads it can spend every asset in this account, forever.",
    "Do not commit it, do not paste it into an issue, chat or screen share,",
    "and do not store it anywhere your shell history or CI logs can reach.",
  ]);

  if (!process.stdout.isTTY) {
    process.stderr.write(
      `${style.yellow("notice")}: stdout is not a terminal — a secret key is being written ` +
        `to a pipe or file. Make sure the destination is not a log, a build artifact or a ` +
        `world-readable path.\n\n`,
    );
  }

  const caip2 = toCaip2(network);
  const asaId = usdcAssetId(caip2);

  accounts.forEach((account, index) => {
    heading(count > 1 ? `Account ${index + 1} of ${count}` : "Generated account");
    info(`${style.bold("ADDRESS")}          ${style.cyan(account.address)}`);
    info(`${style.bold("AVM_PRIVATE_KEY")}  ${style.red(account.secretKeyB64)}`);
  });

  heading(`Before this account can be paid on ${network}`);
  info(`Network (CAIP-2)   ${caip2}`);
  info(`USDC asset id      ${asaId}`);
  info("");
  info(`${style.bold("1.")} Fund it with ALGO. Algorand charges a minimum balance of 0.1 ALGO per`);
  info("   account plus 0.1 ALGO per opted-in asset, so keep at least 0.3 ALGO here to");
  info("   cover the balance floor and transaction fees.");
  for (const hint of faucetHints(network)) info(`   ${hint}`);
  info("");
  info(`${style.bold("2.")} Opt in to USDC (asset ${asaId}). An Algorand account CANNOT receive`);
  info("   an asset it has not opted into — payouts to a non-opted-in address fail on");
  info("   chain, after the client has already been charged. An opt-in is simply a");
  info("   zero-amount asset transfer from the account to itself.");
  info(`   Easiest: open https://lora.algokit.io/${network}/ , connect this account, then`);
  info(`   "Assets" -> "Opt in" -> asset id ${asaId}. Pera and Defly can do the same.`);
  info("");
  info(`${style.bold("3.")} Wire it up, then verify:`);
  info(
    `   ${style.dim("# gateway (receives client payments)")}\n` +
      `   X402_PAY_TO_ADDRESS=${accounts[0]?.address ?? "<address>"}`,
  );
  info(
    `   ${style.dim("# node daemon (signs registrations, receives payouts)")}\n` +
      `   AVM_PRIVATE_KEY=<the secret printed above>`,
  );
  info(`   MESH_NETWORK=${network}`);
  info("");
  info(`   npm run preflight    ${style.dim("# confirms funding and the USDC opt-in")}`);
  process.stdout.write("\n");

  return 0;
}

process.exitCode = main();
