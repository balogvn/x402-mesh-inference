import type { GatewayConfig } from "@x402-mesh/shared";
import { isSafeModelId } from "@x402-mesh/shared";
import { Router } from "express";
import type { NodeStorePort } from "../ports.js";
import { EXAMPLE_REQUEST, PAID_ROUTE_PATH } from "../x402/routes.js";

/**
 * The integration path, served from the running deployment: `GET /quickstart`.
 *
 * A developer's first paid x402 request is where this project loses people, and not for any
 * reason a README fixes. Building it took discovering two things that no amount of reading the
 * SDK types reveals, both of which fail with an error that points somewhere else entirely:
 *
 *   1. The challenge is in the base64 `payment-required` **header**. Reading it from the JSON
 *      body type-checks — the cast is unchecked — and yields `accepts: []`, so the client
 *      builds no payment and the retry 402s again with no diagnostic.
 *   2. The client must register the `algorand:*` **wildcard**. Registering the canonical
 *      network id that `@x402/avm` exports as a constant fails against a server advertising
 *      the facilitator's full-genesis-hash form with "No network/scheme registered for x402
 *      version: 2" — an error that reads like a missing import.
 *
 * Both cost hours here (see `docs/x402-integration-notes.md`). So the snippet below is not
 * illustrative: it is the working client, with the traps already avoided, interpolated with
 * this deployment's real URL so it runs unmodified. Serving it from the gateway rather than
 * only from the README means the copy a developer runs is the copy that matches the server
 * they are pointing it at — a README on `main` can advertise a price the deployment no longer
 * charges.
 *
 * Content-negotiated: `text/html` for a browser, `text/plain` for `curl` and for an agent that
 * found this URL in `llms.txt`.
 */

/** Collaborators the quickstart route needs. */
export interface QuickstartRouteDeps {
  config: GatewayConfig;
  /**
   * Live node registry, used only to name a model the mesh can actually serve.
   *
   * Without this the snippet fell back to {@link EXAMPLE_REQUEST}'s illustrative model id,
   * and the first deployment to run it advertised a completely different one — so the copy
   * a developer pasted paid the fallback price and then failed to route, which is the worst
   * possible outcome for a page whose entire promise is that it works unmodified.
   *
   * Optional: when absent, or when no node is registered, the static example is used.
   */
  store?: NodeStorePort;
}

/**
 * Picks a model to put in the snippet.
 *
 * First capability of the first registered node, which is the same set `/v1/nodes` reports
 * and therefore the same set the router will select from. Falls back to the static example
 * when the mesh is empty, so the page still renders something copy-pasteable.
 */
export async function servableModel(store: NodeStorePort | undefined): Promise<string> {
  if (store === undefined) return EXAMPLE_REQUEST.model;
  try {
    const nodes = await store.list();
    for (const node of nodes) {
      // Capabilities hang off the signed registration, not off the record. Reading
      // `node.capabilities` compiles to `undefined` and silently degrades to the fallback —
      // which is exactly how the wrong model reached production the first time.
      const model = node.registration.capabilities[0]?.model;
      // Re-validated even though registration now enforces the same charset: this value is
      // about to be interpolated into JavaScript that a developer runs with a private key in
      // their environment, and a record persisted before that constraint existed would
      // otherwise sail straight through. Cheap check, catastrophic failure mode.
      if (isSafeModelId(model)) return model;
    }
  } catch {
    // A registry hiccup must not take down a documentation page.
  }
  return EXAMPLE_REQUEST.model;
}

/** Escapes text for safe interpolation into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The three shell commands, in order. */
export function quickstartShell(config: GatewayConfig, model: string): string {
  return [
    "# 1. See what each model costs. Free, no wallet, no key.",
    `curl -s ${config.publicBaseUrl}/v1/pricing`,
    "",
    "# 2. See the payment challenge for a request you have not paid for.",
    `curl -si -X POST ${config.publicBaseUrl}${PAID_ROUTE_PATH} \\`,
    '  -H "content-type: application/json" \\',
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"hi"}]}' \\`,
    "  | grep -i payment-required",
    "",
    "# 3. Install the client and pay it.",
    "npm i @x402/core @x402/avm",
  ].join("\n");
}

/**
 * The runnable client.
 *
 * Kept to one file with no local imports so it survives being copied into a scratch directory,
 * which is what a developer evaluating this will actually do.
 */
export function quickstartClient(config: GatewayConfig, model: string): string {
  return `// pay.mjs — a complete paid request against ${config.publicBaseUrl}
// Run: AVM_PRIVATE_KEY=<base64 64-byte Algorand secret key> node pay.mjs
//
// The paying account needs a little ALGO for its minimum balance and must be OPTED IN to the
// USDC ASA. The facilitator sponsors the transaction fee, so you only sign the asset transfer.

import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";

const ENDPOINT = "${config.publicBaseUrl}${PAID_ROUTE_PATH}";
const body = {
  // Any model a healthy node advertises at ${config.publicBaseUrl}/v1/nodes.
  model: ${JSON.stringify(model)},
  messages: [{ role: "user", content: "Reply with one word." }],
};

// Register the WILDCARD, not a concrete network id. A client matches the challenge's network
// verbatim, and this server advertises the facilitator's full-genesis-hash form rather than
// the truncated constant \`@x402/avm\` exports. Registering the constant here fails with
// "No network/scheme registered for x402 version: 2".
const signer = toClientAvmSigner(process.env.AVM_PRIVATE_KEY);
const http = new x402HTTPClient(
  new x402Client().register("algorand:*", new ExactAvmScheme(signer)),
);

const post = (headers) =>
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const unpaid = await post({});
if (unpaid.status !== 402) throw new Error(\`expected 402, got \${unpaid.status}\`);

// The challenge is in the HEADER. The JSON body is a human-readable preview with no
// \`accepts[]\` — decoding that instead yields a challenge with nothing to pay against.
const challenge = decodePaymentRequiredHeader(unpaid.headers.get("payment-required"));
console.log("price:", challenge.accepts[0].amount, "atomic USDC");

// Spread the header MAP the SDK returns. The name is part of the protocol: x402 v2 expects
// \`PAYMENT-SIGNATURE\`, and renaming it to \`X-PAYMENT\` makes the server answer 402 again.
const paid = await post(http.encodePaymentSignatureHeader(await http.createPaymentPayload(challenge)));
if (!paid.ok) throw new Error(\`\${paid.status}: \${await paid.text()}\`);

const completion = await paid.json();
console.log(completion.choices[0].message.content);
console.log("settled:", paid.headers.get("payment-response") ? "yes" : "pending");
`;
}

