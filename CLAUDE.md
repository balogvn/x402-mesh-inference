# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

x402 Mesh — settlement infrastructure for pay-per-use APIs, with an AI inference
marketplace as the first thing plugged into it. Four npm workspaces, TypeScript
throughout, deployed as two Fly.io apps against Algorand MainNet.

**The money is real.** A gateway on MainNet takes USDC from callers and pays
USDC to node operators. A bug here does not produce a stack trace; it produces a
debt nobody can see or a payer charged for nothing.

## Commands

```bash
npm test              # Vitest, single run
npm run typecheck     # tsc --build, plus tests and scripts tsconfigs — NOT part of lint
npm run lint          # eslint
npm run build         # all workspaces
npm run dev:gateway
npm run dev:daemon
```

`typecheck` compiles three separate projects and is a **separate script from
lint**. Running only `npm run lint` locally misses what CI fails on.

Run one file or one case:

```bash
npx vitest run packages/gateway/src/services/settlement.test.ts
npx vitest run -t "batch"
```

CI is three workflows: `ci-test` (verify + coverage), `e2e-x402-simulation`
(simulate + gateway-e2e), and `deploy`.

## Four tests flake, and the cause is not known

`./scripts/flake-hunt.sh [runs]` exists because four tests fail intermittently
in the full suite and pass in isolation every time. Do not "fix" one by
retrying it or marking it skipped without reading that script first — it records
what has already been ruled out **by measurement, not assumption**: real network
calls (none, every facilitator is stubbed), shared module state (vitest forks
with isolate), CPU load alone, keygen cost, and running the files together.

What is known is that it only appears under the full suite, which points at
whole-suite scheduling. What is missing is the actual assertion message from a
failing run. That is what the script captures, into `.flake-hunt/run-<n>.log`.

## The thing that is actually hard

Not inference — that is a commodity. It is splitting a micropayment on-chain
between two parties who hold no account with each other, and **amortizing the
transaction fee so the split is possible at all**.

A payout costs a flat 0.001 ALGO whatever its size. On a $0.0060 request at 15%
margin the platform earns $0.0009, so the fee is a third of it; at the original
$0.0020 price the fee _was_ the entire margin and every request netted zero.
That floor is why micropayment marketplaces do not exist, and batching is the
answer to it. Read `docs/positioning.md` before changing anything priced.

### Money invariants are asserted, not documented

All amounts are integer `bigint` atomic units. `inbound - payout === margin` is
proved by `computeSplit` and re-proved by `assertSplitInvariant` on the values
actually about to move. Keep it that way — floats and money do not mix, and a
documented invariant is one nobody checks.

### Leg 2 must never break leg 1

One paid request makes two on-chain movements: the caller pays the gateway
(synchronous, via the x402 facilitator) and the gateway pays the operator
(asynchronous, `settlement.ts`). The client has already been served by the time
`settleInbound` runs, so **every failure path there ends in a ledger entry and a
log line, never a thrown error**. `settleInbound` returns `void` deliberately.

Batched and unbatched payouts run the same code on purpose: one copy of the
retry policy and the lease logic, so a batch cannot quietly get a weaker version.

## Bugs already paid for — do not re-introduce these

### Two implementations of one question

`/readyz` counted a node routable on its own predicate while the selector routed
on network, staleness, health and opt-in. They disagreed: the live MainNet
gateway reported "2/2 nodes routable" while the selector would route to exactly
one. **A readiness endpoint that over-reports capacity conceals an outage until
traffic fails** — the moment it existed to warn about.

Fixed by extracting `unroutableReason()` into the registry beside the selector
and importing it, rather than writing a third copy. A test asserts the selector
and the predicate agree across seven fixtures. If you need "is this node
routable" anywhere else, import that — do not re-derive it.

### A debt that left the map it was reported from

`/v1/payouts/pending` read only the in-memory accrual map, which a batch leaves
the instant it is carved off. A payout that could never succeed therefore
erased itself from the one endpoint whose purpose is telling an operator what
they are owed. Batched liabilities are now reported too.

