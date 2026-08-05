import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayConfig } from "@x402-mesh/shared";
import {
  atomicToWire,
  facilitatorNetwork,
  priceTiers,
  usdcAssetId,
  usdcToAtomic,
} from "@x402-mesh/shared";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { Router } from "express";
import type { Logger } from "../logger.js";
import {
  discoveryTags,
  EXAMPLE_REQUEST,
  EXAMPLE_RESPONSE,
  ICON_PATH,
  maxTimeoutSeconds,
  PAID_ROUTE_PATH,
  pricingTable,
  resourceUrl,
  SERVICE_DESCRIPTION,
  SERVICE_NAME,
} from "../x402/routes.js";

/**
 * Agent-facing discovery surface: `GET /.well-known/x402` and `GET /llms.txt`.
 *
 * Both are free — an agent must be able to learn the price before it can pay it — and both
 * are rendered from live configuration rather than served as static text. A manifest that
 * advertised a stale price or a stale `payTo` address would send clients' money to the wrong
 * account, so the deployment's real values always win over anything checked into `spec/`.
 *
 * `spec/well-known-x402.json` and `spec/llms.txt`, when present, act as *templates*: their
 * prose and structure are preserved, their placeholder origin and payment fields are
 * substituted. When absent, an equivalent document is generated from the route config.
 */

/** Origin used as a placeholder in the checked-in spec templates. */
const TEMPLATE_ORIGIN = "https://mesh.example.com";

/** Files looked up under the repository's `spec/` directory. */
const MANIFEST_FILE = "well-known-x402.json";
const LLMS_FILE = "llms.txt";

/** Collaborators the discovery routes need. */
export interface DiscoveryRouteDeps {
  config: GatewayConfig;
  logger: Logger;
  /** Directory holding the spec templates. Defaults to the repository's `spec/`. */
  specDir?: string;
}

/** Builds the discovery router. */
export function createDiscoveryRouter(deps: DiscoveryRouteDeps): Router {
  const specDir = deps.specDir ?? findSpecDir();
  const router = Router();

  router.get("/.well-known/x402", (_req, res) => {
    const template = parseJsonTemplate(
      readTemplate(specDir, MANIFEST_FILE, deps.logger),
      deps.logger,
    );
    res.setHeader("cache-control", "public, max-age=60");
    res.status(200).json(buildManifest(deps.config, template));
  });

  router.get("/llms.txt", (_req, res) => {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=60");
    res.status(200).send(buildLlmsTxt(deps.config, readTemplate(specDir, LLMS_FILE, deps.logger)));
  });

  // Free by necessity: a client cannot decide whether a model is worth paying for until it
  // knows what that model costs, and the only alternative — one 402 probe per model — is a
  // round trip per price.
  router.get("/v1/pricing", (_req, res) => {
    const table = pricingTable(deps.config);
    res.setHeader("cache-control", "public, max-age=60");
    res.status(200).json({
      asset: usdcAssetId(deps.config.network),
      decimals: 6,
      network: deps.config.network,
      per: "request",
      default: {
        usdc: table.default,
        display: `$${table.default}`,
        atomic: atomicToWire(usdcToAtomic(table.default)),
      },
      models: table.models.map((m) => ({
        ...m,
        atomic: atomicToWire(usdcToAtomic(m.usdc)),
      })),
      note:
        "Models not listed are charged the default price. Prices are per request, not per " +
        "token. Send the model in the request body and the 402 challenge quotes its price.",
      resource: resourceUrl(deps.config),
    });
  });

  // Referenced by the Bazaar `iconUrl`, so it has to actually resolve.
  router.get(ICON_PATH, (_req, res) => {
    res.setHeader("content-type", "image/svg+xml");
    res.setHeader("cache-control", "public, max-age=86400");
    res.status(200).send(ICON_SVG);
  });

  return router;
}

/**
 * Renders the `/.well-known/x402` body.
 *
 * With a template: the placeholder origin is rewritten to the live public base URL, and
 * every payment-bearing field (`network`, `asset`, `amount`, `payTo`, `maxTimeoutSeconds`)
 * plus the tag list is overwritten with the running configuration. Prose, examples and
 * schema from the template survive untouched.
 *
 * Without a template: an equivalent document is generated.
 *
 * @param config - Live gateway configuration; always authoritative over the template.
 * @param template - Parsed template contents, or undefined.
 */
export function buildManifest(config: GatewayConfig, template?: unknown): Record<string, unknown> {
  const generated = generateManifest(config);
  if (!isRecord(template)) return generated;

  // Rewrite the placeholder origin everywhere it appears (resource URLs, doc links) in one
  // pass, rather than hunting for the individual fields that happen to carry it today.
  const rehomed = JSON.parse(
    JSON.stringify(template).split(TEMPLATE_ORIGIN).join(config.publicBaseUrl),
  ) as Record<string, unknown>;

  // `$comment` is a note to whoever maintains the template, not part of the served
  // contract. Leaving it in would ship instructions-to-ourselves to every agent that reads
  // the manifest — and the origin rewrite above would have mangled its prose anyway.
  delete rehomed["$comment"];

  rehomed["x402Version"] = 2;
  rehomed["lastUpdated"] = new Date().toISOString();

  const items = Array.isArray(rehomed["items"]) ? rehomed["items"] : [];
  rehomed["items"] = items.map((item) => (isRecord(item) ? patchManifestItem(item, config) : item));
  if (items.length === 0) rehomed["items"] = generated["items"];

  return rehomed;
}

