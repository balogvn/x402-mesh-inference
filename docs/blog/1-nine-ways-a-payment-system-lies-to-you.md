# Nine ways a payment system lies to you

Across fifteen commits in two days, the test suite was green for every single bug
below. Not one was caught by the thing we built to catch bugs.

I spent a fortnight building settlement infrastructure that moves real money:
an autonomous agent calls an API with no account and no API key, pays inline in
USDC on Algorand, and the platform pays the supplier who served the request. Two
on-chain money legs per request, both real, both on MainNet.

It works. It settles. What follows is not a post about it working.

Every failure here is a failure of _paying many suppliers a little at a time_ —
not of the thing being sold. That is why they generalise. If you are building
anything where small payments are split between parties who hold no account with
each other, you will meet most of these.

---

## 1. The passing test that protects the bug

A test asserted that a failed payout was recorded as failed. It passed. The
payout was also, in some paths, already on chain.

The test encoded the behaviour we had written, not the behaviour we wanted. It
was load-bearing in the worst way: it made the bug look deliberate. Anyone
reading the suite would conclude the failure path was considered and settled.

A test that passes against wrong behaviour is worse than no test, because it
transfers confidence to the wrong place.

## 2. Shipping a code-injection hole and finding it an hour later

Not a subtle one. It was in a code path I had read three times that day.

The lesson is not "review more carefully". It is that reading your own code an
hour after writing it does not work, and no amount of good intent fixes that.
The hole was found by someone approaching the file as an attacker rather than as
its author.

## 3. "Deployed" is not a value

We treated deployment as a boolean. It is not. A machine can be running, healthy,
serving traffic, and configured against the wrong network. Ours was.

"Is it deployed?" has no useful answer. "Is it deployed, against which chain,
with which wallet, holding which balance, opted in to which asset?" has one.

## 4. Two fields called "tags", one of which matters

Our service was invisible on a public catalogue for days.

The catalogue reads a tag from inside the payment requirement. We had put the tag
in a _different_ field, also called tags, which is descriptive metadata nobody
filters on. Both exist. Both are correct-looking. Only one does anything.

We found it by fetching the catalogue and diffing our entry against entries that
were visible. Not by reading documentation, which described both fields
accurately and never said which one the filter used.

## 5. The economics were a rounding error away from negative

A payout costs a flat network fee regardless of its size. At our original price,
the fee _was_ the entire margin. Every request netted exactly zero, and we had
been running it for a day.

This is not a chain-specific problem. Any per-transaction fee, on any rail, sets
a floor beneath which paying your supplier costs more than the payment is worth.
Below that floor you cannot have a marketplace — only a prepaid account with a
reconciliation problem.

That floor is the structural reason micropayment marketplaces do not exist.

## 6. Batching turns a fee problem into a money-loss problem

The fix for the fee is obvious: accrue what each supplier is owed, pay it in one
transfer. One fee instead of fourteen. That moved the fee from about a third of
margin to about three percent, and the saving grows with volume.

What is not obvious is that batching means **holding money you owe someone**.

Everything difficult followed from that. Accruals must outlive the process, or a
crash loses the record while the funds sit in the wallet with nothing to remember
them. Crash recovery must not double-pay — a process that dies mid-payout leaves
a record saying "pay this" when the transfer may already have committed. A payout
that exhausts its retries is still a debt, and deleting the record is how an
unpaid supplier becomes invisible.

Adversarial review found four double-pay paths in that code _after_ we thought it
was correct. Two could have sent a supplier money twice with nothing on chain to
undo it.

## 7. Two hypotheses that fit perfectly and were wrong

Twice I formed an explanation that accounted for every symptom, and twice it was
wrong. The second one I had already started fixing.

Both times the actual cause was found by querying the live system rather than by
reasoning about the code. The code says what it was meant to do. The chain says
what happened.

## 8. State outlives the assumptions it was created under

A supplier record was written while we were on a test network. We moved to
MainNet. The record survived — carrying a test-network identity and a permission
earned on the wrong chain.

Paid traffic was then routed to an address that could not receive the money. The
resulting debt could never be paid, was retried on every restart, and the
endpoint whose entire purpose was reporting what suppliers were owed reported
zero.

Stored state does not know that your assumptions changed.

## 9. The error that says nothing

An endpoint reported "2 of 2 suppliers routable". One was routable. The other was
the test-network record from the previous point, which the router correctly
refused.

Two pieces of code answered the same question — _can we route to this supplier?_
— and disagreed. A readiness check that over-reports capacity conceals an outage
until traffic fails, which is precisely the moment it existed to warn about.

The fix was not a third implementation. It was deleting one of the two and
importing the other.

---

## What I would tell someone starting now

**Green tests mean the tests passed.** They do not mean the system is right. Every
bug above shipped through a green suite.

**Ask the live system, not the code.** The code tells you what it was meant to do.
For anything involving money that has already moved, only the chain and the
database know what actually happened.

**Two implementations of one question will diverge.** Not might. The only question
is whether you find out from a test or from production.

**Write down why, not what.** Every fix above is now a comment carrying the
incident that produced it, because the reasoning is the part that does not
survive in the diff.

**The fee is the product.** If you are building anything that pays many suppliers
small amounts, the transaction fee is not an implementation detail you optimise
later. It determines whether the business is possible at all.

---

_The code is open: github.com/balogvn/x402-mesh-inference — the settlement layer
is in `packages/settlement` and mentions nothing about what is being sold._
