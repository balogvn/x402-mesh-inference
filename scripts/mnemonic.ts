/**
 * `npm run mnemonic` — print the 25-word mnemonic for a wallet file.
 *
 * `keygen` emits `AVM_PRIVATE_KEY`, the base64 64-byte secret key the x402 SDK and this
 * codebase use. Wallet apps — Pera, Defly, Exodus — import the *same* key as a 25-word
 * mnemonic instead. They are two encodings of one secret, not two different keys, so a
 * mnemonic printed here controls exactly the account in the wallet file.
 *
 * This exists as a script rather than something printed alongside `keygen` for one reason:
 * a mnemonic is the most exfiltratable form a key can take. Twenty-five common English words
 * survive a screenshot, a chat paste, a log scrape and an OCR pass in a way base64 does not.
 * It is emitted only when someone deliberately asks for it, and only to their own terminal.
 *
 * Exit codes: 0 success, 2 refused by a guard.
 */

import { readFileSync } from "node:fs";

import algosdk from "algosdk";

import { banner, errorMessage, heading, info, parseArgs, style, wantsHelp } from "./lib/cli.js";

/** Exit code used when a guard refuses to proceed. */
const EXIT_REFUSED = 2;

function printUsage(): void {
  process.stdout.write(`
${style.bold("mnemonic")} — print the 25-word mnemonic for a wallet file, for wallet import

  npx tsx scripts/mnemonic.ts --wallet .wallets/client-mainnet.env

Options:
  --wallet <path>   Wallet env file holding AVM_PRIVATE_KEY. Required.
  --help            Show this message.

${style.red("The output is a live secret.")} Anyone who reads those 25 words controls the
account and everything in it, forever. Do not screenshot it, do not paste it into a chat or
an issue, and do not run this while screen sharing.
`);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) {
    printUsage();
    return 0;
  }

  const walletPath = args.options.get("wallet");
  if (walletPath === undefined) {
    banner(["REFUSING TO RUN.", "No wallet: pass --wallet <path>."]);
    info("  e.g. npx tsx scripts/mnemonic.ts --wallet .wallets/client-mainnet.env");
    process.stdout.write("\n");
    return EXIT_REFUSED;
  }

  let key: string;
  try {
    const line = readFileSync(walletPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("AVM_PRIVATE_KEY="));
    if (line === undefined) throw new Error("no AVM_PRIVATE_KEY line in that file");
    key = line.slice("AVM_PRIVATE_KEY=".length).trim();
  } catch (cause) {
    banner(["REFUSING TO RUN.", `Could not read ${walletPath}.`]);
    info(`  ${errorMessage(cause)}`);
    return EXIT_REFUSED;
  }

  let secret: Uint8Array;
  try {
    secret = new Uint8Array(Buffer.from(key, "base64"));
    if (secret.length !== 64) throw new Error(`expected 64 bytes, got ${secret.length}`);
  } catch (cause) {
    banner(["REFUSING TO RUN.", "AVM_PRIVATE_KEY is not a 64-byte base64 secret key."]);
    info(`  ${errorMessage(cause)}`);
    return EXIT_REFUSED;
  }

  const mnemonic = algosdk.secretKeyToMnemonic(secret);
  // Round-trip before showing it: a mnemonic that does not restore the same address would be
  // worse than useless, because it fails silently at import time rather than here.
  const restored = algosdk.mnemonicToSecretKey(mnemonic);
  const expected = algosdk.encodeAddress(secret.slice(32));
  if (restored.addr.toString() !== expected) {
    banner(["REFUSING TO PRINT.", "The mnemonic does not restore the original address."]);
    return EXIT_REFUSED;
  }

  banner([
    "THE 25 WORDS BELOW ARE A LIVE SECRET.",
    "Anyone who reads them controls this account forever.",
    "Do not screenshot, paste, or run this while screen sharing.",
  ]);
  heading("Account");
  info(`  address   ${expected}`);
  heading("25-word mnemonic (import this into Pera / Defly)");
  process.stdout.write(`\n  ${mnemonic}\n\n`);
  return 0;
}

process.exitCode = main();
