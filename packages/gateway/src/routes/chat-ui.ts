import type { GatewayConfig } from "@x402-mesh/shared";
import { Router } from "express";
import { priceHeadline } from "./landing.js";
import type { Request, Response } from "express";

import { landingEconomics } from "./landing.js";

/**
 * A browser chat client at `/chat`.
 *
 * The landing page proves the *handshake* works; this proves the whole product works — you
 * type a prompt and watch tokens arrive from a node that got paid for them.
 *
 * Three states, and the middle one is the interesting one:
 *
 *  - **streaming** — the request was paid for (or the gateway is running unguarded in local
 *    development), so SSE frames are parsed and rendered token by token.
 *  - **402** — the request needs paying. The decoded challenge is shown, and a wallet payment
 *    can be started without leaving the page.
 *  - **503** — no node serves that model. Surfaced plainly, because "no capacity" is a
 *    mesh-state problem an operator can fix, not a bug.
 *
 * The wallet flow deliberately reuses the **official** `@x402/paywall` rather than
 * reimplementing signing. The page re-requests the same endpoint with `Accept: text/html`,
 * which is what makes `paymentMiddleware` return the paywall document, and drops that document
 * into a sandboxed iframe. Rolling our own wallet connection would mean hand-rolling Algorand
 * transaction signing in the browser — more code, worse security, and it would drift from the
 * protocol the moment the spec moved.
 */

