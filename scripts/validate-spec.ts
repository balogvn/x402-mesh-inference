/**
 * `npx tsx scripts/validate-spec.ts` — validate the published contract artefacts.
 *
 * The files under `spec/` are the interface every external agent and every Bazaar crawler
 * sees. Their failure modes are silent: a malformed OpenAPI document simply does not render, a
 * dangling `$ref` produces an empty schema in generated clients, and a discovery manifest whose
 * mandatory tag is dropped by the Bazaar sanitizer is indexed without ever being findable. None
 * of those show up in a unit test, so they are checked here and in CI.
 *
 * Checks performed:
 *   - `spec/openapi.yaml` parses, declares OpenAPI 3.1, exposes every documented path, has no
 *     unresolved internal `$ref`, and gives every operation an id and at least one response.
 *   - `spec/well-known-x402.json` names Algorand MainNet, quotes USDC at the id the SDK's own
 *     `USDC_CONFIG` reports, prices the resource at 2000 atomic units, carries a structurally
 *     valid `payTo`, keeps `x402-global-challenge` through `sanitizeTags`, and its `bazaar`
 *     block passes the SDK's own extension validator.
 *   - `spec/llms.txt` exists, is non-trivial, and states the price and the endpoint.
 *   - `.env.example` still parses and still satisfies both real configuration loaders.
 *
 * Exits 0 when everything is valid, 1 otherwise.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as avm from "@x402/avm";
import * as bazaar from "@x402/extensions/bazaar";
import { loadDaemonConfig, loadGatewayConfig } from "@x402-mesh/shared";
import { Checklist, errorMessage, parseArgs, style, wantsHelp } from "./lib/cli.js";

/**
 * `js-yaml` ships no bundled types and `@types/js-yaml` is not a dependency here, so it is
 * required through `createRequire` behind a minimal local interface. It resolves from the
 * locked dependency tree, which `npm ci` reproduces exactly, so this is deterministic.
 */
interface YamlModule {
  load(source: string): unknown;
}

/** Paths the gateway contract must document. Losing one silently breaks a client. */
const REQUIRED_PATHS = [
  "/v1/chat/completions",
  "/v1/nodes/register",
  "/v1/nodes/{nodeId}/heartbeat",
  "/v1/nodes",
  "/v1/settlements",
  "/healthz",
  "/readyz",
  "/.well-known/x402",
] as const;

/** The hackathon-mandated discovery tag. */
const CHALLENGE_TAG = "x402-global-challenge";

