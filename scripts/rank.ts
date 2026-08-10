/**
 * `npm run rank` — where this service sits on the x402 Global Challenge leaderboard.
 *
 * The leaderboard is the Bazaar catalog filtered to entries carrying
 * `accepts[].extra.tag === "x402-global-challenge"`. Everything here is read-only and
 * unauthenticated, so it costs nothing to run as often as you like.
 *
 * It also reports the payer balance, because the two questions are always asked together:
 * where am I, and can I do anything about it.
 */

import {
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  heading,
  info,
  parseArgs,
  style,
  wantsHelp,
} from "./lib/cli.js";

/**
 * The catalog, requested whole.
 *
 * `limit` was 100, and that was silently wrong rather than merely incomplete. The endpoint does
 * NOT return the top 100 by settle count — it returns an arbitrary 100-entry slice, so both the
 * reported rank and the field size were fiction. It read "rank 4 of 54" when the truth was rank
 * 14 of 831, and after the slice shifted it read "no tagged entry", which looked exactly like
 * being dropped from the leaderboard.
 *
 * A truncated leaderboard is worse than no leaderboard: it produces a confident wrong answer.
 */
const CATALOG_BASE = "https://facilitator.goplausible.xyz/discovery/resources";
const CATALOG_LIMIT = 5000;
const CATALOG = `${CATALOG_BASE}?limit=${CATALOG_LIMIT}`;
const CHALLENGE_TAG = "x402-global-challenge";
const USDC_MAINNET = "31566704";

interface CatalogEntry {
  resourceUrl: string;
  settleCount: number;
  verifyCount: number;
  accepts: { extra?: Record<string, unknown> }[];
}

function printUsage(): void {
  process.stdout.write(`
${style.bold("rank")} — challenge leaderboard position and payer balance

  npm run rank
  npm run rank -- --match x402-mesh --top 10

Options:
  --match <substr>   Identify our entries by URL substring. Default "x402-mesh".
  --top <n>          How many leaderboard rows to show. Default 8.
  --wallet <path>    Payer env file, for the balance line. Default .wallets/client-mainnet.env.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) {
    printUsage();
    return;
  }
  const match = args.options.get("match") ?? "x402-mesh";
  const top = Number(args.options.get("top") ?? "8");
  const walletPath = args.options.get("wallet") ?? ".wallets/client-mainnet.env";

  // The full catalog is over a thousand entries; the default probe timeout is sized for a health
  // check, not a bulk fetch, and using it here made the whole ranking fail rather than truncate.
  const response = await fetch(CATALOG, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`catalog fetch failed: HTTP ${response.status}`);
  const items = ((await response.json()) as { items?: CatalogEntry[] }).items ?? [];

  // If the catalog ever fills the requested limit exactly, we are looking at a page again and the
  // ranking below is unreliable. Say so rather than printing a confident number.
  if (items.length >= CATALOG_LIMIT) {
    info(
      style.yellow(
        `WARNING: catalog returned ${items.length} entries, the full requested limit — there may be more, and this ranking may be truncated.`,
      ),
    );
  }

  // The filter reads the tag from the payment requirement, not from the route's `tags` array.
  // Those are two different fields and only this one enters the competition.
  const tagged = items.filter((i) => i.accepts?.[0]?.extra?.["tag"] === CHALLENGE_TAG);
  const ranked = [...tagged].sort((a, b) => b.settleCount - a.settleCount);

  heading(`challenge leaderboard — ${tagged.length} tagged of ${items.length} catalog entries`);
  for (const [index, entry] of ranked.slice(0, top).entries()) {
    const ours = entry.resourceUrl.includes(match);
    const line = `${String(index + 1).padStart(3)}. ${String(entry.settleCount).padStart(5)}  ${entry.resourceUrl.slice(0, 52)}`;
    info(ours ? style.green(`${line}   <-- us`) : line);
  }

  // Untagged resources of ours are worth surfacing: they may be earning settlements that do not
  // count. The alias path exists precisely because the catalog freezes `accepts` on a resource it
  // has already indexed, so the original path can carry settles the leaderboard ignores.
  const untagged = items.filter(
    (i) =>
      i.resourceUrl.includes(match) &&
      i.accepts?.[0]?.extra?.["tag"] !== CHALLENGE_TAG &&
      i.settleCount > 0,
  );
  for (const entry of untagged) {
    info(
      style.yellow(
        `\nUNTAGGED: ${entry.resourceUrl} has ${entry.settleCount} settles that do NOT count`,
      ),
    );
  }

  const mine = ranked.filter((i) => i.resourceUrl.includes(match));
  if (mine.length === 0) {
    info(style.yellow(`\nno tagged entry matching "${match}".`));
    info(
      style.dim(
        "an entry only appears once a MainNet settlement carries extra.asset AND extra.tag",
      ),
    );
  } else {
    for (const entry of mine) {
      const place = ranked.findIndex((r) => r.resourceUrl === entry.resourceUrl) + 1;
      const leader = ranked[0]?.settleCount ?? 0;
      const gap = leader - entry.settleCount;
      info(
        `\nus: ${entry.settleCount} settles, rank ${place} of ${tagged.length}` +
          (gap > 0 ? ` — ${gap} behind the leader` : " — leading"),
      );
    }
  }

  try {
    const { readFileSync } = await import("node:fs");
    const address = /^ADDRESS=(.*)$/m.exec(readFileSync(walletPath, "utf8"))?.[1]?.trim();
    if (address !== undefined) {
      const account = await fetch(`https://mainnet-api.algonode.cloud/v2/accounts/${address}`, {
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      const body = (await account.json()) as { assets?: { "asset-id": number; amount: number }[] };
      const usdc =
        (body.assets ?? []).find((a) => String(a["asset-id"]) === USDC_MAINNET)?.amount ?? 0;
      info(`payer: ${(usdc / 1e6).toFixed(6)} USDC`);
    }
  } catch {
    // The balance line is a convenience; the leaderboard is the point.
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});