/** Collaborators the chat UI route needs. */
export interface ChatUiRouteDeps {
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

/**
 * Renders the chat page.
 *
 * @param config - Resolved gateway configuration.
 * @returns A complete HTML document.
 */
export function renderChatUi(config: GatewayConfig): string {
  const e = landingEconomics(config);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat · x402 Mesh Inference</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#fff; --fg:#10131a; --muted:#5c6472; --line:#e3e7ee; --card:#f7f9fc;
    --accent:#2f6bff; --good:#0f8a5f; --warn:#b26a00; --user:#eef3ff;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0d1017; --fg:#e6e9ef; --muted:#9aa4b6; --line:#232936; --card:#141926;
      --accent:#6f9bff; --good:#3ddc97; --warn:#ffb454; --user:#18213a;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width:820px; margin:0 auto; padding:32px 20px 56px; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  h1 { font-size:22px; margin:0; letter-spacing:-.02em; }
  .sub { color:var(--muted); font-size:14px; }
  a { color:var(--accent); }
  .bar { display:flex; gap:8px; flex-wrap:wrap; margin:18px 0 14px; align-items:center; }
  select, textarea {
    font:15px/1.5 inherit; color:var(--fg); background:var(--card);
    border:1px solid var(--line); border-radius:8px; padding:9px 11px;
  }
  select { min-width:210px; }
  textarea { width:100%; resize:vertical; min-height:78px; }
  button {
    font:600 15px/1 inherit; padding:11px 18px; border-radius:8px; border:0;
    background:var(--accent); color:#fff; cursor:pointer;
  }
  button.ghost { background:transparent; color:var(--accent); border:1px solid var(--line); }
  button:disabled { opacity:.55; cursor:progress; }
  #log { margin:20px 0 0; display:flex; flex-direction:column; gap:12px; }
  .msg { border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .msg.user { background:var(--user); }
  .msg .who { font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin-bottom:5px; }
  .msg .body { white-space:pre-wrap; word-wrap:break-word; }
  .msg .meta { margin-top:8px; font:12px/1.5 var(--mono); color:var(--muted); }
  .cursor::after { content:"▋"; animation:b 1s steps(2) infinite; margin-left:1px; }
  @keyframes b { 50% { opacity:0; } }
  .notice { border-left:3px solid var(--warn); padding:10px 14px; background:var(--card); border-radius:0 8px 8px 0; }
  .notice.pay { border-left-color:var(--accent); }
  pre { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px;
        font:12px/1.55 var(--mono); max-height:260px; overflow:auto; margin:10px 0 0; }
  .ok { color:var(--good); } .bad { color:var(--warn); }
  dialog { border:0; padding:0; width:min(560px,94vw); height:min(760px,90vh); border-radius:12px;
           background:var(--bg); color:var(--fg); }
  dialog::backdrop { background:rgba(0,0,0,.55); }
  dialog .head { display:flex; justify-content:space-between; align-items:center;
                 padding:10px 14px; border-bottom:1px solid var(--line); font-size:14px; }
  dialog iframe { width:100%; height:calc(100% - 46px); border:0; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Chat</h1>
      <div class="sub">
        ${escapeHtml(priceHeadline(e))} per request ·
        <span id="meshState">checking the mesh…</span>
      </div>
    </div>
    <div class="sub"><a href="/">← overview</a></div>
  </header>

  <div class="bar">
    <select id="model"><option value="">loading models…</option></select>
    <label class="sub"><input type="checkbox" id="stream" checked> stream</label>
  </div>

  <textarea id="prompt" placeholder="Ask the mesh something…">Explain what HTTP 402 is, in two sentences.</textarea>
  <div class="bar" style="margin-top:10px">
    <button id="send" type="button">Send</button>
    <button id="clear" class="ghost" type="button">Clear</button>
  </div>

  <div id="log"></div>
</div>

<dialog id="payDlg">
  <div class="head"><b>Pay with an Algorand wallet</b><button class="ghost" id="payClose" type="button">Close</button></div>
  <iframe id="payFrame" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>
</dialog>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var log = $("log");

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function bubble(who, cls) {
    var m = el("div", "msg" + (cls ? " " + cls : ""));
    m.appendChild(el("div", "who", who));
    var b = el("div", "body", "");
    m.appendChild(b);
    log.appendChild(m);
    m.scrollIntoView({ block: "nearest" });
    return { msg: m, body: b };
  }

  // Populate the model list from the mesh itself, so you can only ask for something a node
  // actually serves. An empty list is the honest signal that nothing can answer yet.
  fetch("/v1/nodes").then(function (r) { return r.json(); }).then(function (d) {
    var nodes = (d && d.nodes) || [];
    var models = {};
    nodes.forEach(function (n) {
      (n.capabilities || []).forEach(function (c) { if (c && c.model) models[c.model] = 1; });
    });
    var names = Object.keys(models);
    var sel = $("model");
    sel.innerHTML = "";
    if (!names.length) {
      sel.appendChild(new Option("no models available", ""));
      $("meshState").innerHTML = '<span class="bad">no nodes registered</span>';
      return;
    }
    names.forEach(function (m) { sel.appendChild(new Option(m, m)); });
    $("meshState").innerHTML = '<span class="ok">' + nodes.length + " node(s), " + names.length + " model(s)</span>";
  }).catch(function () { $("meshState").textContent = "mesh unreachable"; });

  function showChallenge(container, res) {
    var header = res.headers.get("payment-required");
    var decoded = null;
    if (header) { try { decoded = JSON.parse(atob(header)); } catch (e) { decoded = null; } }

    var n = el("div", "notice pay");
    n.appendChild(el("div", "who", "402 payment required"));
    var acc = decoded && decoded.accepts && decoded.accepts[0];
    n.appendChild(el("div", "body",
      acc ? ("Pay " + acc.amount + " atomic USDC (asset " + acc.asset + ") to " + acc.payTo)
          : "The gateway asked for payment."));

    var btn = el("button", null, "Pay with an Algorand wallet");
    btn.style.marginTop = "10px";
    btn.addEventListener("click", function () { openPaywall(); });
    n.appendChild(btn);

    if (decoded) {
      var pre = el("pre", null, JSON.stringify(decoded, null, 2));
      n.appendChild(pre);
    }
    container.appendChild(n);
  }

  // Ask the SAME endpoint for its browser representation. paymentMiddleware answers a
  // request advertising text/html with the official @x402/paywall document, so the wallet
  // flow here is the protocol's own, not a reimplementation.
  function openPaywall() {
    var dlg = $("payDlg"), frame = $("payFrame");
    frame.srcdoc = "<p style='font:14px sans-serif;padding:16px'>Loading payment…</p>";
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/html" },
      body: JSON.stringify({ model: currentModel(), messages: [{ role: "user", content: lastPrompt || "hello" }] })
    }).then(function (r) { return r.text(); }).then(function (html) {
      frame.srcdoc = html;
    }).catch(function (err) {
      frame.srcdoc = "<p style='font:14px sans-serif;padding:16px'>Could not load the payment page: " + String(err) + "</p>";
    });
  }
  $("payClose").addEventListener("click", function () {
    var dlg = $("payDlg");
    if (typeof dlg.close === "function") dlg.close(); else dlg.removeAttribute("open");
    $("payFrame").srcdoc = "";
  });

  // No hardcoded default: a literal model id here outlives the node that served it,
  // and quoting one the mesh does not serve sends the request straight to a 503.
  function currentModel() { return $("model").value; }
  var lastPrompt = "";

  /** Parses an SSE byte stream, tolerating frames split across chunk boundaries. */
  async function consumeStream(res, body, meta) {
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    var text = "";
    body.parentElement.classList.add("cursor");
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      // Frames are separated by a blank line; anything after the last separator is a
      // partial frame and must stay buffered, or a token gets torn in half.
      var parts = buf.split("\\n\\n");
      buf = parts.pop() || "";
      for (var i = 0; i < parts.length; i++) {
        var line = parts[i].trim();
        if (line.indexOf("data:") !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          var j = JSON.parse(payload);
          var delta = j.choices && j.choices[0] && j.choices[0].delta;
          if (delta && delta.content) { text += delta.content; body.textContent = text; }
        } catch (e) { /* a malformed frame must not kill the stream */ }
      }
    }
    body.parentElement.classList.remove("cursor");
    meta.textContent = "streamed · " + text.length + " chars · node " + (res.headers.get("x-mesh-node-id") || "?");
  }

