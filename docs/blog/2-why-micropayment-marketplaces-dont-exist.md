# Why micropayment marketplaces don't exist

A payout costs a flat network fee whatever its size. On a small enough payment,
paying your supplier costs more than the payment is worth. That floor is not a
technology problem — it is the reason an entire category of business is missing.

I spent a fortnight building an AI inference marketplace, and described it that
way for two days before noticing that inference was the least interesting part
of it.

Serving a large language model is a commodity. Several companies do it well and
all of them take a credit card. Nothing about my routing layer beat theirs.

What is not a commodity is this:

> **Splitting a micropayment between a platform and a supplier, on-chain, where
> neither party holds an account with the other, and amortizing the transaction
> fee so the split is economically possible at all.**

That sentence is the product. Inference was the first thing I plugged into it.

## The arithmetic that kills the category

Take a $0.0060 request at a 15% margin. The platform earns $0.0009.

The payout to the supplier costs a flat network fee — call it $0.0003. That is a
third of the margin, gone, on every single request. At my original price of
$0.0020, the fee _was_ the entire margin. Every request netted exactly zero, and
I had been running it for a day before noticing.

This is not specific to any one chain. Any per-transaction fee, on any rail,
sets a floor beneath which paying a supplier costs more than the payment is
worth. Below that floor you cannot have a marketplace. You can only have a
prepaid account with a reconciliation problem — which is exactly what every
existing API marketplace is, and exactly why none of them pay out per call.

## The fix, and what it actually costs

Accrue what each supplier is owed. Settle in one transfer.

Verified on MainNet: one fee, fourteen requests. That moves the fee from around
a third of margin to around three percent, and unlike most optimisations the
saving _grows_ with volume rather than shrinking.

Four lines of arithmetic. And then a very large amount of failure handling,
because batching means holding money you owe someone.

Everything difficult follows from that:

**Accruals must be durable.** Money owed has to outlive the process. Without
that, a crash loses the record while the funds sit in the wallet and nothing
remembers to send them.

**Crash recovery must not double-pay.** Persisting a liability is easy. A process
that dies _mid-payout_ leaves a record saying "pay this" when the transfer may
already be on chain. The batch identifier has to be written down before the
payout is attempted and reused verbatim on recovery, so a retry carries the same
lease as the attempt that may have committed.

**A failed payout is still a debt.** Deleting the record is how an unpaid
supplier becomes invisible.

**The ledger must survive a deploy**, because the chain records the transfer and
not the accounting behind it.

**Suppliers can stop existing**, and a node switched off keeps its last-known
healthy flag forever unless something ages it out.

Adversarial review found four double-pay paths in that code after I thought it
was correct. Two could have sent a supplier money twice, with nothing on chain
to undo it.

## How domain-specific is any of this?

I measured rather than asserted.

The settlement, accrual and ledger code runs to roughly 1,800 lines and contains
zero references to inference, models, prompts or tokens. One comment mentions
"chat", once. The coupling to the actual product lives entirely in the request
schema and the router — the part that decides _what_ a supplier serves, not
_how_ they get paid.

Serving something other than model completions means changing the schema and the
upstream call. It does not mean touching the settlement engine.

Being honest about what is _not_ true yet: the supplier abstraction is still
called a GPU node, capability is expressed in models and context windows, and
pricing is per request rather than per unit of work. A generic supplier
interface is a refactor, not a rewrite — but it is a refactor nobody has done.

## Where this pattern actually fits

The shape is: **many small payments, many suppliers, no account relationship,
and a fee larger than the payment.** Inference is one instance of it. Others fit
better.

**Pay-per-crawl.** Publishers want AI crawlers to pay for what they take. The
unsolved half is not the charging — it is the payout. A crawler owing 10,000
publishers $0.0002 each cannot pay them: the fee exceeds the payment, and no
publisher is onboarding to an invoicing relationship for four cents a month.
That is this system with a different thing on top, and the demand is
litigation-driven and exists today rather than being forecast.

**Settlement as a service.** Anyone who wants agent-native pay-per-call has to
build what I just built. Offering it as a layer — point an endpoint at it, and
it handles the challenge, the settlement and the payout — has customers who can
be named now rather than imagined.

## The part worth taking away

If you are building anything that pays many suppliers small amounts, the
transaction fee is not an implementation detail to optimise later. It decides
whether the business exists.

I found that out by shipping a system where the margin was, for one full day,
exactly zero.

---

_Open source: github.com/balogvn/x402-mesh-inference — the settlement layer is in
`packages/settlement`, and it mentions nothing about what is being sold._
