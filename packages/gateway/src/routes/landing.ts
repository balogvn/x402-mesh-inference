import type { GatewayConfig } from "@x402-mesh/shared";
import {
  atomicToUsdc,
  atomicToWire,
  computeSplit,
  facilitatorNetwork,
  usdcAssetId,
  usdcToAtomic,
} from "@x402-mesh/shared";
import { Router } from "express";
import { pricingTable } from "../x402/routes.js";
import type { Request, Response } from "express";

/**
 * The human-facing front door at `/`.
 *
 * Everything else this gateway serves is machine-facing: an agent discovers it through the
 * Bazaar catalog or `llms.txt` and never renders anything. But a person who pastes the URL
 * into a browser — a judge, an operator, a prospective node — previously got a 404, which
 * says nothing about what this is or whether it works.
 *
 * The page is deliberately self-contained: one HTML string, no build step, no bundler, no
 * external stylesheet, font or script. A gateway serves payments, not assets, and a landing
 * page that pulls from a CDN is a landing page that breaks behind a strict CSP or an air-gap.
 *
 * The live figures come from the gateway's own free endpoints (`/v1/nodes`, `/v1/settlements`,
 * `/readyz`) via fetch, so the page cannot drift from what the API actually reports — there is
 * no second copy of the truth to keep in sync.
 *
 * The "Try it" button is the important part. It fires a genuinely unpaid request at the paid
 * route and renders the decoded `payment-required` challenge that comes back. That
 * demonstrates the whole x402 handshake **without a funded wallet**, which matters because a
 * demo that needs the viewer to hold TestNet USDC is a demo almost nobody completes.
 */

/** Collaborators the landing route needs. */
export interface LandingRouteDeps {
  config: GatewayConfig;
}

/** Escapes text for safe interpolation into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Numbers the page quotes, derived from config so they cannot disagree with the 402. */
interface Economics {
  inboundAtomic: string;
  payoutAtomic: string;
  marginAtomic: string;
  inboundUsdc: string;
  payoutUsdc: string;
  marginUsdc: string;
  marginBps: number;
  /** Per-model tiers, empty under flat pricing. Cheapest first. */
  tiers: {
    model: string;
    inboundUsdc: string;
    payoutUsdc: string;
    marginUsdc: string;
    inboundAtomic: string;
    payoutAtomic: string;
    marginAtomic: string;
  }[];
  asset: string;
  network: string;
  wireNetwork: string;
}

/**
 * Computes the economics shown on the page.
 *
 * Uses the same `computeSplit` the settlement path uses, so the page cannot advertise a split
 * the gateway would not actually pay.
 *
 * @param config - Resolved gateway configuration.
 * @returns Display-ready figures.
 */
export function landingEconomics(config: GatewayConfig): Economics {
  const inbound = usdcToAtomic(config.inboundPriceUsdc);
  const split = computeSplit(inbound, config.marginBps);
  return {
    inboundAtomic: atomicToWire(split.inbound),
    payoutAtomic: atomicToWire(split.payout),
    marginAtomic: atomicToWire(split.margin),
    inboundUsdc: atomicToUsdc(split.inbound),
    payoutUsdc: atomicToUsdc(split.payout),
    marginUsdc: atomicToUsdc(split.margin),
    marginBps: config.marginBps,
    tiers: pricingTable(config).models.map((m) => {
      const t = computeSplit(usdcToAtomic(m.usdc), config.marginBps);
      return {
        model: m.model,
        inboundUsdc: atomicToUsdc(t.inbound),
        payoutUsdc: atomicToUsdc(t.payout),
        marginUsdc: atomicToUsdc(t.margin),
        inboundAtomic: atomicToWire(t.inbound),
        payoutAtomic: atomicToWire(t.payout),
        marginAtomic: atomicToWire(t.margin),
      };
    }),
    asset: usdcAssetId(config.network),
    network: config.network,
    wireNetwork: facilitatorNetwork(config.network),
  };
}

/**
 * The price sentence for the hero.
 *
 * Under per-model pricing there is no single number to quote. Stating one anyway is how the
 * page came to advertise "$0.002000 USDC" as *the* price while every model the mesh could
 * actually serve cost three times that.
 */
