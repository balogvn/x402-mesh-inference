# Deploying the gateway to Fly.io

The gateway needs a public HTTPS URL for two reasons: an autonomous agent has to be able to
reach the resource named in the 402 challenge, and `npm run test:e2e-mainnet` pays a live
deployment. This is the shortest path to both.

**Sequence matters.** Deploy on TestNet, prove the whole loop with free faucet USDC, and only
then switch to MainNet. Every deployment problem you find on TestNet costs nothing; the same
problem found on MainNet costs a settlement fee and a failed leaderboard attempt.

---

## 1. One-time setup

Install flyctl and log in:

```bash
brew install flyctl
```

```bash
fly auth login
```

Create the app. The name must match `app` in [fly.toml](../fly.toml) — if you pick a
different one, change it in both places, including `MESH_PUBLIC_BASE_URL`:

```bash
fly apps create x402-mesh-gateway
```

## 2. Generate and fund the payout account

This account receives every client payment, so it must exist on chain, hold ALGO for the
minimum balance, and be opted in to USDC before it can receive anything.

```bash
npm run keygen -- --network testnet
```

It prints an `ADDRESS` and an `AVM_PRIVATE_KEY`. **The key is a live secret** — anyone who
reads it can spend the account. Do not paste it into a chat, an issue, or a `.env` that might
be committed.

Fund the address with TestNet ALGO (keep at least 0.3 ALGO — 0.1 base minimum balance, 0.1
per opted-in asset, plus fees):

- ALGO: https://lora.algokit.io/testnet/fund
- USDC: https://faucet.circle.com/ (choose Algorand TestNet)

Then **opt in to USDC**. An Algorand account cannot receive an asset it has not opted into —
this is the single most common cause of a silent payout failure, and it is why registration
refuses operators who have not done it.

## 3. Set the secrets

Secrets go to Fly's encrypted store, never into `fly.toml`:

```bash
fly secrets set X402_PAY_TO_ADDRESS=<the address from keygen>
```

```bash
fly secrets set AVM_PRIVATE_KEY=<the base64 key from keygen>
```

> `AVM_PRIVATE_KEY` is what signs operator payouts. Without it the gateway still starts,
> serves traffic and takes payments — it logs a warning and records every payout as failed.
> That is deliberate: the client must never be denied a response because the payout leg is
> misconfigured. Watch for `operator payouts are disabled` in the logs.

## 4. Deploy

```bash
fly deploy
```

Then confirm it is actually serving:

```bash
curl https://x402-mesh-gateway.fly.dev/healthz
```

And that it can take a paid request — this is the one that checks the facilitator, the store
and the payout wallet together:

```bash
curl https://x402-mesh-gateway.fly.dev/readyz
```

If `/readyz` reports the wallet unfunded or not opted in, go back to step 2. `/healthz` is
what Fly health-checks against, precisely so an unfunded wallet cannot roll back a deploy.

Verify the challenge an agent will actually receive:

```bash
curl -s -D - -o /dev/null -X POST https://x402-mesh-gateway.fly.dev/v1/chat/completions -H 'content-type: application/json' -d '{"model":"llama3.1:8b","messages":[{"role":"user","content":"hi"}]}'
```

You want `HTTP/2 402` and a `payment-required` header. That header is base64 JSON; decoding it
should show `network: algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`, `asset:
10458941` and `amount: "2000"`.

## 5. Deploy from CI (optional)

Add a repository secret `FLY_API_TOKEN` and the existing
[deploy workflow](../.github/workflows/deploy.yml) will roll out on every green `main` build:

```bash
fly tokens create deploy -x 999999h
```

The workflow skips the Fly steps entirely when the token is absent, so forks and
unconfigured clones stay green.

## 6. Attach a demo node (no GPU required)

**A gateway with no nodes answers `503 no_capacity` to every paid request.** Deploying only
the gateway gives a judge nothing that works, so this step is not optional for a demo.

You do not need a GPU. The daemon's `openai` provider speaks the same wire protocol as vLLM,
so it can front any hosted OpenAI-compatible API — Groq, Together, OpenRouter, DeepInfra,
Fireworks, OpenAI itself, or your own vLLM. Only the base URL and the model name change.

Pick a backend and get an API key, then edit [fly.node.toml](../fly.node.toml) so
`MESH_PROVIDER_BASE_URL` and `MESH_MODELS` match it. The defaults point at Groq, which has a
free tier. Two constraints worth respecting:

- `MESH_MODELS` must name a model the backend **actually serves**. Advertising one it does
  not have makes the gateway route paid requests here and then fail them.
- `MESH_NODE_ENDPOINT` must be the node's **public** URL. The gateway fetches it on every
  routed request and its SSRF guard rejects private and loopback addresses.

Create the app and set its secrets. The operator key is a _different_ account from the
gateway's `payTo` — this one receives the $0.0017 payouts:

```bash
fly apps create x402-mesh-node
```

```bash
npm run keygen -- --network testnet
```

```bash
fly secrets set --config fly.node.toml AVM_PRIVATE_KEY=<the node operator key> MESH_PROVIDER_API_KEY=<your backend api key>
```

