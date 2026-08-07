# Demo video script — x402 Mesh Inference

Target **3:00**. Terminal + browser, no slides. Every command below was run against the live
MainNet deployment before this script was written; the output shown is what it actually returns.

> **Prerequisite — do this first.** The client wallet holds `0.002146` USDC, which funds **zero**
> requests at `$0.0060`. The payment is the entire demo. Send `0.024` USDC (ASA 31566704) from
> `HJRC7A3QMZJAD3TX7PMYTF7MUFPG6OYNHHKAXI2LCCRWYWXSQTC6TSGLGA` to
> `VNAZPGAN6YVDMBADXR7NF25VY7ZKXAM6G65JZKU2W4OXFMVWQ7UEQ5ILCA` before filming. Verify with
> `curl -s https://x402-mesh-gateway.fly.dev/v1/pricing` and a test run, then record.

---

## 0:00 – 0:25 · The hook

**Screen:** empty terminal, large font.

**Say:**

> This is an AI inference API. I have no account with it. There is no signup, no API key, and
> nobody knows who I am. Watch what happens when I call it.

**Run:**

```bash
curl -si -X POST https://x402-mesh-gateway.fly.dev/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"hi"}]}' | head -20
```

**Say, over the `HTTP/2 402`:**

> Four-oh-two. Payment Required — a status code that has been in the HTTP spec since 1997 and
> never worked. It works now.

---

## 0:25 – 0:50 · The price is public before you pay

**Say:**

> Before I pay anything, I can ask what it costs. No account needed for that either.

**Run:**

```bash
curl -s https://x402-mesh-gateway.fly.dev/v1/pricing | jq
```

**Point at:** `llama-3.3-70b-versatile` at `$0.0060`, default `$0.0020`, `asset 31566704`.

**Say:**

> Per-model, because a 70-billion-parameter model and an 8-billion one cost wildly different
> amounts to serve. One flat price is either a loss on the big model or an overcharge on the
> small one.

---

## 0:50 – 1:30 · Pay it

**Say:**

> The machine-readable demand is in a header, not the body. My client decodes it, signs a USDC
> transfer on Algorand, and retries.

**Run:**

```bash
curl -sO https://x402-mesh-gateway.fly.dev/quickstart/pay.mjs
AVM_PRIVATE_KEY=$CLIENT_KEY node pay.mjs
```

**Expected output:**

```
price: 6000 atomic USDC
Hello.
settled: yes
```

**Say:**

> Six thousand atomic units — six tenths of a cent. Real USDC, Algorand MainNet, settled. That
> client is the same file the site serves at `/quickstart`; I downloaded it thirty seconds ago and
> ran it unmodified.

---

## 1:30 – 2:05 · Both money legs, on chain

**Screen:** switch to a block explorer, or `curl` the indexer.

**Say:**

> Two payments happen per request, not one. The client paid the gateway. The gateway pays the GPU
> operator who actually served the prompt — eighty-five percent of it, on chain.

**Run:**

```bash
curl -s https://x402-mesh-gateway.fly.dev/v1/settlements | jq '.settlements[0]'
```

**Point at:** `inboundAtomic 6000`, `payoutAtomic 5100`, `marginAtomic 900`, both transaction ids.

**Say:**

> Inbound minus payout equals margin. That invariant is asserted in integer arithmetic before any
> funds move — no floating point touches money anywhere in this system.

---

## 2:05 – 2:40 · The part that nearly killed it

**Say:**

> Here is the number that almost sank this. Every Algorand payout costs a flat fee — about
> three hundredths of a cent, regardless of size.

**Screen:** the margin line, `marginAtomic: 900` → `$0.0009`.

**Say:**

> At our original price the margin _was_ that fee. Every request netted exactly zero. The system
> worked perfectly and was a treadmill.
>
> So payouts are batched — accrue what an operator is owed, settle it in one transfer.

**Run:**

```bash
curl -s "https://mainnet-idx.algonode.cloud/v2/transactions/JDW6Y76INRUKGQRT7N5AV7WGQBCQQHLG7QRVF656ZIKLMOBP4WCQ" \
  | jq '.transaction | {amount: ."asset-transfer-transaction".amount, fee, note: (.note|@base64d)}'
```

**Say:**

> One transaction, one fee — 23,800 atomic USDC covering fourteen requests. That moves the fee from a third of the
> margin to about three percent.

---

## 2:40 – 3:00 · Close

**Say:**

> An agent paid for compute with no account, no key, and no human. The operator who served it was
> paid automatically, on chain, in the same minute.
>
> The inference is a demo. What is underneath is a settlement rail — many small payments, many
> suppliers, no account relationship, and a transaction fee bigger than the payment. That is the
> problem that stops micropayment marketplaces existing, and it is the part worth reusing.
>
> It is live on Algorand MainNet, it is Apache-2.0, and the write-up documents the nine ways this
> system told us it was fine while it was not — including a security hole we shipped and found an
> hour later. That is in the repo too.

**Screen:** GitHub repo, then `https://x402-mesh-gateway.fly.dev/quickstart`.

---

## Notes for the recording

**Do not skip the failure line at the end.** Every hackathon video claims everything works.
Naming a real bug you shipped and caught is the only line in this script a judge has not heard
before, and it reads as confidence rather than weakness.

**Do not narrate the architecture.** No diagrams, no "let me walk you through the components."
The whole pitch is _no account, money moves, both directions_ — anything else is dilution. The
repo carries the detail for anyone who wants it.

**Record the payment twice and keep the better take.** It costs `$0.0060` each and settlement
takes a few seconds; a stall on camera is worse than the six tenths of a cent.

**Have `/v1/settlements` already loaded in a second tab.** The ledger is served from memory and
hydrated from Redis at boot, so it is instant — but do not discover a cold start on camera.

**If asked what is unfinished:** four tests flake intermittently under full-suite load and are
undiagnosed, there is one node in the mesh and it is ours, and pricing is per-request rather than
per-token, which will mis-price long prompts once volume arrives. Saying so costs nothing and
buys credibility with anyone technical.