export function priceHeadline(e: Economics): string {
  if (e.tiers.length === 0) return `$${e.inboundUsdc} USDC`;
  const prices = [e.inboundUsdc, ...e.tiers.map((t) => t.inboundUsdc)];
  const low = prices.reduce((a, b) => (Number(a) <= Number(b) ? a : b));
  const high = prices.reduce((a, b) => (Number(a) >= Number(b) ? a : b));
  return low === high ? `$${low} USDC` : `$${low}–$${high} USDC, by model`;
}

/** Rows for the cost table: the fallback tier, then one per individually-priced model. */
export function tierRows(e: Economics): string {
  const row = (
    label: string,
    t: { inboundUsdc: string; payoutUsdc: string; marginUsdc: string; inboundAtomic: string },
  ): string =>
    `<tr><td>${escapeHtml(label)}</td><td>$${escapeHtml(t.inboundUsdc)}</td>` +
    `<td>$${escapeHtml(t.payoutUsdc)}</td><td>$${escapeHtml(t.marginUsdc)}</td>` +
    `<td class="num">${escapeHtml(t.inboundAtomic)}</td></tr>`;

  const fallbackLabel = e.tiers.length === 0 ? "Every request" : "Any other model";
  return [...e.tiers.map((t) => row(t.model, t)), row(fallbackLabel, e)].join("\n      ");
}

/**
 * Renders the landing page.
 *
 * @param config - Resolved gateway configuration.
 * @returns A complete HTML document.
 */
