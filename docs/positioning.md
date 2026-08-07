# What this actually is

We built and shipped this as an AI inference marketplace. That is the weakest description of it,
and it is worth saying why before anyone reads the code and draws the same conclusion we did.

## The hard part was never inference

Serving `llama-3.3-70b-versatile` is a commodity. Groq does it, Together does it, half a dozen
others do it, and every one of them accepts a credit card. Nothing about our routing layer beats
theirs.

What is not a commodity is this:

> **Splitting a micropayment between a platform and a supplier, on-chain, where neither party
> holds an account with the other, and amortizing the transaction fee so the split is
> economically possible at all.**

That sentence is the product. Inference is the first thing we plugged into it.

## Why the fee is the whole problem

A payout on Algorand costs a flat 0.001 ALGO whatever its size — about $0.0003. On a $0.0060
request at a 15% margin, the platform earns $0.0009. The fee is a third of it. At our original
$0.0020 price, the fee _was_ the entire margin: every request netted exactly zero.

This is not an Algorand problem. It is the structural reason micropayment marketplaces do not
exist. Any per-transaction fee, on any chain or rail, sets a floor beneath which paying a supplier
costs more than the payment is worth. Below that floor you cannot have a marketplace, only a
prepaid account with a reconciliation problem.

The system solves it by accruing what each supplier is owed and settling in one transfer. Verified
on MainNet:

```
+23800 atomic USDC   fee 1000 microALGO   x402-mesh/payout/batch/mshk26th-1
```

One fee, fourteen requests. That moves the fee from ~33% of margin to ~3%, and the saving grows
with volume rather than shrinking.

Everything difficult in this repository follows from holding that money between accrual and
payout — which is to say, from owing people money you have not sent yet.

## What holding a liability actually costs

Batching is four lines of arithmetic and a very large amount of failure handling. The parts that
took real work, all of which are general and none of which are about inference:

- **Durable accruals.** Money owed must outlive the process. Without it a crash loses the record;
  the funds sit in the wallet and nothing remembers to send them.
- **Crash recovery that cannot double-pay.** Persisting a liability is easy. A process that dies
  _mid-payout_ leaves a record saying "pay this" when the transfer may already be on chain. The
  batch id is written down before the payout is attempted and reused verbatim on recovery, so the
  retry carries the same lease and the same note as the attempt that may have committed.
- **Failed payouts that stay owed.** A payout that exhausts its retries is still a debt. Deleting
  the record is how an unpaid supplier becomes invisible.
- **An audit ledger that survives a deploy**, because the chain records the transfer and not the
  accounting behind it.
- **Suppliers that can stop existing.** A node that is switched off keeps its last-known healthy
  flag forever unless something ages it out.

Four double-pay paths were found in that code by adversarial review after we thought it was
correct. Two of them could have sent an operator money twice with nothing on chain to undo it.

## How coupled is it, really

Measured, not asserted:

|                                              | lines | inference-specific references                   |
| -------------------------------------------- | ----- | ----------------------------------------------- |
| Settlement, accruals, ledger, money, pricing | 1,795 | `settlement.ts` names "chat" once, in a comment |
| Request handling and routing                 | 559   | pervasive                                       |

The money machinery is domain-free. `accruals.ts`, `ledger.ts` and `money.ts` contain zero
references to inference, models, prompts or tokens. The coupling lives in the request schema and
the router — the part that decides _what_ a supplier serves, not _how_ they get paid.

Serving something other than chat completions means changing the schema and the upstream call. It
does not mean touching the settlement engine. That is the claim, and the table is why we can make
it.

**What is not true yet:** the node abstraction is called a GPU node, `NodeCapability` is expressed
in models and context windows, and pricing is per request rather than per unit of work. A generic
supplier interface is a refactor, not a rewrite — but it is a refactor nobody has done.

## Where this is actually useful

The pattern is: **many small payments, many suppliers, no account relationship, fee larger than
the payment.** Inference is one instance. Others fit better.

**Pay-per-crawl settlement.** Publishers want AI crawlers to pay. The unsolved half is the payout:
a crawler owing 10,000 publishers $0.0002 each cannot pay them, because the fee exceeds the
payment and no publisher is onboarding to an invoicing relationship for four cents a month. That
is this system with a different upstream. The demand is litigation-driven and exists today rather
than being predicted.

**Settlement as a service for API owners.** Anyone wanting agent-native pay-per-call has to build
what is in this repository. Offering it as a layer — they point an endpoint at the gateway, it
handles the challenge, the settlement and the payout — is a business with customers who can be
named now.

**Suppliers who cannot onboard to card rails.** Paying an address rather than a bank account
removes an onboarding step that excludes a lot of the world. Worth stating plainly that this cuts
both ways: no onboarding also means no KYC, and any serious version of it inherits a compliance
problem this project has not solved.

## The honest summary

We have a settlement rail with an inference demo attached, and we spent two days learning that
the rail is the difficult part. The leaderboard position is evidence the demo works. The 1,795
lines that do not mention inference are the thing worth reusing.

If you are evaluating this: read `packages/gateway/src/services/settlement.ts` and
`docs/what-shipping-payments-taught-us.md`. The routing is unremarkable. The money is not.
