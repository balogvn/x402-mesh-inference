/**
 * `npm run sustain` — drive paid requests at a steady rate over a long window.
 *
 * The x402 Global Challenge measures volume over an **unannounced window**, so a burst on any
 * given day is worth little: what counts is being consistently active whenever the window lands.
 * This runs one paid request every `--interval` seconds until a stop condition trips.
 *
 * It spends real money without a human watching, which is the entire reason this file is as
 * defensive as it is. Four independent stops, any one of which ends the run:
 *
 *   1. `--budget` — hard ceiling on total USDC spent. Never exceeded, never rolled over.
 *   2. `--floor` — leaves this much USDC in the payer, so a wallet is never drained to zero.
 *   3. `--max-requests` — a count cap, in case a price change makes the budget go further than
 *      intended.
 *   4. Consecutive failures — three in a row and it stops rather than hammering a broken
 *      gateway. A payment that fails still costs a client transaction attempt.
 *
 * It also refuses to start without `--i-understand-this-spends-real-money`, because a script
 * that quietly spends MainNet USDC on a cron is not something anyone should be able to run by
 * tab-completing a name.
 *
 * Exit codes: 0 finished cleanly, 2 refused by a guard, 1 stopped on repeated failure.
 */

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import {
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  heading,
  info,
  parseArgs,
  style,
  wantsHelp,
} from "./lib/cli.js";
import { createX402Payer, readChallenge } from "./lib/x402-client.js";

/** Exit code used when a guard refuses to proceed. */
const EXIT_REFUSED = 2;

/** Consecutive failures tolerated before giving up on the gateway. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Floor below which we will not start at all, regardless of `--floor`. */
const ABSOLUTE_MIN_INTERVAL_S = 10;

interface Wallet {
  algo: number;
  usdc: number;
}

function printUsage(): void {
  process.stdout.write(`
${style.bold("sustain")} — drive paid requests at a steady rate, with hard spend limits

  npm run sustain -- --budget 0.05 --interval 300 --i-understand-this-spends-real-money

Required:
  --i-understand-this-spends-real-money   Explicit opt-in. This spends MainNet USDC unattended.

Options:
  --budget <usdc>      Hard ceiling on total spend. Default 0.02.
  --floor <usdc>       Stop when the payer falls to this balance. Default 0.002.
  --interval <sec>     Seconds between requests. Default 300 (5 min). Minimum ${ABSOLUTE_MIN_INTERVAL_S}.
  --max-requests <n>   Stop after this many successful settlements. Default 1000.
  --url <url>          Paid endpoint. Default the live /v1/inference.
  --model <id>         Model to request. Default llama-3.3-70b-versatile.
  --wallet <path>      Payer env file holding AVM_PRIVATE_KEY. Default .wallets/client-mainnet.env.
  --dry-run            Show what would happen and exit without paying.

The four stop conditions are budget, floor, max-requests and consecutive failures. Whichever
trips first ends the run.
`);
}