export function renderLanding(config: GatewayConfig): string {
  const e = landingEconomics(config);
  const net = config.meshNetwork;
  const explorer =
    net === "mainnet" ? "https://lora.algokit.io/mainnet" : "https://lora.algokit.io/testnet";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x402 Mesh Inference</title>
<meta name="description" content="Pay-per-prompt AI inference settled on Algorand via HTTP 402.">
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #10131a; --muted: #5c6472; --line: #e3e7ee;
    --card: #f7f9fc; --accent: #2f6bff; --good: #0f8a5f; --warn: #b26a00;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1017; --fg: #e6e9ef; --muted: #9aa4b6; --line: #232936;
      --card: #141926; --accent: #6f9bff; --good: #3ddc97; --warn: #ffb454;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 48px 20px 72px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.02em; }
  h2 { font-size: 18px; margin: 40px 0 12px; letter-spacing: -0.01em; }
  p { margin: 0 0 14px; }
  .lede { color: var(--muted); font-size: 17px; margin-bottom: 22px; }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 28px; }
  .pill {
    font: 12px/1 var(--mono); padding: 6px 10px; border: 1px solid var(--line);
    border-radius: 999px; color: var(--muted); white-space: nowrap;
  }
  .pill b { color: var(--fg); font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .card .k { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  .card .v { font: 20px/1.3 var(--mono); margin-top: 4px; word-break: break-all; }
  .flow { display: grid; grid-template-columns: 1fr; gap: 0; margin: 8px 0 0; }
  .step { display: grid; grid-template-columns: 26px 1fr; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line); }
  .step:last-child { border-bottom: 0; }
  .step .n {
    width: 26px; height: 26px; border-radius: 50%; background: var(--card);
    border: 1px solid var(--line); display: grid; place-items: center;
    font: 12px/1 var(--mono); color: var(--muted);
  }
  .step .t { font-size: 15px; }
  .step .t code { font: 13px/1.5 var(--mono); color: var(--accent); }
  .money { border-left: 3px solid var(--good); padding-left: 12px; }
  button {
    font: 600 15px/1 inherit; padding: 11px 18px; border-radius: 8px; cursor: pointer;
    background: var(--accent); color: #fff; border: 0;
  }
  button:disabled { opacity: .55; cursor: progress; }
  pre {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px; font: 12.5px/1.6 var(--mono); margin: 12px 0 0;
    /* The decoded challenge plus the preview body runs to ~4300px unconstrained, which
       buries the footer and makes the page feel broken. Cap it and let the block scroll. */
    max-height: 380px; overflow: auto;
  }
  a { color: var(--accent); }
  .links { display: flex; flex-wrap: wrap; gap: 14px; font-size: 14px; margin-top: 8px; }
  .status { font: 13px/1.5 var(--mono); color: var(--muted); margin-top: 10px; }
  .ok { color: var(--good); } .bad { color: var(--warn); }
  footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; margin-top: 6px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  td.num { font-family: var(--mono); text-align: right; }
</style>
</head>
<body>
<div class="wrap">

  <h1>x402 Mesh Inference</h1>
  <p class="lede">
    Pay-per-prompt AI inference. An agent calls an ordinary OpenAI-compatible endpoint with
    no account and no API key, pays <b>${escapeHtml(priceHeadline(e))}</b> inline over
    HTTP 402, and the prompt is routed to an independent GPU operator who is paid on chain.
  </p>

  <div class="pills">
    <span class="pill">network <b>${escapeHtml(net)}</b></span>
    <span class="pill">USDC ASA <b>${escapeHtml(e.asset)}</b></span>
    <span class="pill">scheme <b>exact</b></span>
    <span class="pill">x402 <b>v2</b></span>
    <span class="pill">status <b id="ready">checking…</b></span>
  </div>

  <h2>Live mesh</h2>
  <div class="grid">
    <div class="card"><div class="k">Nodes online</div><div class="v" id="nodeCount">—</div></div>
    <div class="card"><div class="k">Models served</div><div class="v" id="modelCount">—</div></div>
    <div class="card"><div class="k">Requests settled</div><div class="v" id="settleCount">—</div></div>
    <div class="card"><div class="k">Paid to operators</div><div class="v" id="paidOut">—</div></div>
  </div>
  <div class="status" id="nodeList"></div>

  <h2>What one request costs</h2>
  <p>
    USDC has 6 decimals, so every figure below is an exact integer of atomic units. The gateway
    never does floating-point arithmetic on money, and asserts
    <code>inbound − payout = margin</code> before any funds move.
  </p>
  <table>
    <thead><tr><th>Model</th><th>Client pays</th><th>Operator gets</th><th>Margin</th><th class="num">Atomic in</th></tr></thead>
    <tbody>
      ${tierRows(e)}
    </tbody>
  </table>

  <h2>How a payment happens</h2>
  <div class="flow">
    <div class="step"><div class="n">1</div><div class="t">Agent <code>POST</code>s an OpenAI-shaped body with no payment header.</div></div>
    <div class="step"><div class="n">2</div><div class="t">Gateway answers <code>402</code>; the machine-readable challenge rides in the <code>payment-required</code> header.</div></div>
    <div class="step"><div class="n">3</div><div class="t">Agent retries with <code>PAYMENT-SIGNATURE</code> — an Algorand atomic group. The facilitator sponsors the fee, so it is <b>gasless</b> for the payer.</div></div>
    <div class="step"><div class="n">4</div><div class="t">Facilitator verifies, then the healthiest node serving that model gets the prompt.</div></div>
    <div class="step"><div class="n">5</div><div class="t">Completion streams back over SSE while settlement lands on chain.</div></div>
    <div class="step money"><div class="n">6</div><div class="t">On <b>confirmed</b> settlement only, the operator is paid their share.</div></div>
  </div>

  <h2>Try the handshake</h2>
  <p>
    This sends a real unpaid request to the paid route and shows you the actual challenge that
    comes back — no wallet required.
  </p>
  <button id="tryBtn" type="button">Send an unpaid request</button>
  <a href="/quickstart" style="margin-left:10px">integrate in 60s →</a>
  <a href="/chat" style="margin-left:10px">or open the chat client →</a>
  <div class="status" id="tryStatus"></div>
  <pre id="tryOut" hidden></pre>

  <h2>For agents</h2>
  <div class="links">
    <a href="/.well-known/x402">/.well-known/x402</a>
    <a href="/llms.txt">/llms.txt</a>
    <a href="/v1/pricing">/v1/pricing</a>
    <a href="/v1/nodes">/v1/nodes</a>
    <a href="/v1/settlements">/v1/settlements</a>
    <a href="/readyz">/readyz</a>
  </div>

  <footer>
    Settled on Algorand ${escapeHtml(net)} · USDC ASA ${escapeHtml(e.asset)} ·
    <a href="${escapeHtml(explorer)}">explorer</a> ·
    facilitator <a href="${escapeHtml(config.facilitatorUrl)}">${escapeHtml(config.facilitatorUrl)}</a>
  </footer>
</div>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var fmtUsdc = function (atomicStr) {
    var s = String(atomicStr || "0").replace(/[^0-9]/g, "") || "0";
    while (s.length < 7) s = "0" + s;
    return "$" + s.slice(0, -6) + "." + s.slice(-6);
  };

  fetch("/readyz").then(function (r) {
    return r.json().then(function (b) { return { ok: r.ok, body: b }; });
  }).then(function (r) {
    var el = $("ready");
    el.textContent = r.ok ? "ready" : "degraded";
    el.className = r.ok ? "ok" : "bad";
  }).catch(function () { $("ready").textContent = "unreachable"; });

  fetch("/v1/nodes").then(function (r) { return r.json(); }).then(function (d) {
    var nodes = (d && d.nodes) || [];
    $("nodeCount").textContent = String(nodes.length);
    var models = {};
    nodes.forEach(function (n) {
      (n.capabilities || []).forEach(function (c) { if (c && c.model) models[c.model] = 1; });
    });
    var names = Object.keys(models);
    $("modelCount").textContent = String(names.length);
    $("nodeList").textContent = nodes.length
      ? names.join(" · ")
      : "No nodes registered yet — paid requests return 503 until an operator joins.";
  }).catch(function () { $("nodeList").textContent = "node list unavailable"; });

  fetch("/v1/settlements").then(function (r) { return r.json(); }).then(function (d) {
    var rows = (d && (d.settlements || d.records)) || [];
    $("settleCount").textContent = String(rows.length);
    var total = 0;
    rows.forEach(function (s) {
      if (s && s.status === "settled") total += parseInt(s.payoutAtomic || "0", 10) || 0;
    });
    $("paidOut").textContent = fmtUsdc(String(total));
  }).catch(function () { $("settleCount").textContent = "—"; });

  $("tryBtn").addEventListener("click", function () {
    var btn = this, out = $("tryOut"), st = $("tryStatus");
    btn.disabled = true;
    st.textContent = "sending…";
    out.hidden = true;

    fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b", messages: [{ role: "user", content: "hello" }] })
    }).then(function (res) {
      // The v2 challenge travels in this header, base64-encoded. The body is a human-readable
      // preview, so showing only the body would misrepresent where accepts[] actually lives.
      var header = res.headers.get("payment-required");
      var decoded = null;
      if (header) {
        try { decoded = JSON.parse(atob(header)); } catch (err) { decoded = { error: "header did not decode" }; }
      }
      return res.json().catch(function () { return null; }).then(function (body) {
        st.innerHTML = "HTTP <b>" + res.status + "</b>" +
          (header ? ' · <span class="ok">payment-required header present</span>'
                  : ' · <span class="bad">no payment-required header</span>');
        out.hidden = false;
        out.textContent = JSON.stringify(
          { status: res.status, challenge: decoded, preview: body }, null, 2
        );
      });
    }).catch(function (err) {
      st.textContent = "request failed: " + err;
    }).then(function () { btn.disabled = false; });
  });
})();
</script>
</body>
</html>`;
}

/**
 * Builds the landing router.
 *
 * Mounted on the free surface: this must never sit behind the paywall, or a browser would be
 * asked to pay to read what the service is.
 *
 * @param deps - Route collaborators.
 * @returns An Express router serving `GET /`.
 */
export function createLandingRouter(deps: LandingRouteDeps): Router {
  const router = Router();
  const html = renderLanding(deps.config);

  router.get("/", (_req: Request, res: Response) => {
    res.status(200).type("html").send(html);
  });

  return router;
}