/** Price the manifest must quote, in atomic USDC units. */
const EXPECTED_AMOUNT_ATOMIC = "2000";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects every `$ref` string in a document, with the JSON pointer where it was found. */
function collectRefs(root: unknown): { ref: string; at: string }[] {
  const found: { ref: string; at: string }[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${at}/${i}`));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.push({ ref: value, at });
      else walk(value, `${at}/${key}`);
    }
  };
  walk(root, "#");
  return found;
}

/** Resolves a local JSON pointer, returning `undefined` when it dangles. */
function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cursor: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(cursor) || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function validateOpenApi(checklist: Checklist, yaml: YamlModule, path: string): void {
  let doc: unknown;
  try {
    doc = yaml.load(readFileSync(path, "utf8"));
  } catch (e) {
    checklist.fail("openapi parses", errorMessage(e));
    return;
  }
  if (!isRecord(doc)) {
    checklist.fail("openapi parses", "document is not a mapping");
    return;
  }
  checklist.pass("openapi parses", path);

  const version = String(doc["openapi"] ?? "");
  if (version.startsWith("3.1")) checklist.pass("openapi version", version);
  else checklist.fail("openapi version", `${version || "(absent)"} — expected 3.1.x`);

  const info = doc["info"];
  const hasInfo =
    isRecord(info) && typeof info["title"] === "string" && info["version"] !== undefined;
  if (hasInfo) checklist.pass("openapi info", String((info as Json)["title"]));
  else checklist.fail("openapi info", "info.title and info.version are both required");

  const paths = doc["paths"];
  if (!isRecord(paths)) {
    checklist.fail("openapi paths", "paths is missing");
    return;
  }
  const missing = REQUIRED_PATHS.filter((p) => !(p in paths));
  if (missing.length === 0) {
    checklist.pass("openapi paths", `${Object.keys(paths).length} documented`);
  } else {
    checklist.fail("openapi paths", `missing: ${missing.join(", ")}`);
  }

  const operationIds = new Set<string>();
  const problems: string[] = [];
  let operations = 0;
  for (const [route, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method) || !isRecord(operation)) continue;
      operations += 1;
      const id = operation["operationId"];
      if (typeof id !== "string" || id.length === 0) {
        problems.push(`${method.toUpperCase()} ${route}: no operationId`);
      } else if (operationIds.has(id)) {
        problems.push(`duplicate operationId ${id}`);
      } else {
        operationIds.add(id);
      }
      const responses = operation["responses"];
      if (!isRecord(responses) || Object.keys(responses).length === 0) {
        problems.push(`${method.toUpperCase()} ${route}: no responses`);
      }
    }
  }
  if (problems.length === 0) checklist.pass("openapi operations", `${operations} operations`);
  else checklist.fail("openapi operations", problems.join("; "));

  const refs = collectRefs(doc);
  const dangling = refs.filter(({ ref }) => resolveRef(doc, ref) === undefined);
  if (dangling.length === 0) {
    checklist.pass("openapi $refs", `${refs.length} resolved`);
  } else {
    checklist.fail("openapi $refs", dangling.map(({ ref, at }) => `${ref} (at ${at})`).join("; "));
  }
}

function validateManifest(checklist: Checklist, path: string): void {
  let manifest: Json;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch (e) {
    checklist.fail("manifest parses", errorMessage(e));
    return;
  }
  checklist.pass("manifest parses", path);

  if (manifest["x402Version"] === 2) checklist.pass("manifest x402Version", "2");
  else checklist.fail("manifest x402Version", `${String(manifest["x402Version"])} — expected 2`);

  const items = manifest["items"];
  const item = Array.isArray(items) ? items[0] : undefined;
  if (!isRecord(item)) {
    checklist.fail("manifest items[0]", "missing");
    return;
  }

  const accepts = Array.isArray(item["accepts"]) ? item["accepts"][0] : undefined;
  if (!isRecord(accepts)) {
    checklist.fail("manifest accepts[0]", "missing");
    return;
  }

  if (accepts["scheme"] === "exact") checklist.pass("manifest scheme", "exact");
  else checklist.fail("manifest scheme", `${String(accepts["scheme"])} — expected "exact"`);

  let canonical: string | undefined;
  try {
    canonical = avm.normalizeAlgorandNetwork(String(accepts["network"]));
  } catch (e) {
    checklist.fail("manifest network", errorMessage(e));
  }
  if (canonical !== undefined) {
    if (canonical === avm.ALGORAND_MAINNET_CAIP2) {
      checklist.pass("manifest network", `${String(accepts["network"])} -> MainNet`);
    } else {
      checklist.fail("manifest network", `${canonical} is not Algorand MainNet`);
    }
    const usdc = avm.USDC_CONFIG[canonical];
    if (usdc === undefined) {
      checklist.fail("manifest asset", `no USDC configured for ${canonical}`);
    } else if (accepts["asset"] === usdc.asaId) {
      checklist.pass("manifest asset", `USDC ASA ${usdc.asaId} (${usdc.decimals} decimals)`);
    } else {
      checklist.fail("manifest asset", `${String(accepts["asset"])} — expected ${usdc.asaId}`);
    }
  }

  if (accepts["amount"] === EXPECTED_AMOUNT_ATOMIC) {
    checklist.pass("manifest amount", `${EXPECTED_AMOUNT_ATOMIC} atomic USDC ($0.0020)`);
  } else {
    checklist.fail(
      "manifest amount",
      `${String(accepts["amount"])} — expected ${EXPECTED_AMOUNT_ATOMIC} atomic units`,
    );
  }

  const payTo = String(accepts["payTo"] ?? "");
  if (avm.isValidAlgorandAddress(payTo)) checklist.pass("manifest payTo", payTo);
  else checklist.fail("manifest payTo", `${payTo || "(absent)"} is not a valid Algorand address`);

  // sanitizeTags keeps only the FIRST few entries, so the mandatory tag has to survive
  // truncation, not merely appear somewhere in the list.
  const kept = bazaar.sanitizeTags(item["tags"]) ?? [];
  if (kept.includes(CHALLENGE_TAG)) {
    checklist.pass("manifest challenge tag", `survives sanitizeTags: ${kept.join(", ")}`);
  } else {
    checklist.fail(
      "manifest challenge tag",
      `"${CHALLENGE_TAG}" is dropped by sanitizeTags; kept: ${kept.join(", ") || "(none)"}`,
    );
  }

  const serviceName = item["serviceName"];
  if (typeof serviceName === "string" && bazaar.isValidServiceName(serviceName)) {
    checklist.pass("manifest serviceName", serviceName);
  } else {
    checklist.warn("manifest serviceName", "absent or rejected by the Bazaar sanitizer");
  }

  const extensions = item["extensions"];
  const bazaarBlock = isRecord(extensions) ? extensions["bazaar"] : undefined;
  if (bazaarBlock === undefined) {
    checklist.fail("manifest bazaar extension", "extensions.bazaar is missing");
    return;
  }
  // The validator's job is to decide whether this untrusted JSON is a DiscoveryExtension, so
  // the cast is the question being asked rather than an assertion about the answer.
  const validation = bazaar.validateDiscoveryExtension(
    bazaarBlock as Parameters<typeof bazaar.validateDiscoveryExtension>[0],
  );
  if (validation.valid) checklist.pass("manifest bazaar extension", "validates against the SDK");
  else checklist.fail("manifest bazaar extension", JSON.stringify(validation));
}

function validateLlmsTxt(checklist: Checklist, path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    checklist.fail("llms.txt", errorMessage(e));
    return;
  }
  const problems: string[] = [];
  if (text.length < 500) problems.push("suspiciously short");
  if (!text.includes("/v1/chat/completions")) problems.push("does not name the paid endpoint");
  if (!text.includes("2000")) problems.push("does not state the atomic price");
  if (!text.includes("/.well-known/x402")) problems.push("does not link the discovery manifest");
  if (problems.length === 0) checklist.pass("llms.txt", `${text.length} characters`);
  else checklist.fail("llms.txt", problems.join("; "));
}

/**
 * Checks `.env.example` is still a complete, loadable description of the environment.
 *
 * It is documentation that goes stale silently: a variable added to a config loader but not to
 * the example leaves operators guessing, and an example that no longer parses sends them down
 * a debugging path that has nothing to do with their deployment. Feeding the file through the
 * real loaders catches both.
 */
function validateEnvExample(checklist: Checklist, path: string): void {
  let env: NodeJS.ProcessEnv;
  try {
    env = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match?.[1] !== undefined) env[match[1]] = match[2] ?? "";
    }
  } catch (e) {
    checklist.fail(".env.example readable", errorMessage(e));
    return;
  }
  const count = Object.keys(env).length;
  if (count === 0) {
    checklist.fail(".env.example readable", "no uncommented assignments found");
    return;
  }
  checklist.pass(".env.example readable", `${count} variables`);

  try {
    const gateway = loadGatewayConfig(env);
    checklist.pass(".env.example loads as gateway config", `network ${gateway.network}`);
  } catch (e) {
    checklist.fail(".env.example loads as gateway config", errorMessage(e));
  }
  try {
    const daemon = loadDaemonConfig(env);
    checklist.pass(".env.example loads as daemon config", `node ${daemon.nodeId}`);
  } catch (e) {
    checklist.fail(".env.example loads as daemon config", errorMessage(e));
  }
}

function printUsage(): void {
  process.stdout.write(`
${style.bold("validate-spec")} — check the contract artefacts under spec/

  npx tsx scripts/validate-spec.ts [--help]

Exits 0 when spec/openapi.yaml, spec/well-known-x402.json and spec/llms.txt are all valid.
`);
}

/**
 * Checks that each container image starts a long-running process rather than exiting.
 *
 * The node daemon's CLI is a commander program with no default action: invoking `cli.js`
 * with no subcommand prints usage and exits 1. A Dockerfile whose CMD omitted `start`
 * therefore produced a container that crash-looped while the gateway answered
 * `503 no_capacity` for every paid request — a broken demo whose only symptom was a help
 * screen in the container logs. Cheap to assert, expensive to rediscover.
 *
 * @param checklist - Collector for pass/fail lines.
 */
function validateDockerEntrypoints(checklist: Checklist): void {
  const daemonPath = "docker/Dockerfile.node-daemon";
  let daemon: string;
  try {
    daemon = readFileSync(daemonPath, "utf8");
  } catch (e) {
    checklist.fail("daemon dockerfile", errorMessage(e));
    return;
  }
  const cmd = /^CMD\s+(\[.*\])\s*$/m.exec(daemon)?.[1];
  if (cmd === undefined) {
    checklist.fail("daemon dockerfile CMD", `no exec-form CMD found in ${daemonPath}`);
    return;
  }
  const SUBCOMMANDS = ["start", "register", "doctor", "address"];
  const named = SUBCOMMANDS.filter((c) => cmd.includes(`"${c}"`));
  if (named.length === 0) {
    checklist.fail(
      "daemon dockerfile CMD",
      `${cmd} names no subcommand — the container will print usage and exit 1`,
    );
  } else {
    checklist.pass("daemon dockerfile CMD", `runs \`${named.join(", ")}\``);
  }

  // The HEALTHCHECK must probe a path the daemon actually serves. It probed /healthz while
  // the daemon serves /health, so every container reported unhealthy forever — orchestrators
  // restart-loop on that, and compose `depends_on: service_healthy` never releases.
  const served = /path === "(\/[a-z]+)"/g;
  let serverSrc = "";
  try {
    serverSrc = readFileSync("packages/node-daemon/src/server.ts", "utf8");
  } catch {
    /* checked below via the empty route set */
  }
  const routes = new Set<string>();
  for (const m of serverSrc.matchAll(served)) if (m[1] !== undefined) routes.add(m[1]);
  const probed = /pathname='([^']+)'/.exec(daemon)?.[1];
  if (probed === undefined) {
    checklist.fail("daemon healthcheck path", "no HEALTHCHECK pathname found");
  } else if (routes.size === 0) {
    checklist.fail("daemon healthcheck path", "could not read the daemon's routes to compare");
  } else if (!routes.has(probed)) {
    checklist.fail(
      "daemon healthcheck path",
      `HEALTHCHECK probes ${probed} but the daemon serves ${[...routes].join(", ")}`,
    );
  } else {
    checklist.pass("daemon healthcheck path", `${probed} is served`);
  }

  // The gateway routes paid work to `${node.endpoint}${NODE_CHAT_PATH}`. If the daemon does
  // not serve that exact path, every paid request dies with `node returned HTTP 404` — which
  // is precisely what happened in production. No unit test caught it, because the mock node
  // implements the gateway's contract while the real daemon implemented a different one.
  try {
    const routerSrc = readFileSync("packages/gateway/src/services/router.ts", "utf8");
    const daemonSrc = readFileSync("packages/node-daemon/src/server.ts", "utf8");
    const called = /NODE_CHAT_PATH\s*=\s*"([^"]+)"/.exec(routerSrc)?.[1];
    if (called === undefined) {
      checklist.fail("node inference path", "could not read NODE_CHAT_PATH from the router");
    } else if (!daemonSrc.includes(`"${called}"`)) {
      checklist.fail(
        "node inference path",
        `gateway calls ${called} but packages/node-daemon/src/server.ts does not serve it`,
      );
    } else {
      checklist.pass("node inference path", `gateway and daemon agree on ${called}`);
    }
  } catch (e) {
    checklist.fail("node inference path", errorMessage(e));
  }

  const gatewayPath = "docker/Dockerfile.gateway";
  try {
    const gateway = readFileSync(gatewayPath, "utf8");
    if (/^CMD\s+\[.*server\.js.*\]\s*$/m.test(gateway)) {
      checklist.pass("gateway dockerfile CMD", "runs the server entrypoint");
    } else {
      checklist.fail("gateway dockerfile CMD", `${gatewayPath} does not start server.js`);
    }
  } catch (e) {
    checklist.fail("gateway dockerfile", errorMessage(e));
  }
}