The debt behind that: `demo-node-01` carried a **TestNet** network id with
`usdcOptedIn` earned on TestNet, and survived the flip to MainNet. Paid MainNet
traffic routed to an address that could not receive MainNet USDC. The selector's
`wrongNetwork` guard now refuses it. Beware of stored node records that outlive
a network change.

### A truncated list is worse than no list

`rank.ts` queried the catalog with `limit=100`, and that endpoint returns an
arbitrary 100-entry slice, **not** the top 100. It reported "rank 4 of 54" when
the truth was rank 14 of 831; minutes later the slice shifted and the same
script reported no entry at all, indistinguishable from being delisted. Both
readings were confidently wrong from one hardcoded limit.

Also: the default 15s probe timeout is sized for a health check, not a bulk
fetch of a thousand entries.

### The "charge before capacity" bug does not exist

It has been filed once already, from inferring ordering out of where
`settleInbound` is called rather than reading the middleware. `@x402/express`
buffers the response, runs the handler, waits for it to end, and only then
settles — below a `statusCode >= 400` guard. A 503 `no_capacity` **cancels** the
payment; a handler that throws is cancelled as `handler_threw`.

It is recorded as a comment in `app.ts` beside the settle hook rather than as a
test, because pinning it needs a real signed Algorand transaction group — the
middleware rejects synthetic payloads.

## Deployment and cost

Two Fly apps, both in `iad`: `x402-mesh-gateway` (`fly.toml`) and
`x402-mesh-node` (`fly.node.toml`). State lives in Upstash Redis
(`x402-mesh-redis`), which holds the **persisted settlement ledger** — deleting
that database destroys the record of what was paid.

- Both apps are pinned running: `auto_stop_machines = false`, and the node sets
  `min_machines_running = 1`. That is deliberate (a cold start on the first
  request is the one that matters) and it is a standing cost.
- Fly health-checks `/healthz` every 30s. That is **liveness only, deliberately
  not `/readyz`** — `/readyz` includes whether the payout wallet is funded and
  opted in, and wiring that to Fly would make a funding lapse look like a dead
  machine.

### Upstash Prod Pack costs $200/month

Found on a real bill: $176.07 of a $182.34 Fly invoice was Redis, with all
compute and bandwidth across ten regions coming to $6.27. The plan is
Pay-as-you-go and the app's steady-state traffic is roughly 350K commands a
month — under a dollar. The charge was the **Prod Pack add-on**: a $200/month
enterprise pack (uptime SLA, multi-zone HA, encryption at rest, SOC-2) that
nothing here needs.

Check it with `fly redis status x402-mesh-redis` — and note the command from a
different project directory fails with "organization Could not find", because
flyctl takes its org from the app context.

Rough Redis cost per paid request, if you need to model it: `list` 3 commands +
`beginRequest` 1 + `recordOutcome` 4 + `endRequest` 1, plus 2 per node heartbeat
every 15s.

## Spending real money

`npm run test:e2e-mainnet` is **the one script here that spends real USDC**. It
refuses unless `X402_MAINNET_CONFIRM` is set to the exact sentence
`I_UNDERSTAND_THIS_SPENDS_REAL_USDC`; `--dry-run` is exempt because demanding a
spend confirmation to preview a spend would be absurd. `e2e-simulate.ts` is the
stubbed equivalent and is what CI runs.

`.wallets/`, `.local/` and `.env*` are gitignored and hold keys. Never read a
private key into a commit, a log, or a comment — and note that a Redis URL
printed by `fly redis status` contains the password in plain text.

## Conventions

- Comments explain **why**, and several carry the incident that produced them.
  Match that: a fix without its reason invites the same bug back.
- Prefer one implementation of a question over a second copy that agrees today.
- Database and chain questions get answered by **probing the live system**, not
  by reading the code that was supposed to write it. Both the TestNet-record and
  the invisible-debt bugs were found that way.
