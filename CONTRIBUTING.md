# Contributing

Thanks for helping. This is a payments system, so the conventions below are stricter than they
would be for an ordinary TypeScript monorepo — a defect here does not throw an exception, it
moves money to the wrong place or fails to move it at all.

## Setup

Node **≥ 20.11** (CI runs 20.11 and 22).

```bash
npm ci
```

```bash
npm run build
```

Read [`docs/x402-integration-notes.md`](docs/x402-integration-notes.md) before you touch anything
on the payment path. Every value in it was verified against the published `@x402/*@2.20.0` type
definitions and a live facilitator probe. The x402 protocol post-dates most model training data,
so identifiers recalled "from memory" — CAIP-2 ids, ASA ids, subpath exports, payload shapes —
are usually wrong, and they fail _silently_ at settlement rather than loudly at compile time.

## The verify gate

One command has to pass before anything is merged:

```bash
npm run verify
```

That is `format:check` → `lint` → `typecheck` → `test`, in that order. `typecheck` is three
separate passes:

| Pass                           | Covers                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| `tsc --build --force`          | the four package project references                        |
| `tsc -p tsconfig.tests.json`   | **test files, under the same strict flags as source**      |
| `tsc -p scripts/tsconfig.json` | the operator scripts, which the package build does not see |

If you touch a test, run `npx tsc -p tsconfig.tests.json` before declaring done — a test that
runs green under vitest can still fail the typecheck.

Two more checks run in CI and are cheap to run locally:

```bash
npx tsx scripts/validate-spec.ts
```

```bash
npx tsx scripts/e2e-simulate.ts
```

The first validates `spec/openapi.yaml`, `spec/well-known-x402.json`, `spec/llms.txt` and that
`.env.example` still loads through both real config loaders. The second asserts the whole
402 → pay → route → stream → split loop in-process, with no chain, no network and no secrets.

## Conventions

### ESM + NodeNext

**Every relative import needs an explicit `.js` extension, even from a `.ts` file.**

```ts
import { computeSplit } from "./pricing.js"; // correct
import { computeSplit } from "./pricing"; //    build break
```

This is the single most common way to break the build.

### Strict TypeScript

`tsconfig.base.json` enables, among others:

- `noUncheckedIndexedAccess` — `arr[0]` is `T | undefined`. Narrow it; do not assert it away.
- `verbatimModuleSyntax` — type-only imports **must** use `import type`.
- `noUnusedLocals` / `noUnusedParameters` — prefix a deliberately unused parameter with `_`.
- `exactOptionalPropertyTypes: false`, but optional properties are still assigned conditionally
  (`...(x ? { x } : {})`) rather than being set to `undefined`.

### Money is `bigint`

All amounts are integer atomic units of USDC (6 decimals). **Never** apply floating-point
arithmetic to an amount, and never `parseFloat` a price. Use `usdcToAtomic` / `atomicToUsdc` /
`atomicToWire` from `@x402-mesh/shared`, and `computeSplit` for the payout/margin split. The
invariant `inbound − payout === margin` is asserted, not assumed; keep it that way.

### Formatting

Prettier 3.5.2, configured as double quotes, semicolons, trailing commas, 100 columns.

```bash
npm run format
```

### Errors

Throw a `MeshError` subclass from `@x402-mesh/shared` (`ValidationError`, `AuthError`,
`PaymentError`, `SettlementError`, `NoCapacityError`, `UpstreamError`, `RateLimitError`,
`ConfigError`, `PricingError`). Each carries a stable machine-readable `code` and the right HTTP
status. **Never change an existing `code`** — clients depend on it.

### Logging

`logger.info({ structured: "fields" }, "short message")` — object first, message second. Never
interpolate a value into the message string; that is how secrets leak. Never log a private key,
a payment header, or an `Authorization` value, even redacted-by-hand.

## Integrity rules

These are not style preferences.

- **Never silence a problem** with `any`, `@ts-ignore`, `@ts-expect-error`, an `eslint-disable`
  comment, `.skip`, or by deleting a test. Fix the root cause.
- **Never weaken** `tsconfig`, the eslint config, or an assertion to make something pass.
- **No network calls in unit tests.** Stub `fetch`, algod and the facilitator. Inject clocks and
  sleeps rather than waiting.
- **Report honestly.** If something is still broken, say so precisely in the PR description. The
  README has a "Known gaps" section for exactly this reason — an accurate limitation is worth far
  more than an overstated capability.

## Ownership

The repository is split so parallel work does not collide. Stay inside the area you are changing:

| Area                                    | Contains                                                   |
| --------------------------------------- | ---------------------------------------------------------- |
| `packages/shared/`                      | money, pricing, schemas, signing, networks, config, errors |
| `packages/registry/`                    | node store (memory + Redis) and the selector               |
| `packages/gateway/`                     | the Express app, paywall, routing, settlement, discovery   |
| `packages/node-daemon/`                 | the `x402-mesh-node` CLI and the operator HTTP server      |
| `spec/`                                 | `openapi.yaml`, `well-known-x402.json`, `llms.txt`         |
| `scripts/`                              | keygen, preflight, validate-spec, e2e harnesses            |
| `.github/`, `docker/`                   | CI workflows and images                                    |
| `README.md`, `CONTRIBUTING.md`, `docs/` | documentation                                              |

`docs/x402-integration-notes.md` is a special case: it records empirically verified protocol
facts. Correct it only with evidence from a fresh probe or from the installed `.d.ts` files —
never from memory.

Dependencies are pinned deliberately (`@algorandfoundation/algokit-utils` is an exact alpha
pin). Do not add, remove or float a dependency as a side effect of another change.

## Pull requests

- One concern per PR.
- `npm run verify` green, plus `validate-spec` and `e2e-simulate` if you touched the contract or
  the payment path.
- Say what you tested and what you did **not**.
- New behaviour on the money path needs a test that would fail without the change.

By contributing you agree your contributions are licensed under [Apache-2.0](LICENSE).