/**
 * Checks that the e2e scripts share one x402 client implementation.
 *
 * e2e-simulate.ts and e2e-mainnet.ts each once hand-rolled the challenge read and the client
 * scheme registration, and both copies were wrong in the same two ways. The fixes went to the
 * simulation script and never reached the MainNet script — the one that cannot be casually
 * re-run — so both bugs were rediscovered live, with real money staged.
 *
 * Deduplication is the actual fix; this asserts it stays deduplicated. A future edit that
 * reaches for the SDK directly in either script fails here rather than on MainNet.
 *
 * @param checklist - Collector for pass/fail lines.
 */
function validateSharedX402Client(checklist: Checklist): void {
  // Calls that must only ever appear in the shared module.
  const FORBIDDEN = ["x402Client()", "encodePaymentSignatureHeader", "decodePaymentRequiredHeader"];
  const SCRIPTS = ["scripts/e2e-simulate.ts", "scripts/e2e-mainnet.ts"];
  const SHARED = "scripts/lib/x402-client.ts";

  try {
    readFileSync(SHARED, "utf8");
  } catch {
    checklist.fail("shared x402 client", `${SHARED} is missing`);
    return;
  }

  const offenders: string[] = [];
  for (const path of SCRIPTS) {
    let src: string;
    try {
      src = readFileSync(path, "utf8");
    } catch (e) {
      checklist.fail("shared x402 client", `${path}: ${errorMessage(e)}`);
      return;
    }
    for (const call of FORBIDDEN) {
      if (src.includes(call)) offenders.push(`${path} calls ${call} directly`);
    }
  }

  if (offenders.length > 0) {
    checklist.fail("shared x402 client", offenders.join("; "));
  } else {
    checklist.pass("shared x402 client", `${SCRIPTS.length} scripts route through ${SHARED}`);
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) {
    printUsage();
    return 0;
  }

  const checklist = new Checklist("spec validation");
  const require = createRequire(import.meta.url);
  let yaml: YamlModule;
  try {
    yaml = require("js-yaml") as YamlModule;
  } catch {
    checklist.fail("yaml parser", "js-yaml is not resolvable — run `npm ci` first");
    return checklist.summarize();
  }

  validateOpenApi(checklist, yaml, "spec/openapi.yaml");
  validateManifest(checklist, "spec/well-known-x402.json");
  validateLlmsTxt(checklist, "spec/llms.txt");
  validateEnvExample(checklist, ".env.example");
  validateDockerEntrypoints(checklist);
  validateSharedX402Client(checklist);
  return checklist.summarize();
}

process.exitCode = main();