  async function send() {
    var promptEl = $("prompt");
    var prompt = promptEl.value.trim();
    if (!prompt) return;
    lastPrompt = prompt;
    $("send").disabled = true;

    bubble("you", "user").body.textContent = prompt;
    var out = bubble("mesh");
    var meta = el("div", "meta", "sending…");
    out.msg.appendChild(meta);

    try {
      var res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model: currentModel(),
          messages: [{ role: "user", content: prompt }],
          stream: $("stream").checked
        })
      });

      if (res.status === 402) { meta.textContent = "payment required"; showChallenge(out.msg, res); return; }
      if (res.status === 503) {
        meta.textContent = "";
        var w = el("div", "notice", "No node can serve that model right now. Register one, or pick another model.");
        out.msg.appendChild(w);
        return;
      }
      if (!res.ok) {
        var errBody = await res.text();
        meta.textContent = "HTTP " + res.status;
        out.msg.appendChild(el("pre", null, errBody.slice(0, 800)));
        return;
      }

      var ct = res.headers.get("content-type") || "";
      if (ct.indexOf("text/event-stream") !== -1 && res.body) {
        meta.textContent = "streaming…";
        await consumeStream(res, out.body, meta);
      } else {
        var j = await res.json();
        var msg = j.choices && j.choices[0] && j.choices[0].message;
        out.body.textContent = (msg && msg.content) || JSON.stringify(j, null, 2);
        var u = j.usage || {};
        meta.textContent = "node " + (res.headers.get("x-mesh-node-id") || "?") +
          (u.total_tokens ? " · " + u.total_tokens + " tokens" : "");
      }
    } catch (err) {
      meta.textContent = "request failed: " + String(err);
    } finally {
      $("send").disabled = false;
    }
  }

  $("send").addEventListener("click", send);
  $("clear").addEventListener("click", function () { log.innerHTML = ""; });
  $("prompt").addEventListener("keydown", function (ev) {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") send();
  });
})();
</script>
</body>
</html>`;
}

/**
 * Builds the chat UI router.
 *
 * Free surface: the page itself costs nothing, only the completions it requests do.
 *
 * @param deps - Route collaborators.
 * @returns An Express router serving `GET /chat`.
 */
export function createChatUiRouter(deps: ChatUiRouteDeps): Router {
  const router = Router();
  const html = renderChatUi(deps.config);

  router.get("/chat", (_req: Request, res: Response) => {
    res.status(200).type("html").send(html);
  });

  return router;
}
