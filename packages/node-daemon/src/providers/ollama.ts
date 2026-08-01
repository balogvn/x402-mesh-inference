import { UpstreamError } from "@x402-mesh/shared";
import { joinUrl } from "../http.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ProviderOptions } from "./types.js";

/** Ollama's conventional loopback listener. */
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

/**
 * Adapter for [Ollama](https://ollama.com).
 *
 * Ollama exposes two surfaces: its native API under `/api`, and an OpenAI-compatible one
 * under `/v1`. Inference goes through `/v1/chat/completions` so the whole mesh speaks one
 * wire format, but model enumeration uses the native `GET /api/tags` — the OpenAI `/v1/models`
 * route exists yet reports only a subset on some builds, whereas `/api/tags` always lists
 * everything `ollama pull` has fetched, which is what an operator means by "my models".
 */
export class OllamaProvider extends OpenAiCompatibleProvider {
  readonly name = "ollama";

  constructor(options: ProviderOptions) {
    super(options, "/v1");
  }

  /** Absolute URL of Ollama's native model-listing endpoint. */
  get tagsUrl(): string {
    return joinUrl(this.baseUrl, "/api/tags");
  }

  /**
   * Lists locally available models via `GET /api/tags`.
   *
   * Names are returned exactly as Ollama reports them (`"llama3.1:8b"`), because that is the
   * string a completion request must carry.
   *
   * @throws {UpstreamError} if Ollama is unreachable or the payload has no `models` array.
   */
  override async listModels(): Promise<string[]> {
    const body = await this.getJson(this.tagsUrl, "model listing");
    const models = (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(models)) {
      throw new UpstreamError("ollama model listing did not contain a models array", {
        upstream: this.name,
      });
    }
    const names: string[] = [];
    for (const entry of models) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      // `name` is the canonical field; `model` appears on newer builds and is identical.
      const name = record["name"] ?? record["model"];
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
    return names;
  }
}