/** Overwrites one manifest item's live payment fields. */
function patchManifestItem(
  item: Record<string, unknown>,
  config: GatewayConfig,
): Record<string, unknown> {
  const patched: Record<string, unknown> = {
    ...item,
    resource: resourceUrl(config),
    x402Version: 2,
    accepts: acceptsForDiscovery(config),
    pricing: modelPricingBlock(config),
    tags: discoveryTags(config),
    lastUpdated: new Date().toISOString(),
  };
  delete patched["$comment"];
  return patched;
}

/** Builds the manifest from the route configuration alone. */
function generateManifest(config: GatewayConfig): Record<string, unknown> {
  return {
    x402Version: 2,
    serviceName: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    iconUrl: `${config.publicBaseUrl}${ICON_PATH}`,
    items: [
      {
        resource: resourceUrl(config),
        type: "http",
        x402Version: 2,
        accepts: acceptsForDiscovery(config),
        pricing: modelPricingBlock(config),
        description: SERVICE_DESCRIPTION,
        mimeType: "application/json",
        serviceName: SERVICE_NAME,
        tags: discoveryTags(config),
        iconUrl: `${config.publicBaseUrl}${ICON_PATH}`,
        lastUpdated: new Date().toISOString(),
        extensions: declareDiscoveryExtension({
          bodyType: "json",
          input: EXAMPLE_REQUEST,
          output: { example: EXAMPLE_RESPONSE },
        }),
      },
    ],
  };
}

/**
 * The live `PaymentRequirements` an agent must satisfy.
 *
 * `amount` is the integer atomic-unit string the protocol expects — derived from the
 * configured decimal price through `usdcToAtomic`, never by multiplying a float.
 */
export function paymentRequirements(
  config: GatewayConfig,
  priceUsdc?: string,
): Record<string, unknown> {
  const quoted = priceUsdc ?? config.inboundPriceUsdc;
  return {
    scheme: "exact",
    // The facilitator-facing (full genesis hash) form, matching what the 402 challenge
    // carries. The manifest previously emitted the canonical truncated id, so a client that
    // configured itself from discovery matched the challenge's `network` verbatim, failed,
    // and got "No network/scheme registered for x402 version: 2" — the exact trap the
    // quickstart warns about, handed to the client by our own discovery document.
    network: facilitatorNetwork(config.network),
    asset: usdcAssetId(config.network),
    amount: atomicToWire(usdcToAtomic(quoted)),
    payTo: config.payToAddress,
    maxTimeoutSeconds: maxTimeoutSeconds(config),
    extra: { name: "USDC", decimals: 6 },
  };
}

/**
 * Every payment option the resource accepts — one per distinct price tier.
 *
 * A single entry was wrong the moment pricing became per-model: the manifest advertised the
 * flat fallback while the only model any node served cost three times that, so an agent
 * building its payment from discovery would sign the wrong amount and be re-challenged.
 * `accepts` is an array precisely so a resource can offer more than one requirement.
 *
 * The fallback is listed first, matching {@link priceTiers}. Which tier applies to a given
 * request is decided by the model in that request, so {@link modelPricingBlock} carries the
 * mapping and the per-request 402 challenge remains authoritative.
 */
export function acceptsForDiscovery(config: GatewayConfig): Record<string, unknown>[] {
  return priceTiers(config.modelPricesUsdc, config.inboundPriceUsdc).map((price) =>
    paymentRequirements(config, price),
  );
}

/**
 * The model → price mapping, attached to the manifest so `accepts` is interpretable.
 *
 * Without it a client sees several amounts and no rule for choosing between them.
 */
export function modelPricingBlock(config: GatewayConfig): Record<string, unknown> {
  const table = pricingTable(config);
  return {
    unit: "request",
    asset: usdcAssetId(config.network),
    decimals: 6,
    default: {
      usdc: table.default,
      amount: atomicToWire(usdcToAtomic(table.default)),
    },
    models: table.models.map((m) => ({
      model: m.model,
      usdc: m.usdc,
      amount: atomicToWire(usdcToAtomic(m.usdc)),
    })),
    endpoint: `${config.publicBaseUrl}/v1/pricing`,
    note:
      "Price is per request and depends on the requested model; models not listed are " +
      "charged the default. Send the model in the request body and the 402 challenge for " +
      "that request is authoritative.",
  };
}

/**
 * Renders `llms.txt`.
 *
 * When the checked-in template exists its prose is kept (it is written for agent crawlers
 * and is better than anything generated inline), with the placeholder origin rewritten and a
 * short live-configuration block appended so the served copy can never disagree with the
 * running gateway.
 */
