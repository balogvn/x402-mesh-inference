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

## 6. Attach a node

A gateway with no nodes returns `503 no_capacity` on every paid request. Run a daemon
somewhere the gateway can reach — note `MESH_NODE_ENDPOINT` must be **publicly reachable**,
because the deployed gateway rejects private and loopback addresses (the SSRF guard):

```bash
MESH_GATEWAY_URL=https://x402-mesh-gateway.fly.dev MESH_NODE_ENDPOINT=https://your-node.example.com npx x402-mesh-node doctor
```

`doctor` checks the backend, the key, the derived address and the on-chain prerequisites
before you commit to `start`.

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

## Troubleshooting

| Symptom                                        | Cause                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot fails with `missing_facilitator`          | The route's network id does not match what the facilitator advertises. Should not happen — `facilitatorNetwork()` handles it — but see [x402-integration-notes.md §2](x402-integration-notes.md). |
| `/readyz` red, `/healthz` green                | Normal before funding. The payout wallet is unfunded or not opted in to USDC.                                                                                                                     |
| Paid requests return `503 no_capacity`         | No healthy node is registered for the requested model. Check `GET /v1/nodes`.                                                                                                                     |
| Node registration returns `non-public address` | The SSRF guard. The node endpoint must be publicly routable; `MESH_ALLOW_PRIVATE_NODE_ENDPOINTS` is local-development only.                                                                       |
| Payouts logged as failed                       | `AVM_PRIVATE_KEY` is unset, or its account is unfunded / not opted in. Clients are still served.                                                                                                  |
