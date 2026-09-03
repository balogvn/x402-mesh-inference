# Nine ways a payment system lies to you

We built [x402 Mesh Inference](https://github.com/balogvn/x402-mesh-inference) — an agent calls
an OpenAI-compatible endpoint with no account and no API key, pays inline in USDC on Algorand,
and the gateway pays the GPU operator who served it. Two on-chain money legs per request.

We described it as an AI inference marketplace for two days before noticing that inference was
the least interesting part. The difficult thing was splitting a micropayment between a platform
and a supplier who hold no account with each other, and amortizing the transaction fee so the
split is possible at all. Every failure below is a failure of _that_, not of serving a model —
which is why they generalise to anything paying many suppliers a little at a time.

It works. It settles on MainNet. It was, briefly, top of the x402 Global Challenge
leaderboard — as of 3 September 2026 it is rank 64 of 1,479 tagged entries, with 17 settles
against a leader on 236,998. That ranking measures traffic volume, which is not what any of
this was built to be good at.

None of that is the interesting part. The interesting part is that across fifteen commits in two
days, **the test suite was green for every single bug below**. Not one of them was caught by the
thing we built to catch bugs.

This is a list of the specific ways a system tells you it is fine while it is not.

---

## 1. The passing test that protects the bug

The gateway called nodes at `/v1/chat/completions`. The node daemon served `/infer`. Every request
404'd.

There was a test covering this. It used `/v1/chat/completions` as its example of _an unknown path
the daemon should reject_. The test passed, correctly, against a daemon that could not serve the
one path the gateway would ever ask for.

This happened **three times** in two days. Each time the test asserted something true and useless.

The most expensive instance: our quickstart named `llama3.1:8b`, an illustrative constant. No
registered node served it. A developer running the published "60-second integration" verbatim
would be quoted the fallback price and then fail to route — the integration failing at second 61,
after taking their money. Nine tests covered that snippet. They asserted it contained the right
SDK calls. None asserted the model it named could actually be served.

**The lesson is narrower than "write better tests."** It is: assert on what the system _produces
for a real consumer_, not on what it contains. Our price tests decode the base64
`payment-required` header rather than reading the JSON preview body, because a preview assertion
passes even when the actual payment requirement is wrong — which is precisely the failure the
feature can produce.

## 2. Shipping a code-injection hole and finding it an hour later

We added per-model pricing, then made the quickstart name a model the mesh actually serves by
reading it from the live registry.

Node registration is open. Anyone can register a node advertising any capability string, and
`model` accepted any 200-character value. That string was interpolated straight into the
JavaScript of `GET /quickstart/pay.mjs` — the file the page tells developers to download and run
**with `AVM_PRIVATE_KEY` in their environment**.

A registration advertising a model id containing JavaScript was remote code execution against an
integrator's wallet. It was live.

We found it because we ran an adversarial review — five independent agents, each told to attack a
different dimension, each finding independently verified by a skeptic. It found this plus 21 real
inconsistencies. Every one of them had passed our green suite.

The fix is unremarkable: constrain model ids to `[A-Za-z0-9._:/-]` at the schema, re-check at the
sink, emit through `JSON.stringify`. The lesson is that **we would not have found it**. We wrote
the vulnerability while fixing a different bug, reviewed our own work, and shipped.

## 3. "Deployed" is not a value

Setting a Fly secret reported success. `fly secrets list` showed `AVM_PRIVATE_KEY │ Deployed`. The
container saw an empty string.

The gateway booted with payouts disabled and **every MainNet payout failed for two hours**. We had
reported that run as clean, on the strength of the inbound leg settling — half the money loop,
checked, declared whole.

```
fly ssh console -C 'sh -c "echo ${#AVM_PRIVATE_KEY}"'
AVM_len=0
```

Verify the length, not the listing. A control plane reporting success is a claim about the write,
not about the value.

## 4. Two fields called "tags", one of which matters

The x402 Global Challenge requires a tag on your resource. We put `x402-global-challenge` in the
route's `tags` array. It appeared in the general Bazaar catalog with a real settlement count and
was **completely absent from the challenge leaderboard**.

The filter reads `accepts[].extra.tag`. The `tags` array is descriptive discovery metadata that
the leaderboard never consults. Both exist. Both are called tags. Only one enters the competition.

Then the organisers corrected us again: `extra` needs **both** `asset` and `tag`. We had added
`tag` alone. Checking the catalog at the time: **every one of the 57** filtered entries carried both. The asset is
redundant to the protocol — settlement resolves it independently and payments work fine without it
— which is exactly why it was invisible.

A field that is load-bearing for discovery and inert for function will be omitted by anyone
reasoning from function.

## 5. The economics were a rounding error away from negative

Every Algorand payout costs a flat 0.001 ALGO regardless of size. At ALGO ≈ $0.30 that is
~$0.0003.

Our margin was $0.0003.

Every request netted **exactly zero**, and above that ALGO price each one lost money. The system
worked perfectly and was a treadmill.

Two fixes. Per-model pricing, because a 70B model and an 8B model cost wildly different amounts to
serve and one flat price is either a loss on the large one or an overcharge on the small one. Then
batching: accrue what an operator is owed and settle it in one transfer. Ten requests in one
payout moves the fee from ~33% of margin to ~3%.

Verified on chain — 14 settlements, one transaction:

```
+23800 atomic USDC   x402-mesh/payout/batch/mshk26th-1
```

**Measure the fee against the margin, not against the transaction.** A fee that is 0.5% of the
payment can be 100% of the profit.

## 6. Batching turns a fee problem into a money-loss problem

Batching means holding USDC you already owe. That liability lived in memory, so a crash lost the
record of who was owed what — funds sitting in the wallet with nothing remembering to send them.

Persisting it introduced something worse. A process that dies **mid-payout** leaves a record
saying "pay this" when the transfer may already be on chain. Recover naively and you pay twice,
and nothing on chain undoes it.

The defence is to write the batch id down _before_ attempting the payout and reuse it verbatim on
recovery. Same id means the same Algorand lease and the same transaction note as the attempt that
may have committed — the chain rejects the duplicate, and a note-prefix search recognises it.

A second adversarial pass over this code found **four more** double-pay paths. Five blind lenses
converged on the same defects:

- Durable writes chained on two different keys, so a batch record could be written _after_ its own
  deletion and be re-paid at next boot
- Recovery never de-duplicated between open and in-flight records, paying the same requests twice
  in a single boot
- Recovery re-submitting before asking the chain, with a lease window shorter than a slow restart
- A failed payout **deleting** the durable record — the comment claimed the ledger was the durable
  record; the ledger was in memory and capped at 1000 rows

That last one is the one to sit with. **Fixing it is what recovered real money.** When the empty
secret caused 8 MainNet payouts to fail, those records survived because a failed payout now keeps
its liability. Setting the key correctly and restarting was enough — boot recovery found them and
paid. The fix was written hours before the failure it caught.

## 7. Two hypotheses that fit perfectly and were wrong

Four tests fail intermittently under the full suite and pass in isolation every time.

We were confident it was ed25519 keygen cost in the fixtures. It fit every symptom: all four tests
build crypto-heavy fixtures, it only appears under parallel load, it never reproduces alone. We
were ready to act on it.

Measuring took thirty seconds. **~0.0 ms per keygen.** Wrong by orders of magnitude.

Earlier the same day: we concluded the Bazaar catalog freezes a resource's metadata at first
indexing and never refreshes. Evidence was 8 settlements that did not update the entry. The
organisers said metadata updates from any real settlement.

Both were half right. A _new_ resource indexes from its first settlement; an _existing_ entry does
not refresh. We proved it with two payments — one to the old endpoint, unchanged; one to an
endpoint the catalog had never seen, indexed correctly and immediately.

Seven hypotheses eliminated by measurement, none by argument. We still have not found the flake.
We shipped a harness that captures the next occurrence instead of a fix we cannot justify —
because a change that cannot be shown to address the cause converts a visible flake into invisible
confidence.

## 8. State outlives the assumptions it was created under

Flipping the gateway from TestNet to MainNet left the old node registrations in Redis: healthy,
advertising their models, routable. The selector filtered on model, health, opt-in, saturation and
exclusion — never network. A decommissioned node was still listed healthy **105 minutes** after
its last heartbeat.

Nothing aged a node out at all. Health was recomputed only from request _outcomes_, so a node that
is switched off keeps its last-known `healthy: true` and keeps winning selection. The mesh could
only learn otherwise by losing real requests to it — each one a client charged for a completion
that failed.

Persisted state is a claim about the moment it was written. Anything that filters on it needs to
know when that moment was.

## 9. The error that says nothing

An underfunded payer running our published client got:

```
Error: 402: {}
```

The real cause was in the response the whole time:

```
underflow on subtracting 6000 from sender amount 4146
```

The exact shortfall. It arrives in the `payment-required` header of the retry; the body on that
path is literally `{}`. Our snippet read the one place with no information and discarded the one
with all of it — the same mistake its own comments warn about for the unpaid challenge. We applied
the rule on the first leg and not the second.

For a service whose entire pitch is "integrate in 60 seconds", an uninterpretable error at a
developer's first failure is where they give up.

---

## What we would tell someone starting now

**Assert on the wire.** Decode what the client actually receives. A test reading your own config
proves your config is self-consistent, which no user cares about.

**Mutate your fix.** Every money path here has a test we deliberately broke to confirm it fails —
re-key the accrual map and 4 tests fail; mint a fresh batch id on recovery and 2 fail. A green
suite that cannot be shown to catch the bug is decoration. This is the single practice that moved
us from "tested" to "correct".

**Get adversarial review before you ship money code.** Ours found a live security hole and 21
inconsistencies our suite had passed. Reviewing your own work finds what you were already looking
for.

**Verify values, not acknowledgements.** "Deployed", "success", "202 Accepted" are claims about a
write.

**Compare the fee to the margin.** Not to the transaction.

**Assume any field you can omit and still function will be omitted.** If it matters, make omitting
it fail.

---

The system is live at
[x402-mesh-gateway.fly.dev](https://x402-mesh-gateway.fly.dev/quickstart), Apache-2.0, 785 tests.
Every claim above is in the commit history — including the ones where we were wrong, which are
the ones worth reading.
