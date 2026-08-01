import { ConfigError } from "@x402-mesh/shared";
import type { DaemonConfig } from "@x402-mesh/shared";
import type { FetchLike } from "../http.js";
import { OllamaProvider } from "./ollama.js";
import type { InferenceProvider, ProviderOptions } from "./types.js";
import { VllmProvider } from "./vllm.js";

export type { InferenceProvider, ProviderOptions } from "./types.js";
export { OpenAiCompatibleProvider, DEFAULT_INFERENCE_TIMEOUT_MS } from "./openai-compatible.js";
export { OllamaProvider, OLLAMA_DEFAULT_BASE_URL } from "./ollama.js";
export { VllmProvider, VLLM_DEFAULT_BASE_URL, OPENAI_DEFAULT_BASE_URL } from "./vllm.js";

/** Overrides `createProvider` accepts on top of what `DaemonConfig` already carries. */
export interface CreateProviderOverrides {
  /** Injected `fetch`; defaults to the global. */
  fetchImpl?: FetchLike;
  /** Deadline for a single inference call, in milliseconds. */
  requestTimeoutMs?: number;
  /** Deadline for control-plane calls, in milliseconds. */
  controlTimeoutMs?: number;
  /**
   * Bearer token for a backend behind an auth proxy. Read from `MESH_PROVIDER_API_KEY` by
   * the CLI; never logged and never echoed in an error.
   */
  apiKey?: string;
}

/**
 * Builds the {@link InferenceProvider} named by `cfg.provider`.
 *
 * `cfg.providerBaseUrl` is already defaulted per provider by `loadDaemonConfig`, so this
 * function only has to pick an adapter.
 *
 * @throws {ConfigError} if `cfg.provider` is not a provider this daemon implements.
 */
export function createProvider(
  cfg: DaemonConfig,
  overrides: CreateProviderOverrides = {},
): InferenceProvider {
  const options: ProviderOptions = { baseUrl: cfg.providerBaseUrl };
  if (overrides.fetchImpl !== undefined) options.fetchImpl = overrides.fetchImpl;
  if (overrides.requestTimeoutMs !== undefined)
    options.requestTimeoutMs = overrides.requestTimeoutMs;
  if (overrides.controlTimeoutMs !== undefined)
    options.controlTimeoutMs = overrides.controlTimeoutMs;
  if (overrides.apiKey !== undefined) options.apiKey = overrides.apiKey;

  switch (cfg.provider) {
    case "ollama":
      return new OllamaProvider(options);
    case "vllm":
      return new VllmProvider(options);
    case "openai":
      // Same wire protocol as vLLM; only the label and the default base URL differ.
      return new VllmProvider(options, "openai");
    default:
      throw new ConfigError(`unsupported inference provider: ${String(cfg.provider)}`, {
        allowed: ["ollama", "vllm", "openai"],
      });
  }
}