/** Plain-text rendering, for curl and for agents. */
export function quickstartText(config: GatewayConfig, model: string): string {
  return [
    "x402 Mesh Inference — integration in three steps",
    "=".repeat(48),
    "",
    quickstartShell(config, model),
    "",
    "-".repeat(48),
    "",
    quickstartClient(config, model),
    "",
    "-".repeat(48),
    "",
    `Prices:     ${config.publicBaseUrl}/v1/pricing`,
    `Models:     ${config.publicBaseUrl}/v1/nodes`,
    `Manifest:   ${config.publicBaseUrl}/.well-known/x402`,
    `Agent docs: ${config.publicBaseUrl}/llms.txt`,
    "",
  ].join("\n");
}

/** Builds the quickstart router. */
export function createQuickstartRouter(deps: QuickstartRouteDeps): Router {
  const router = Router();
  const { config } = deps;

  router.get("/quickstart", (req, res, next) => {
    // Short cache: the model name tracks a live registry, so a page cached for hours would
    // outlive the node it names.
    res.setHeader("cache-control", "public, max-age=60");
    servableModel(deps.store)
      .then((model) => {
        // `req.accepts` returns false when the client rejects both, in which case plain text
        // is the more useful default — a machine client is likelier than a picky browser.
        if (req.accepts(["text/plain", "text/html"]) === "text/html") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.status(200).send(renderHtml(config, model));
          return;
        }
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.status(200).send(quickstartText(config, model));
      })
      .catch(next);
  });

  // Directly fetchable so `curl -O` yields a file that runs.
  router.get("/quickstart/pay.mjs", (_req, res, next) => {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=60");
    servableModel(deps.store)
      .then((model) => res.status(200).send(quickstartClient(config, model)))
      .catch(next);
  });

  return router;
}

/** Renders the browser view. Self-contained: no CDN, no bundler, no external asset. */
function renderHtml(config: GatewayConfig, model: string): string {
  const shell = escapeHtml(quickstartShell(config, model));
  const client = escapeHtml(quickstartClient(config, model));
  const base = escapeHtml(config.publicBaseUrl);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quickstart — x402 Mesh Inference</title>
<style>
  :root { color-scheme: light dark; --bg:#0b0d10; --fg:#e6e9ef; --dim:#9aa4b2; --acc:#5eead4;
          --card:#14181d; --line:#242a31; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fbfcfd; --fg:#11151a; --dim:#5b6672; --acc:#0d9488; --card:#fff; --line:#e3e8ee; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2.5rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size:1.75rem; margin:0 0 .35rem; letter-spacing:-.02em; }
  p.lede { color:var(--dim); margin:0 0 2rem; }
  h2 { font-size:1rem; margin:2.25rem 0 .6rem; letter-spacing:.02em; text-transform:uppercase;
       color:var(--acc); }
  pre { background:var(--card); border:1px solid var(--line); border-radius:10px;
        padding:1rem 1.1rem; overflow-x:auto; font:13px/1.55 ui-monospace,SFMono-Regular,
        Menlo,Consolas,monospace; margin:0; }
  a { color:var(--acc); }
  ul { color:var(--dim); padding-left:1.1rem; }
  li { margin:.3rem 0; }
  footer { margin-top:2.5rem; padding-top:1.25rem; border-top:1px solid var(--line);
           color:var(--dim); font-size:.9rem; }
</style>
</head>
<body>
<main>
  <h1>Integrate in three steps</h1>
  <p class="lede">Pay-per-prompt inference over x402. No account, no API key, no minimum —
     the payment <em>is</em> the authentication.</p>

  <h2>1 &amp; 2 — look before you pay</h2>
  <pre>${shell}</pre>

  <h2>3 — a complete paid request</h2>
  <pre>${client}</pre>
  <p class="lede">Save as <code>pay.mjs</code>, or
     <a href="${base}/quickstart/pay.mjs">download it</a>.</p>

  <h2>Two traps this snippet already avoids</h2>
  <ul>
    <li>The challenge lives in the base64 <code>payment-required</code> <strong>header</strong>,
        not the JSON body. Reading the body gives you an empty <code>accepts[]</code>.</li>
    <li>Register the <code>algorand:*</code> <strong>wildcard</strong>. Registering the
        canonical network constant fails with <em>“No network/scheme registered for x402
        version: 2”</em>.</li>
  </ul>

  <footer>
    <a href="${base}/v1/pricing">Pricing</a> ·
    <a href="${base}/v1/nodes">Models</a> ·
    <a href="${base}/.well-known/x402">Manifest</a> ·
    <a href="${base}/llms.txt">Agent docs</a> ·
    <a href="${base}/">Home</a>
  </footer>
</main>
</body>
</html>`;
}
