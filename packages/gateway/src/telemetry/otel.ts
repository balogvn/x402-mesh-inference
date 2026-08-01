import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span, Tracer } from "@opentelemetry/api";
import type { Logger } from "../logger.js";

/**
 * OpenTelemetry wiring.
 *
 * Two hard rules, because a settlement gateway must not fall over when its observability
 * stack does:
 *
 * 1. Everything here is optional. With `otelEnabled: false` (the default) nothing is
 *    imported beyond `@opentelemetry/api`, whose global tracer is already a no-op.
 * 2. An unreachable collector must never surface as a request failure. The OTLP exporter
 *    retries and drops on its own; we additionally swallow initialization errors so a typo
 *    in `OTEL_EXPORTER_OTLP_ENDPOINT` degrades telemetry rather than the service.
 *
 * {@link withSpan} is therefore safe to call unconditionally — it is a thin pass-through
 * when no SDK is running.
 */

/** Instrumentation scope name used for every span the gateway creates itself. */
export const TRACER_NAME = "@x402-mesh/gateway";

/** Subset of {@link import("@x402-mesh/shared").GatewayConfig} telemetry needs. */
export interface TelemetryConfig {
  otelEnabled: boolean;
  otelExporterUrl?: string;
  meshNetwork: string;
}

/** Handle returned by {@link initTelemetry}; `shutdown` is always safe to call. */
export interface TelemetryHandle {
  /** True when a real SDK was started. */
  readonly enabled: boolean;
  /** Flushes and stops the SDK. Resolves immediately when telemetry is disabled. */
  shutdown(): Promise<void>;
}

const DISABLED: TelemetryHandle = {
  enabled: false,
  shutdown: () => Promise.resolve(),
};

let tracer: Tracer | undefined;

/** Lazily resolves the tracer so `withSpan` works before (and without) SDK initialization. */
function getTracer(): Tracer {
  tracer ??= trace.getTracer(TRACER_NAME, "0.1.0");
  return tracer;
}

/**
 * Starts the OpenTelemetry Node SDK when `config.otelEnabled` is true.
 *
 * The heavy SDK packages are imported dynamically so that a deployment with telemetry off
 * never pays their startup cost. Failures are logged and swallowed.
 *
 * @param config - Telemetry-relevant slice of the gateway config.
 * @param logger - Where initialization problems are reported.
 * @returns A handle whose `shutdown()` is safe to call unconditionally.
 */
export async function initTelemetry(
  config: TelemetryConfig,
  logger: Logger,
): Promise<TelemetryHandle> {
  if (!config.otelEnabled) return DISABLED;

  try {
    const [{ NodeSDK }, { OTLPTraceExporter }, { Resource }, semconv] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
    ]);

    const exporterOptions = config.otelExporterUrl ? { url: config.otelExporterUrl } : {};
    const sdk = new NodeSDK({
      resource: new Resource({
        [semconv.ATTR_SERVICE_NAME]: "x402-mesh-gateway",
        [semconv.ATTR_SERVICE_VERSION]: "0.1.0",
        "mesh.network": config.meshNetwork,
      }),
      traceExporter: new OTLPTraceExporter(exporterOptions),
    });

    sdk.start();
    // Reset the memoized tracer: it may have been captured before a provider existed.
    tracer = undefined;
    logger.info({ exporter: config.otelExporterUrl ?? "default" }, "telemetry started");

    return {
      enabled: true,
      shutdown: async () => {
        try {
          await sdk.shutdown();
        } catch (error) {
          logger.warn({ reason: describe(error) }, "telemetry shutdown failed");
        }
      },
    };
  } catch (error) {
    logger.warn({ reason: describe(error) }, "telemetry disabled: initialization failed");
    return DISABLED;
  }
}

/**
 * Runs `fn` inside a span named `name`.
 *
 * Exceptions are recorded on the span, the span status is set to ERROR, and the original
 * error is rethrown unchanged — tracing observes, it never alters control flow. When no SDK
 * is running the API's no-op tracer makes this a cheap function call.
 *
 * @param name - Span name, e.g. `"gateway.payout"`.
 * @param fn - Work to instrument. Receives the span so it can add attributes.
 * @param attributes - Attributes set on the span before `fn` runs.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  return getTracer().startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: describe(error) });
      if (error instanceof Error) span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Extracts a short, safe description from an unknown throwable. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