/** Reads USDC and ALGO for an address from the public MainNet API. */
async function readWallet(address: string, assetId: string): Promise<Wallet> {
  const response = await fetch(`https://mainnet-api.algonode.cloud/v2/accounts/${address}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`account lookup failed: HTTP ${response.status}`);
  const body = (await response.json()) as {
    amount?: number;
    assets?: { "asset-id": number; amount: number }[];
  };
  const holding = (body.assets ?? []).find((a) => String(a["asset-id"]) === assetId);
  return {
    algo: (body.amount ?? 0) / 1e6,
    usdc: (holding?.amount ?? 0) / 1e6,
  };
}

/** Extracts `AVM_PRIVATE_KEY` from a wallet env file without importing dotenv. */
function readPrivateKey(path: string): string {
  const match = /^AVM_PRIVATE_KEY=(.*)$/m.exec(readFileSync(path, "utf8"));
  const key = match?.[1]?.trim();
  if (key === undefined || key.length === 0) {
    throw new Error(`no AVM_PRIVATE_KEY in ${path}`);
  }
  return key;
}

/** One paid request. Returns the atomic amount settled, or throws with a usable reason. */
async function payOnce(
  url: string,
  model: string,
  payer: ReturnType<typeof createX402Payer>,
): Promise<bigint> {
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with one word." }],
  });
  const headers = { "content-type": "application/json" };

  const unpaid = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (unpaid.status !== 402) throw new Error(`expected 402, got ${unpaid.status}`);

  const challenge = readChallenge(unpaid);
  if (challenge === undefined) throw new Error("402 carried no payment-required header");

  const amount = BigInt((challenge.accepts[0] as { amount: string } | undefined)?.amount ?? "0");
  const paid = await fetch(url, {
    method: "POST",
    headers: { ...headers, ...(await payer.buildHeaders(challenge)) },
    body,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!paid.ok) {
    // The reason a payment was rejected is in the header, not the body — the body is `{}`.
    const retry = readChallenge(paid);
    throw new Error(`${paid.status}: ${retry?.error ?? (await paid.text()) ?? paid.statusText}`);
  }
  return amount;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) {
    printUsage();
    return;
  }

  const url = args.options.get("url") ?? "https://x402-mesh-gateway.fly.dev/v1/inference";
  const model = args.options.get("model") ?? "llama-3.3-70b-versatile";
  const walletPath = args.options.get("wallet") ?? ".wallets/client-mainnet.env";
  const budget = Number(args.options.get("budget") ?? "0.02");
  const floor = Number(args.options.get("floor") ?? "0.002");
  const intervalS = Number(args.options.get("interval") ?? "300");
  const maxRequests = Number(args.options.get("max-requests") ?? "1000");
  const dryRun = args.flags.has("dry-run");
  const consented = args.flags.has("i-understand-this-spends-real-money");

  heading("sustain — steady paid volume with hard spend limits");

  for (const [label, value] of [
    ["budget", budget],
    ["floor", floor],
    ["interval", intervalS],
    ["max-requests", maxRequests],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      info(style.red(`--${label} must be a non-negative number`));
      process.exit(EXIT_REFUSED);
    }
  }
  if (intervalS < ABSOLUTE_MIN_INTERVAL_S) {
    info(style.red(`--interval must be at least ${ABSOLUTE_MIN_INTERVAL_S}s; refusing to hammer`));
    process.exit(EXIT_REFUSED);
  }

  const key = readPrivateKey(walletPath);
  const payer = createX402Payer(key);
  const start = await readWallet(payer.address, "31566704");

  info(`payer      ${payer.address.slice(0, 8)}…${payer.address.slice(-6)}`);
  info(`balance    ${start.usdc.toFixed(6)} USDC   ${start.algo.toFixed(4)} ALGO`);
  info(`endpoint   ${url}`);
  info(`budget     ${budget.toFixed(6)} USDC, floor ${floor.toFixed(6)}, every ${intervalS}s`);

  const spendable = Math.max(0, Math.min(budget, start.usdc - floor));
  info(`spendable  ${spendable.toFixed(6)} USDC after the floor is reserved`);

  if (spendable <= 0) {
    info(
      style.yellow(
        "nothing spendable: balance is at or below the floor. Top up, or lower --floor.",
      ),
    );
    process.exit(EXIT_REFUSED);
  }

  if (dryRun) {
    info(style.dim("--dry-run: stopping before any payment."));
    return;
  }
  if (!consented) {
    info(style.red("refusing to start without --i-understand-this-spends-real-money"));
    info(style.dim("this spends MainNet USDC unattended; the flag is the point"));
    process.exit(EXIT_REFUSED);
  }

  let spentAtomic = 0n;
  let settled = 0;
  let consecutiveFailures = 0;
  const budgetAtomic = BigInt(Math.floor(budget * 1e6));
  const floorAtomic = BigInt(Math.floor(floor * 1e6));

  // Stop cleanly on Ctrl-C rather than dying mid-request.
  let stopping = false;
  process.on("SIGINT", () => {
    info(style.yellow("\nstopping after the current request…"));
    stopping = true;
  });

  while (!stopping && settled < maxRequests) {
    const wallet = await readWallet(payer.address, "31566704");
    const balanceAtomic = BigInt(Math.floor(wallet.usdc * 1e6));

    if (balanceAtomic <= floorAtomic) {
      info(style.yellow(`stop: balance ${wallet.usdc.toFixed(6)} reached the floor`));
      break;
    }
    if (spentAtomic >= budgetAtomic) {
      info(style.yellow(`stop: budget of ${budget.toFixed(6)} USDC spent`));
      break;
    }

    try {
      const amount = await payOnce(url, model, payer);
      spentAtomic += amount;
      settled += 1;
      consecutiveFailures = 0;
      info(
        `${style.green("settled")} #${settled}  ${amount} atomic  ` +
          `spent ${(Number(spentAtomic) / 1e6).toFixed(6)}/${budget.toFixed(6)}`,
      );
    } catch (error) {
      consecutiveFailures += 1;
      info(`${style.red("failed")}  ${errorMessage(error)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        info(style.red(`stop: ${MAX_CONSECUTIVE_FAILURES} consecutive failures`));
        process.exitCode = 1;
        break;
      }
    }

    // Sleep only when another request is actually coming. Sleeping after the final one made
    // `--max-requests 1` wait a full interval before noticing it was finished — harmless in a
    // long run, but it makes the script untestable and a cron invocation hang for nothing.
    const willContinue = !stopping && settled < maxRequests && consecutiveFailures === 0;
    if (willContinue) await sleep(intervalS * 1000);
  }

  const end = await readWallet(payer.address, "31566704");
  heading("done");
  info(`settled    ${settled} requests`);
  info(`spent      ${(Number(spentAtomic) / 1e6).toFixed(6)} USDC`);
  info(`balance    ${start.usdc.toFixed(6)} -> ${end.usdc.toFixed(6)} USDC`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});
