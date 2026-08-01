/**
 * `npm run preflight` — verify a deployment can actually take a payment before it takes one.
 *
 * Every failure this catches is one that otherwise surfaces *after* a client has been charged:
 * a facilitator that does not support the configured chain, a `payTo` address that has not
 * opted in to USDC, an unfunded account that cannot meet its minimum balance, a public base
 * URL that points at localhost so nobody can pay the challenge.
 *
 * Exit code is 0 when every check passes (warnings are tolerated) and 1 otherwise, so it can
 * gate a deploy.
 *
 * Usage:
 *   npx tsx scripts/preflight.ts [--network mainnet|testnet] [--skip-chain] [--json]
 */

import { createConnection } from "node:net";
import * as avm from "@x402/avm";
import {
  ConfigError,
  MeshError,
  assertSplitInvariant,
  atomicToWire,
  computeSplit,
  formatUsd,
  isSupportedNetwork,
  loadGatewayConfig,
  normalizeNetwork,
  toMeshNetwork,
  usdcAssetId,
  usdcToAtomic,
  type GatewayConfig,
  type MeshNetwork,
} from "@x402-mesh/shared";
import {
  BASE_MBR_MICRO_ALGO,
  PER_ASSET_MBR_MICRO_ALGO,
  accountExplorerLink,
  algodStatus,
  assetPosition,
  faucetHints,
  fetchAccount,
  formatAlgo,
  resolveAlgod,
  type AlgodConfig,
} from "./lib/algod.js";
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

/** The hackathon-mandated discovery tag. Its absence is a submission problem, not a bug. */
const REQUIRED_CHALLENGE_TAG = "x402-global-challenge";

/** One entry of the facilitator's `/supported` response. */
interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

/** Shape of `GET /supported` on an x402 facilitator. */
interface SupportedResponse {
  kinds?: SupportedKind[];
  extensions?: string[];
  signers?: Record<string, string[]>;
}

function printUsage(): void {
  process.stdout.write(`
${style.bold("preflight")} — check that this deployment can take an x402 payment

  npx tsx scripts/preflight.ts [options]

Options:
  --network <mainnet|testnet>  Override MESH_NETWORK for this run.
  --skip-chain                 Skip the algod balance and USDC opt-in checks.
  --help                       Show this message.

Exits 0 when every check passes, 1 otherwise. Warnings do not fail the run.
`);
}

/**
 * Loads gateway configuration, recording a precise failure rather than throwing.
 *
 * A {@link ConfigError} already names the offending environment variables, which is exactly
 * what an operator needs; anything else is reported verbatim.
 */
function loadConfig(
  checklist: Checklist,
  overrideNetwork?: MeshNetwork,
): GatewayConfig | undefined {
  const env: NodeJS.ProcessEnv =
    overrideNetwork === undefined
      ? process.env
      : { ...process.env, MESH_NETWORK: overrideNetwork, X402_NETWORK: "" };
  try {
    const config = loadGatewayConfig(env);
    checklist.pass(
      "configuration",
      `network ${toMeshNetwork(config.network)}, port ${config.port}`,
    );
    return config;
  } catch (e) {
    if (e instanceof ConfigError) {
      // ConfigError already names the offending variables in its message; only append the
      // structured list when it adds something the message does not already say.
      const variables = e.details?.["variables"];
      const missing = (Array.isArray(variables) ? variables : []).filter(
        (v): v is string => typeof v === "string" && !e.message.includes(v),
      );
      const suffix = missing.length === 0 ? "" : ` [${missing.join(", ")}]`;
      checklist.fail("configuration", `${e.message}${suffix}`);
    } else {
      checklist.fail("configuration", errorMessage(e));
    }
    return undefined;
  }
}