Check everything before deploying. `doctor` verifies the backend is reachable **with your
API key**, that every advertised model exists, that the key derives a valid address, and that
the account is funded and opted in:

```bash
MESH_PROVIDER_API_KEY=<your backend api key> AVM_PRIVATE_KEY=<the node operator key> MESH_GATEWAY_URL=https://x402-mesh-gateway.fly.dev MESH_NODE_ENDPOINT=https://x402-mesh-node.fly.dev MESH_PROVIDER=openai MESH_PROVIDER_BASE_URL=https://api.groq.com/openai MESH_MODELS=llama-3.3-70b-versatile npx tsx packages/node-daemon/src/cli.ts doctor
```

Then deploy and confirm the gateway can see it:

```bash
fly deploy --config fly.node.toml
```

```bash
curl -s https://x402-mesh-gateway.fly.dev/v1/nodes
```

You want `count: 1` with `"healthy": true` and `"routable": true`. If `routable` is false,
the operator account has not opted in to USDC — the gateway stores the node but will not send
it paid work, because it could not be paid.

> The node operator account needs the USDC opt-in for the same reason the gateway's does:
> Algorand cannot deliver an asset to an account that has not opted in. `doctor` checks it.

## 7. Switch to MainNet

Only after the TestNet loop works end to end.

MainNet USDC is a **different asset** (ASA `31566704`), so the payout account needs its own
opt-in and real USDC — a TestNet opt-in does not carry over:

```bash
fly secrets set MESH_NETWORK=mainnet
```

Re-run `/readyz`, confirm it is green, then make the leaderboard payment. Preview it first —
`--dry-run` prints the exact amount and destination without spending:

```bash
MESH_E2E_BASE_URL=https://x402-mesh-gateway.fly.dev npm run test:e2e-mainnet -- --dry-run
```

When the dry run looks right, authorise the real spend for that one invocation:

```bash
export X402_MAINNET_CONFIRM=I_UNDERSTAND_THIS_SPENDS_REAL_USDC
```

```bash
MESH_E2E_BASE_URL=https://x402-mesh-gateway.fly.dev npm run test:e2e-mainnet
```

It prints the transaction id and an explorer link. That settlement is what gets the service
indexed on the x402 leaderboard.

---

## Things that actually went wrong

Every item here cost real time during the first deployment. None of them are hypothetical.

**Fly's trial plan hard-stops machines after 5 minutes.** `auto_stop_machines = false` and
`min_machines_running = 1` are applied correctly and ignored — the log line is
`Trial machine stopping. To run for longer than 5m0s, add a credit card`. The node registers,
heartbeats, dies ~5 minutes later, and the gateway then has no routable node. Add a card
before trying to demo anything; the free allowance still covers this workload.

**The daemon's listen port is not the port in its URL.** `MESH_NODE_ENDPOINT` is the _public_
URL, which on Fly is `https://…` (port 443). A non-root container cannot bind 443 and dies
with `EACCES: permission denied 0.0.0.0:443`. Set `MESH_NODE_PORT` to the container's
`internal_port`. This applies to every TLS-terminating platform, not just Fly.

**A gateway with no float fails its first payout.** The payout spends the USDC the inbound leg
just delivered, and that is not spendable until the inbound transaction is final (~one 2.8s
block). If the retry backoff is shorter than a block, the first payout of a wallet's life
fails with `underflow on subtracting 1700 from sender amount 0`, the client is charged and the
operator is not paid. The default policy now spans ~21s. The bug is invisible once the wallet
has a balance, so only a fresh deployment ever hits it — check `GET /v1/settlements` after the
first real request.

**The in-memory registry does not survive a restart.** After any gateway restart the node must
re-register. The gateway answers an unknown node's heartbeat with 404 and the daemon
re-registers on 404/410, so this self-heals within one heartbeat interval — but only because
the status code is 404. If you see nodes silently vanish, check that first. Set `REDIS_URL`
for a registry that survives restarts.

**Fly's CLI can time out while the deploy succeeds.** `failed to get VM … request canceled` is
a client-side API timeout, not a failed rollout. Check `flyctl status` before redeploying.

---

## Troubleshooting

| Symptom                                        | Cause                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot fails with `missing_facilitator`          | The route's network id does not match what the facilitator advertises. Should not happen — `facilitatorNetwork()` handles it — but see [x402-integration-notes.md §2](x402-integration-notes.md). |
| `/readyz` red, `/healthz` green                | Normal before funding. The payout wallet is unfunded or not opted in to USDC.                                                                                                                     |
| Paid requests return `503 no_capacity`         | No healthy node is registered for the requested model. Check `GET /v1/nodes`.                                                                                                                     |
| Node registration returns `non-public address` | The SSRF guard. The node endpoint must be publicly routable; `MESH_ALLOW_PRIVATE_NODE_ENDPOINTS` is local-development only.                                                                       |
| Payouts logged as failed                       | `AVM_PRIVATE_KEY` is unset, or its account is unfunded / not opted in. Clients are still served.                                                                                                  |
