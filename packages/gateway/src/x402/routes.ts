import type { GatewayConfig } from "@x402-mesh/shared";
import { atomicToWire, facilitatorNetwork, usdcAssetId, usdcToAtomic } from "@x402-mesh/shared";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { ResourceConfig, RouteConfig, RoutesConfig } from "@x402/core/server";

/**
 * The x402 route table and the Bazaar discovery metadata attached to it.
 *
 * This module is the gateway's shop window: an autonomous agent that has never seen this
 * service discovers it through the Bazaar catalog, reads the declaration produced here, and
 * must be able to construct a valid paid request from that alone. So the declaration carries
 * a *realistic* example request and response, not a schema sketch.
 */

/** The single paid route. The key format is `"<METHOD> <path>"`, matched by the middleware. */
export const PAID_ROUTE_KEY = "POST /v1/chat/completions";

/** Path component of {@link PAID_ROUTE_KEY}, for mounting the Express handler. */
export const PAID_ROUTE_PATH = "/v1/chat/completions";

/**
 * Second path serving the same paid capability.
 *
 * Not decoration. The Bazaar catalog snapshots a resource's `accepts` the first time it sees
 * it and never refreshes them: this service was first indexed before the challenge tag was in
 * `extra`, and eight subsequent settlements carrying the tag incremented its counter without
 * touching the frozen snapshot. A resource the catalog has not seen before is indexed fresh,
 * tag included, and a distinct path is the cheapest way to be that resource.
 *
 * It is a genuine endpoint, not a trick: same handler, same price, same guards, same
 * settlement. `/v1/chat/completions` stays the canonical OpenAI-compatible path and keeps
 * working — every client and the published quickstart continue to target it.
 */
export const PAID_ROUTE_ALIAS_PATH = "/v1/inference";

/** Route key for {@link PAID_ROUTE_ALIAS_PATH}. */
export const PAID_ROUTE_ALIAS_KEY = "POST /v1/inference";

/** Every path that is paywalled and routes to the inference handler. */
export const PAID_ROUTE_PATHS = [PAID_ROUTE_PATH, PAID_ROUTE_ALIAS_PATH] as const;

/** Path the gateway serves its icon from, referenced by the discovery metadata. */
export const ICON_PATH = "/static/icon.svg";

/** Human-facing service name carried into the Bazaar catalog. */
export const SERVICE_NAME = "x402 Mesh Inference";

/** One-line description an agent sees in catalog listings. */
export const SERVICE_DESCRIPTION =
  "Pay-per-prompt OpenAI-compatible chat completions routed across a mesh of independent " +
  "GPU nodes, settled in USDC on Algorand via x402.";

/**
 * Example request body advertised for discovery.
 *
 * Kept genuinely runnable — an agent that copies this verbatim and pays gets a completion.
 */
export const EXAMPLE_REQUEST = {
  model: "llama3.1:8b",
  messages: [
    { role: "system", content: "You are a concise assistant." },
    { role: "user", content: "Summarise the x402 payment protocol in one sentence." },
  ],
  max_tokens: 128,
  temperature: 0.2,
  stream: false,
} as const;

/** Example (non-streaming) response body advertised for discovery. */
export const EXAMPLE_RESPONSE = {
  id: "chatcmpl-9f2b1c4a6d7e",
  object: "chat.completion",
  created: 1_767_225_600,
  model: "llama3.1:8b",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content:
          "x402 revives HTTP 402 so a client can pay for a request inline, with a " +
          "facilitator verifying and settling the payment on-chain.",
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 28, completion_tokens: 31, total_tokens: 59 },
} as const;

/**
 * Discovery tags in addition to the mandatory challenge tag.
 *
 * Exactly four, because the Bazaar's `sanitizeTags` keeps only the **first five** tags and
 * silently drops the rest — listing more would push a tag off the end with no diagnostic.
 * The challenge tag is prepended by {@link discoveryTags}, so it can never be the one lost.
 * Short, lowercase and hyphenated so each also survives the per-tag filter.
 */
const DISCOVERY_TAGS = ["ai-inference", "llm", "openai-compatible", "algorand"] as const;