/** Verifies the published economics hold in integer arithmetic before any money moves. */
function checkPricing(checklist: Checklist, config: GatewayConfig): void {
  try {
    const inbound = usdcToAtomic(config.inboundPriceUsdc);
    const split = computeSplit(inbound, config.marginBps);
    assertSplitInvariant(split);
    if (split.inbound === 0n) {
      checklist.warn("pricing", "inbound price is zero — the gateway would serve for free");
      return;
    }
    checklist.pass(
      "pricing",
      `in ${atomicToWire(split.inbound)} (${formatUsd(split.inbound)}) = ` +
        `payout ${atomicToWire(split.payout)} + margin ${atomicToWire(split.margin)} atomic USDC`,
    );
  } catch (e) {
    checklist.fail("pricing", errorMessage(e));
  }
}

/** Flags a public base URL that no external client could pay a challenge against. */
function checkPublicUrl(checklist: Checklist, config: GatewayConfig): void {
  const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(
    config.publicBaseUrl,
  );
  if (!isLoopback) {
    checklist.pass("public base url", config.publicBaseUrl);
    return;
  }
  const message = `${config.publicBaseUrl} is loopback — remote clients cannot reach the resource declared in the 402 challenge`;
  if (toMeshNetwork(config.network) === "mainnet") checklist.fail("public base url", message);
  else checklist.warn("public base url", `${message} (fine for local development)`);
}

/** The hackathon requires the challenge tag; a missing one silently loses the submission. */
function checkChallengeTag(checklist: Checklist, config: GatewayConfig): void {
  if (config.challengeTag === REQUIRED_CHALLENGE_TAG) {
    checklist.pass("discovery tag", REQUIRED_CHALLENGE_TAG);
    return;
  }
  checklist.warn(
    "discovery tag",
    `X402_CHALLENGE_TAG is "${config.challengeTag}", expected "${REQUIRED_CHALLENGE_TAG}"`,
  );
}

/** Confirms the USDC asset id we would advertise comes from the SDK's table for this chain. */
function checkUsdcAsset(checklist: Checklist, config: GatewayConfig): string | undefined {
  try {
    const assetId = usdcAssetId(config.network);
    checklist.pass("usdc asset", `ASA ${assetId} (6 decimals) on ${config.network}`);
    return assetId;
  } catch (e) {
    checklist.fail("usdc asset", errorMessage(e));
    return undefined;
  }
}

/**
 * Checks the facilitator is live and actually settles the configured chain.
 *
 * The live facilitator advertises networks using the *full padded* genesis hash while the SDK
 * constants use the *truncated* form. They name the same chain, so every advertised network is
 * pushed through `normalizeNetwork` before comparison — a raw string comparison here reports a
 * perfectly good facilitator as unsupported.
 */
async function checkFacilitator(checklist: Checklist, config: GatewayConfig): Promise<void> {
  const url = `${config.facilitatorUrl}/supported`;
  let supported: SupportedResponse;
  try {
    supported = await httpJson<SupportedResponse>(url);
    checklist.pass("facilitator reachable", config.facilitatorUrl);
  } catch (e) {
    checklist.fail("facilitator reachable", `${url}: ${errorMessage(e)}`);
    return;
  }

  const kinds = supported.kinds ?? [];
  if (kinds.length === 0) {
    checklist.fail("facilitator kinds", "/supported returned no kinds");
    return;
  }

  const matches = kinds.filter(
    (kind) =>
      kind.x402Version === 2 &&
      kind.scheme === "exact" &&
      isSupportedNetwork(kind.network) &&
      normalizeNetwork(kind.network) === config.network,
  );

  if (matches.length === 0) {
    const algorandKinds = kinds
      .filter((k) => k.network.startsWith("algorand:"))
      .map((k) => `${k.scheme}@${k.network}`)
      .join(", ");
    checklist.fail(
      "facilitator supports network",
      `no exact/v2 kind for ${config.network}` +
        (algorandKinds === "" ? "" : `; it advertises: ${algorandKinds}`),
    );
    return;
  }
  checklist.pass("facilitator supports network", `exact @ ${config.network} (x402Version 2)`);

  const feePayer = matches
    .map((kind) => kind.extra?.["feePayer"])
    .find((value): value is string => typeof value === "string" && value.length > 0);
  if (feePayer === undefined) {
    checklist.warn(
      "gasless sponsorship",
      "facilitator advertises no feePayer for this chain — clients must fund their own ALGO fee",
    );
  } else if (!avm.isValidAlgorandAddress(feePayer)) {
    checklist.fail("gasless sponsorship", `facilitator feePayer is not a valid address`);
  } else {
    checklist.pass("gasless sponsorship", `fee payer ${feePayer}`);
  }
}