export function buildLlmsTxt(config: GatewayConfig, template?: string): string {
  const live = liveBlock(config);
  if (template === undefined) return `${generatedLlmsTxt(config)}\n${live}`;
  return `${template.split(TEMPLATE_ORIGIN).join(config.publicBaseUrl).trimEnd()}\n\n${live}`;
}

/** Machine-checkable summary of the running configuration, appended to `llms.txt`. */
function liveBlock(config: GatewayConfig): string {
  const atomic = atomicToWire(usdcToAtomic(config.inboundPriceUsdc));
  return [
    "## Live configuration",
    "",
    "These values are read from the running gateway at request time and override anything",
    "above if they differ.",
    "",
    `- endpoint: ${resourceUrl(config)}`,
    `- price: $${config.inboundPriceUsdc} USDC per request (${atomic} atomic units, 6 decimals)`,
    ...(Object.keys(config.modelPricesUsdc).length > 0
      ? [
          "- perModelPricing: the price above applies to any model not listed below",
          ...pricingTable(config).models.map((m) => `  - ${m.model}: $${m.usdc} USDC`),
        ]
      : []),
    `- network: ${config.network} (${config.meshNetwork})`,
    `- asset: USDC ASA ${usdcAssetId(config.network)}`,
    `- payTo: ${config.payToAddress}`,
    `- scheme: exact`,
    `- facilitator: ${config.facilitatorUrl}`,
    `- maxTimeoutSeconds: ${maxTimeoutSeconds(config)}`,
    `- tags: ${discoveryTags(config).join(", ")}`,
    `- discovery: ${config.publicBaseUrl}/.well-known/x402`,
    `- pricingEndpoint: ${config.publicBaseUrl}/v1/pricing`,
    `- quickstart: ${config.publicBaseUrl}/quickstart (runnable client, no wallet needed to read)`,
    `- nodes: ${config.publicBaseUrl}/v1/nodes`,
    `- settlements: ${config.publicBaseUrl}/v1/settlements`,
    "",
  ].join("\n");
}

/** Fallback `llms.txt` body, used when no template is checked in. */
function generatedLlmsTxt(config: GatewayConfig): string {
  return [
    `# ${SERVICE_NAME}`,
    "",
    `> ${SERVICE_DESCRIPTION}`,
    "",
    "## Endpoint",
    "",
    `    POST ${resourceUrl(config)}`,
    "",
    'Request and response bodies are OpenAI-compatible. Set `"stream": true` for a',
    "`text/event-stream` response terminated by the literal frame `data: [DONE]`.",
    "",
    "## Paying",
    "",
    `Call ${PAID_ROUTE_PATH} without a payment header to receive \`402 Payment Required\`,`,
    "whose `accepts` array carries the exact requirements. Pay with an x402 client",
    "configured for the Algorand `exact` scheme; the facilitator sponsors the ALGO fee, so",
    "you sign only the USDC transfer. Your account must be opted in to the USDC ASA.",
    "",
    "## Example",
    "",
    "```json",
    JSON.stringify(EXAMPLE_REQUEST, null, 2),
    "```",
    "",
  ].join("\n");
}

/**
 * Reads a spec template as text, returning undefined when it is missing or unreadable.
 *
 * A missing template is a normal condition (a container may ship without the `spec/`
 * directory), so it is logged at debug and the generated fallback is used.
 */
function readTemplate(
  specDir: string | undefined,
  file: string,
  logger: Logger,
): string | undefined {
  if (specDir === undefined) return undefined;
  const path = join(specDir, file);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    logger.debug(
      { path, reason: error instanceof Error ? error.message : String(error) },
      "spec template unavailable; using generated document",
    );
    return undefined;
  }
}

/** Parses a JSON template, tolerating a malformed file by falling back to generation. */
function parseJsonTemplate(raw: string | undefined, logger: Logger): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    logger.warn(
      { file: MANIFEST_FILE, reason: error instanceof Error ? error.message : String(error) },
      "spec manifest is not valid JSON; serving the generated manifest instead",
    );
    return undefined;
  }
}

/**
 * Locates the repository's `spec/` directory.
 *
 * Walks up from this module and from the working directory, so the same code works when run
 * from source (`packages/gateway/src`), from a build (`packages/gateway/dist`) and from a
 * container whose working directory is the repository root.
 */
export function findSpecDir(): string | undefined {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(dir, "spec");
      try {
        readFileSync(join(candidate, MANIFEST_FILE), "utf8");
        return candidate;
      } catch {
        // Not here; keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minimal service icon, served at {@link ICON_PATH} so the Bazaar `iconUrl` resolves. */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="x402 Mesh">
<rect width="64" height="64" rx="12" fill="#0b1020"/>
<g fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round">
<path d="M16 44 L32 20 L48 44"/><path d="M22 34 L42 34"/>
</g>
<circle cx="32" cy="20" r="4" fill="#4ade80"/>
<circle cx="16" cy="44" r="4" fill="#38bdf8"/>
<circle cx="48" cy="44" r="4" fill="#38bdf8"/>
</svg>`;