/** Hard ceiling the Bazaar applies to `tags`; mirrored here so the invariant is checkable. */
export const MAX_DISCOVERY_TAGS = 5;

/**
 * Payment validity window advertised to clients.
 *
 * Must comfortably exceed the time the gateway may hold the request open, otherwise a slow
 * but successful inference would settle against an expired authorization. One minute of
 * headroom on top of the upstream timeout, floored at 60s.
 */
export function maxTimeoutSeconds(config: GatewayConfig): number {
  return Math.max(60, Math.ceil(config.nodeRequestTimeoutMs / 1000) + 60);
}

/** Absolute URL of the paid resource, as advertised in discovery. */
export function resourceUrl(config: GatewayConfig): string {
  return `${config.publicBaseUrl}${PAID_ROUTE_PATH}`;
}

/**
 * Price string in x402 `Money` form, e.g. `"$0.0020"`.
 *
 * @param priceUsdc - Overrides the flat configured price; supplied when building a
 * per-model tier. Defaults to {@link GatewayConfig.inboundPriceUsdc}.
 */
export function priceString(config: GatewayConfig, priceUsdc?: string): string {
  return `$${priceUsdc ?? config.inboundPriceUsdc}`;
}

/**
 * The per-model price table as an agent-readable object, cheapest first.
 *
 * Advertised in the 402 preview and served from `GET /v1/pricing`, because a client that
 * cannot see prices before paying has to probe one model at a time to find out what anything
 * costs.
 */
export function pricingTable(config: GatewayConfig): {
  default: string;
  models: { model: string; usdc: string; display: string }[];
} {
  const models = Object.entries(config.modelPricesUsdc)
    .map(([model, usdc]) => ({ model, usdc, display: `$${usdc}` }))
    .sort((a, b) => (usdcToAtomic(a.usdc) < usdcToAtomic(b.usdc) ? -1 : 1));
  return { default: config.inboundPriceUsdc, models };
}

/**
 * Tag list for the paid route: the mandatory challenge tag first, then the descriptive set,
 * truncated to what the Bazaar will actually keep.
 */
export function discoveryTags(config: GatewayConfig): string[] {
  return [config.challengeTag, ...DISCOVERY_TAGS].slice(0, MAX_DISCOVERY_TAGS);
}

/**
 * The single {@link ResourceConfig} clients pay against.
 *
 * `network` is the facilitator-facing (full genesis hash) identifier, because the SDK checks
 * a route's network against the facilitator's `/supported` list verbatim at startup. Asset
 * resolution still keys off the canonical id — see {@link facilitatorNetwork}.
 */
export function buildPaymentOption(config: GatewayConfig, priceUsdc?: string): ResourceConfig {
  return {
    scheme: "exact",
    payTo: config.payToAddress,
    price: priceString(config, priceUsdc),
    network: facilitatorNetwork(config.network),
    maxTimeoutSeconds: maxTimeoutSeconds(config),
    extra: challengeExtra(config),
  };
}

/**
 * `extra` on the payment requirement, carrying the challenge tag.
 *
 * The tag has to be **here**, not in the route's `tags` array. Both exist, both are called
 * tags, and only this one puts a resource on the challenge leaderboard: the Bazaar catalog
 * reads `accepts[].extra.tag`, while `tags` is descriptive discovery metadata that the
 * leaderboard filter never looks at. Verified against the live catalog — every entry the
 * hackathon filter shows carries `extra.tag`, and this service, which had the tag only in
 * `tags`, was absent from it while still appearing in the general catalog.
 *
 * Returned as the route's **baseline** `extra`. The AVM scheme merges its own `feePayer` in
 * during `enrichPaymentRequiredResponse`, which is additive — so both survive to the wire.
 * That is asserted in tests rather than assumed, because a scheme that replaced `extra`
 * instead of merging would silently drop the tag again.
 */
export function challengeExtra(config: GatewayConfig): Record<string, unknown> {
  // `asset` alongside `tag`, both required. Confirmed by the organisers and by the catalog:
  // all 57 entries the challenge filter shows carry both, and this service — which carried
  // only `tag` — was in the general Bazaar and absent from the challenge one. The scheme
  // already resolves the asset for settlement, so this is redundant to the protocol and load
  // bearing for discovery, which is exactly the kind of duplication that is easy to miss.
  return { asset: usdcAssetId(config.network), tag: config.challengeTag };
}