/** Result of inspecting one on-chain account. */
interface AccountCheckInput {
  label: string;
  address: string;
  /** True when this account must be able to *send* USDC, not merely receive it. */
  needsOutboundFunds: boolean;
}

/**
 * Verifies an account exists, meets its minimum balance and has opted in to USDC.
 *
 * The opt-in is the load-bearing check: Algorand accounts cannot receive an asset they have
 * not opted into, so a missing opt-in turns every payment or payout into an on-chain rejection
 * that only shows up at settlement time.
 */
async function checkAccount(
  checklist: Checklist,
  algod: AlgodConfig,
  network: MeshNetwork,
  assetId: string,
  target: AccountCheckInput,
): Promise<void> {
  const { label, address } = target;
  let account;
  try {
    account = await fetchAccount(algod, address);
  } catch (e) {
    checklist.fail(`${label} on chain`, errorMessage(e));
    return;
  }

  if (account === undefined) {
    checklist.fail(
      `${label} funded`,
      `${address} does not exist on ${network} yet — send it ALGO to create it`,
    );
    checklist.fail(`${label} usdc opt-in`, "account does not exist");
    return;
  }

  const balance = BigInt(account.amount);
  const required = BASE_MBR_MICRO_ALGO + PER_ASSET_MBR_MICRO_ALGO;
  if (balance < required) {
    checklist.fail(
      `${label} funded`,
      `${formatAlgo(balance)} — needs at least ${formatAlgo(required)} ` +
        `(0.1 base + 0.1 per opted-in asset) plus fees`,
    );
  } else {
    checklist.pass(`${label} funded`, formatAlgo(balance));
  }

  const position = assetPosition(account, assetId);
  if (!position.optedIn) {
    checklist.fail(
      `${label} usdc opt-in`,
      `${address} has not opted in to ASA ${assetId}; it cannot receive USDC. ` +
        `Opt in with a zero-amount asset transfer to itself.`,
    );
    return;
  }
  if (position.frozen) {
    checklist.fail(`${label} usdc opt-in`, "holding is frozen by the asset manager");
    return;
  }
  const held = `${atomicToWire(position.balanceAtomic)} atomic (${formatUsd(position.balanceAtomic)})`;
  if (target.needsOutboundFunds && position.balanceAtomic === 0n) {
    checklist.warn(`${label} usdc opt-in`, `opted in, but holds no USDC — it cannot pay yet`);
    return;
  }
  checklist.pass(`${label} usdc opt-in`, `ASA ${assetId}, holding ${held}`);
}

/**
 * Derives the operator address from `AVM_PRIVATE_KEY` without ever logging the key.
 *
 * Returns `undefined` when the variable is absent, which is legitimate: a gateway-only
 * deployment has no operator key.
 */
function deriveOperatorAddress(checklist: Checklist): string | undefined {
  const raw = process.env["AVM_PRIVATE_KEY"]?.trim();
  if (raw === undefined || raw.length === 0) {
    checklist.skip("operator key", "AVM_PRIVATE_KEY not set (gateway-only deployment)");
    return undefined;
  }
  if (Buffer.from(raw, "base64").length !== 64) {
    checklist.fail("operator key", "AVM_PRIVATE_KEY must be base64 of a 64-byte Algorand key");
    return undefined;
  }
  try {
    const address = avm.toClientAvmSigner(raw).address;
    checklist.pass("operator key", `derives ${address}`);
    return address;
  } catch (e) {
    // Deliberately does not echo the value, only why it could not be used.
    checklist.fail("operator key", `could not derive an address: ${errorMessage(e)}`);
    return undefined;
  }
}

