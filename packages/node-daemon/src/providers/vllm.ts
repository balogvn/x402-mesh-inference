import { UpstreamError } from "@x402-mesh/shared";
import { joinUrl } from "../http.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ProviderOptions } from "./types.js";

/** vLLM's conventional OpenAI-compatible listener. */
export const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000";

/** `api.openai.com` — the hosted backend, useful for a node with no local GPU. */
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";

/**
 * Adapter for any server that is OpenAI-compatible end to end — vLLM, and OpenAI itself.
 *
 * Everything except model enumeration is inherited: vLLM implements the same
 * `/v1/chat/completions` semantics and the same SSE framing, so duplicating the stream parser
 * here would only create two places for a framing bug to hide.
 */
export class VllmProvider extends OpenAiCompatibleProvider {
  readonly name: string;

  /**
   * @param options - Backend location and timeouts.
   * @param name - Adapter label used in logs and error messages.
   */
  constructor(options: ProviderOptions, name = "vllm") {
    super(options, "/v1");
    this.name = name;
  }

  /** Absolute URL of the OpenAI-compatible model-listing endpoint. */
  get modelsUrl(): string {
    return joinUrl(this.baseUrl, "/v1/models");
  }

  /**
   * Lists served models via `GET /v1/models`.
   *
   * @throws {UpstreamError} if the backend is unreachable or the payload has no `data` array.
   */
  override async listModels(): Promise<string[]> {
    const body = await this.getJson(this.modelsUrl, "model listing");
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new UpstreamError(`${this.name} model listing did not contain a data array`, {
        upstream: this.name,
      });
    }
    const names: string[] = [];
    for (const entry of data) {
      if (typeof entry !== "object" || entry === null) continue;
      const id = (entry as Record<string, unknown>)["id"];
      if (typeof id === "string" && id.length > 0) names.push(id);
    }
    return names;
  }
}
