# x402 Integration Notes — Empirically Verified Ground Truth

> Every fact in this file was verified by inspecting the published `.d.ts` files of
> `@x402/*@2.20.0` and by executing a live probe against the installed packages and the
> GoPlausible facilitator on 2026-07-31. **Do not "improve" these values from memory** — the
> protocol post-dates most model training data, and guessed identifiers will silently fail
> settlement.

---

## 1. Package set (installed and verified)

| Package            | Version | Purpose                                                      |
| ------------------ | ------- | ------------------------------------------------------------ |
| `@x402/core`       | 2.20.0  | Protocol core, `x402ResourceServer`, `HTTPFacilitatorClient` |
| `@x402/avm`        | 2.20.0  | **Algorand** implementation — authored by **GoPlausible**    |
| `@x402/express`    | 2.20.0  | `paymentMiddleware` for Express                              |
| `@x402/extensions` | 2.20.0  | Bazaar discovery extension                                   |

`@x402/avm` depends on `@algorandfoundation/algokit-utils@10.0.0-alpha.46` (pinned exactly —
it is an alpha; do not float this range).

### Verified subpath exports

```ts
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, setSettlementOverrides } from "@x402/express";
import { ExactAvmScheme } from "@x402/avm/exact/server"; // resource server
import { ExactAvmScheme as ClientScheme } from "@x402/avm/exact/client";
import { declareDiscoveryExtension, withBazaar } from "@x402/extensions/bazaar";
import * as avm from "@x402/avm"; // constants + helpers
```

> `@x402/avm` exports `ExactAvmScheme` from **three** distinct subpaths
> (`/exact/client`, `/exact/server`, `/exact/facilitator`) with **different** implementations.
> The gateway is a _resource server_ → always `@x402/avm/exact/server`.

---

## 2. Network identifiers — the truncation trap

Algorand CAIP-2 uses the **first 32 characters** of the url-safe base64 genesis hash:

```
ALGORAND_MAINNET_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"
ALGORAND_TESTNET_CAIP2 = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe"
```

**However**, the live GoPlausible facilitator's `/supported` response advertises the
**full, padded** genesis hash:

```
algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=
algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=
```

These are the **same network** in two encodings. The SDK reconciles them:

```ts
avm.normalizeAlgorandNetwork("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=");
// → "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"   (verified at runtime)
```

**Rule:** always store/compare networks in _canonical_ (truncated) form, and pipe any
externally-sourced network string through `normalizeAlgorandNetwork()` at the boundary.
Never string-compare a raw facilitator network value against a local constant.

The brief's placeholder tokens `ALGORAND_Mainnet_CAIP2` / `ALGORAND_Testnet_CAIP2` are **not**
real values — substitute the constants above.

---

## 3. USDC assets

`avm.USDC_CONFIG` is keyed by canonical CAIP-2 (verified):

```json
{
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k": {
    "asaId": "31566704",
    "name": "USDC",
    "decimals": 6
  },
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe": {
    "asaId": "10458941",
    "name": "USDC",
    "decimals": 6
  }
}
```

Mainnet ASA `31566704`, Testnet ASA `10458941`, **6 decimals** on both. Prefer reading from
`USDC_CONFIG` over hardcoding, so a network switch cannot desync the asset id.

---

## 4. Facilitator

Live and verified: **`https://facilitator.goplausible.xyz`**
(`GET /supported` → HTTP 200, advertises `exact` on both Algorand networks, x402Version 2).

Its Algorand entries carry a sponsor account:

```json
"extra": { "feePayer": "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA" }
```

This is what makes payments **gasless for the client** — the facilitator sponsors the ALGO
transaction fee and the client only signs the ASA transfer leg. Construct with:

```ts
new HTTPFacilitatorClient({ url: process.env.X402_FACILITATOR_URL });
```

`FacilitatorConfig.createAuthHeaders` must return headers **keyed by path**
(`{ verify: {...}, settle: {...}, supported: {...}, bazaar: {...} }`). Returning a flat
`{ Authorization: "..." }` object **throws** — the SDK rejects it rather than silently
dropping auth.

---

## 5. Core protocol types (v2)

```ts
type Network = `${string}:${string}`;
type Money = string | number; // "$0.0020" or 0.002
type Price = Money | { asset: string; amount: string; extra?: Record<string, unknown> };

type PaymentRequirements = {
  scheme: string;
  network: Network;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};

type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};
```