/** Opens a TCP connection to a Redis URL's host and port, with a short deadline. */
async function checkRedis(checklist: Checklist, redisUrl: string | undefined): Promise<void> {
  if (redisUrl === undefined) {
    checklist.skip("redis", "REDIS_URL not set — using the in-memory registry");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    checklist.fail("redis", "REDIS_URL is not a valid URL");
    return;
  }
  const port = parsed.port === "" ? 6379 : Number(parsed.port);
  const host = parsed.hostname;
  const reachable = await new Promise<string | undefined>((resolve) => {
    const socket = createConnection({ host, port });
    const done = (result?: string): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(3_000);
    socket.once("connect", () => done(undefined));
    socket.once("timeout", () => done("connection timed out"));
    socket.once("error", (e: Error) => done(e.message));
  });
  if (reachable === undefined) checklist.pass("redis", `${host}:${port} accepting connections`);
  else checklist.fail("redis", `${host}:${port} ${reachable}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) {
    printUsage();
    return 0;
  }

  const networkOverride = args.options.get("network");
  if (
    networkOverride !== undefined &&
    networkOverride !== "mainnet" &&
    networkOverride !== "testnet"
  ) {
    process.stderr.write(`${style.red("error")}: --network must be "mainnet" or "testnet"\n`);
    return 2;
  }

  const checklist = new Checklist("x402 mesh preflight");
  const config = loadConfig(checklist, networkOverride as MeshNetwork | undefined);

  if (config === undefined) {
    info("");
    info("Fix the configuration above, then re-run. See .env.example for every variable.");
    return checklist.summarize();
  }

  checkPricing(checklist, config);
  checkPublicUrl(checklist, config);
  checkChallengeTag(checklist, config);
  const assetId = checkUsdcAsset(checklist, config);
  await checkFacilitator(checklist, config);
  await checkRedis(checklist, config.redisUrl);

  const operatorAddress = deriveOperatorAddress(checklist);
  const network = toMeshNetwork(config.network);

  if (args.flags.has("skip-chain")) {
    checklist.skip("on-chain checks", "--skip-chain");
  } else if (assetId === undefined) {
    checklist.skip("on-chain checks", "USDC asset id could not be resolved");
  } else {
    const algod = resolveAlgod(network);
    try {
      const status = await algodStatus(algod);
      checklist.pass("algod reachable", `${algod.url} at round ${status.lastRound.toString(10)}`);
      const targets: AccountCheckInput[] = [
        { label: "payTo account", address: config.payToAddress, needsOutboundFunds: true },
      ];
      if (operatorAddress !== undefined && operatorAddress !== config.payToAddress) {
        targets.push({
          label: "operator account",
          address: operatorAddress,
          needsOutboundFunds: false,
        });
      }
      for (const target of targets) {
        await checkAccount(checklist, algod, network, assetId, target);
      }
    } catch (e) {
      checklist.fail("algod reachable", `${algod.url}: ${errorMessage(e)}`);
    }
  }

  if (checklist.failed) {
    heading("How to fix the failures above");
    info(`Network            ${network} (${config.network})`);
    info(`payTo              ${config.payToAddress}`);
    info(`                   ${accountExplorerLink(network, config.payToAddress)}`);
    if (operatorAddress !== undefined) {
      info(`operator           ${operatorAddress}`);
      info(`                   ${accountExplorerLink(network, operatorAddress)}`);
    }
    for (const hint of faucetHints(network)) info(`                   ${hint}`);
    info("");
    info("Generate a fresh account with `npm run keygen`; it prints the opt-in steps.");
  }

  return checklist.summarize();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    const message = e instanceof MeshError ? e.message : errorMessage(e);
    process.stderr.write(`\n${style.red("preflight crashed")}: ${message}\n`);
    process.exitCode = 1;
  });