/**
 * Builds the x402 `RoutesConfig` guarding `POST /v1/chat/completions`.
 *
 * `extensions` receives the return of `declareDiscoveryExtension` **directly**: that helper
 * already returns a record keyed `{ bazaar: … }`, so wrapping it again produces
 * `{ bazaar: { bazaar: … } }` and the route silently stops being discoverable. `method` is
 * deliberately not passed — the server extension fills it in from the route key, and
 * supplying it is a type error.
 *
 * @param config - Resolved gateway configuration; price, network and payTo all come from it.
 * @param priceUsdc - Price this instance quotes. The gateway builds one routes config per
 * distinct price tier so that a 402 quotes the price of the model actually requested;
 * omitted, it quotes the flat configured price.
 */
export function buildRoutesConfig(config: GatewayConfig, priceUsdc?: string): RoutesConfig {
  const route = (path: string): RouteConfig => ({
    accepts: buildPaymentOption(config, priceUsdc),
    description: SERVICE_DESCRIPTION,
    mimeType: "application/json",
    serviceName: SERVICE_NAME,
    iconUrl: `${config.publicBaseUrl}${ICON_PATH}`,
    tags: discoveryTags(config),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: EXAMPLE_REQUEST,
      output: { example: EXAMPLE_RESPONSE },
    }),
    unpaidResponseBody: () => ({
      contentType: "application/json",
      body: unpaidPreview(config, priceUsdc),
    }),
    resource: `${config.publicBaseUrl}${path}`,
  });

  return {
    [PAID_ROUTE_KEY]: route(PAID_ROUTE_PATH),
    [PAID_ROUTE_ALIAS_KEY]: route(PAID_ROUTE_ALIAS_PATH),
  };
}

/**
 * Body returned alongside the 402 so an unpaid caller learns how to pay without reading docs.
 *
 * The x402 `accepts` array already carries the machine-readable requirements; this is the
 * human- and agent-readable companion: what it costs, on what chain, in what asset, and what
 * to do next.
 */
export function unpaidPreview(config: GatewayConfig, priceUsdc?: string): Record<string, unknown> {
  const quoted = priceUsdc ?? config.inboundPriceUsdc;
  const atomic = usdcToAtomic(quoted);
  return {
    service: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    price: {
      usdc: quoted,
      display: priceString(config, quoted),
      atomic: atomicToWire(atomic),
      asset: usdcAssetId(config.network),
      decimals: 6,
      per: "request",
    },
    // The whole table, not just the tier this 402 quotes: an agent deciding *which* model to
    // buy needs every price at once, and probing one model per 402 to discover them is a
    // round trip per model.
    pricing: { ...pricingTable(config), endpoint: `${config.publicBaseUrl}/v1/pricing` },
    // Must match `accepts[].network` exactly: an agent reads this preview to build its
    // payment, so advertising the canonical id here while the requirement carries the
    // facilitator form would hand it a value the facilitator rejects.
    network: facilitatorNetwork(config.network),
    meshNetwork: config.meshNetwork,
    payTo: config.payToAddress,
    facilitator: config.facilitatorUrl,
    scheme: "exact",
    maxTimeoutSeconds: maxTimeoutSeconds(config),
    tags: discoveryTags(config),
    howToPay: [
      "Retry this request with an `x402` client configured for the Algorand `exact` scheme.",
      "The facilitator sponsors the ALGO fee, so you only sign the USDC asset transfer.",
      "Your paying account must be opted in to the USDC ASA before the transfer can land.",
    ],
    models: {
      discovery: `${config.publicBaseUrl}/v1/nodes`,
      note: "Available models are the union of the capabilities advertised by healthy nodes.",
      example: EXAMPLE_REQUEST.model,
    },
    exampleRequest: EXAMPLE_REQUEST,
    exampleResponse: EXAMPLE_RESPONSE,
    documentation: `${config.publicBaseUrl}/llms.txt`,
  };
}