> Note v2 uses `amount`; **v1** used `maxAmountRequired` + flat `resource: string`. We target
> **v2 only**. Do not mix `PaymentRequirementsV1` fields in.

### Route configuration

```ts
interface ResourceConfig {
  // a.k.a. PaymentOption
  scheme: string;
  payTo: string;
  price: Price;
  network: Network;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

interface RouteConfig {
  accepts: PaymentOption | PaymentOption[];
  resource?: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  customPaywallHtml?: string;
  unpaidResponseBody?: UnpaidResponseBody;
  settlementFailedResponseBody?: SettlementFailedResponseBody;
  extensions?: Record<string, unknown>; // ← Bazaar goes here
}

type RoutesConfig = Record<string, RouteConfig> | RouteConfig; // key: "POST /v1/chat/completions"
```

### Middleware signature

```ts
paymentMiddleware(
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart?: boolean,   // defaults true
): (req, res, next) => Promise<void>
```

Wiring (verified to construct and register successfully):

```ts
const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).register(
  NETWORK_CAIP2,
  new ExactAvmScheme(),
);
```

---

## 6. Bazaar discovery extension

`declareDiscoveryExtension(config)` returns a record already keyed `{ bazaar: {...} }`
(verified) — assign it **directly** to `RouteConfig.extensions`, do not re-wrap:

```ts
extensions: declareDiscoveryExtension({
  bodyType: "json",                       // required for POST/PUT/PATCH
  input: { model: "…", messages: [ … ] }, // example input, not a schema
  output: { example: { … } },
})
```

`method` is **omitted** at declaration time — `bazaarResourceServerExtension.enrichDeclaration`
fills it from the route key. Passing `method` yourself is a type error
(`DeclareDiscoveryExtensionInput` uses `DistributiveOmit<…, "method">`).

Discovery metadata (`serviceName`, `tags`, `iconUrl`) is **soft-dropped** if invalid — see
`sanitizeResourceServiceMetadata`. Tags must survive `sanitizeTags`, so keep them short,
lowercase and hyphenated.

**The mandatory challenge tag `x402-global-challenge` belongs in `RouteConfig.tags`.**

---

## 7. AVM payment payload shape

```ts
interface ExactAvmPayloadV2 {
  paymentGroup: string[]; // base64 msgpack txns forming ONE atomic group
  paymentIndex: number; // 0-based index of the ASA transfer leg
}
```

The group is atomic: the facilitator's fee-payer transaction and the client's ASA transfer
either both commit or both fail. `isExactAvmPayload(payload)` is the exported type guard.

Facilitator rejection reasons are exported as string constants from
`@x402/avm/exact/facilitator` (`ErrAmountMismatch`, `ErrReceiverMismatch`, `ErrAssetMismatch`,
`ErrFeeTooHigh`, `ErrSimulationFailed`, `ErrConfirmationFailed`, …). Map these to
operator-actionable gateway errors rather than surfacing raw strings.

---

## 8. Algorand account prerequisites (a real deployment blocker)

Algorand is opt-in: an account **cannot receive an ASA it has not opted into**, and every
account must hold a Minimum Balance Requirement in ALGO.

- Base MBR: **0.1 ALGO** per account, **+0.1 ALGO per ASA** opted in.
- The **client** (payer), the **gateway** (`payTo`), **and every node operator** wallet must
  each opt in to the USDC ASA before any payment or payout can land.
- An opt-in is a 0-amount asset transfer to self.

Faucets — ALGO: `https://lora.algokit.io/testnet/fund`, USDC: `https://faucet.circle.com/`.

Because payout failures here are silent-until-runtime, node registration **must** verify the
operator's `payTo` account is opted in to USDC before the node is marked eligible for routing.

### Key format

`AVM_PRIVATE_KEY` is base64 of the **64-byte** Algorand secret key (32-byte Ed25519 seed ‖
32-byte public key). Derive the address with `toClientAvmSigner(key).address`. Never log it.

---

## 9. Economics (from the brief)

| Leg                     | Amount       | Atomic (6dp) |
| ----------------------- | ------------ | ------------ |
| Client → Gateway        | $0.0020 USDC | `2000`       |
| Gateway → Node operator | $0.0017 USDC | `1700`       |
| Gateway margin          | $0.0003 USDC | `300`        |

Invariant to assert in code and in tests: `inbound − payout = margin`, all three
non-negative, computed in **integer atomic units only**. Never do float arithmetic on money.
