import type { GatewayConfig } from "@x402-mesh/shared";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";

/**
 * Builds the x402 resource server.
 *
 * `@x402/avm` publishes three different `ExactAvmScheme` implementations under
 * `/exact/client`, `/exact/server` and `/exact/facilitator`. The gateway is a *resource
 * server* — it declares prices and asks a facilitator to verify and settle — so it must use
 * the `/exact/server` one. Importing either of the others compiles cleanly and then fails at
 * runtime, which is exactly the kind of mistake worth spelling out.
 *
 * The network is registered in canonical (truncated genesis hash) CAIP-2 form; `GatewayConfig`
 * has already normalized it, so no reconciliation is needed here.
 *
 * @param config - Resolved gateway configuration.
 * @param facilitator - Facilitator client override. Tests pass a stub so no HTTP happens;
 * production leaves it undefined and gets an {@link HTTPFacilitatorClient} for
 * `config.facilitatorUrl`.
 */
export function buildResourceServer(
  config: GatewayConfig,
  facilitator?: FacilitatorClient,
): x402ResourceServer {
  const client = facilitator ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  return new x402ResourceServer(client).register(config.network, new ExactAvmScheme());
}
