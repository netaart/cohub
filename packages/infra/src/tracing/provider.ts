import os from "node:os";
import { type Resource, resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FilteringSpanProcessor } from "./filtering.js";
import { serviceNameFromEnv } from "./service-name.js";

export type TracingOptions = {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  /** Additional span processors to register (e.g. for testing). */
  extraSpanProcessors?: import("@opentelemetry/sdk-trace-base").SpanProcessor[];
};

function envFlag(name: string, defaultValue = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (value == null || value === "") return defaultValue;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function envNumber(name: string, defaultValue: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

function resolveServiceName(serviceName: string, environment: string) {
  return environment === "dev" && !serviceName.endsWith("-dev") ? `${serviceName}-dev` : serviceName;
}

/**
 * Resolve an OTLP traces endpoint from standard OpenTelemetry env vars.
 *
 * Remote export is opt-in: without an explicit endpoint, Cohub does not send
 * spans to any hosted collector. This keeps self-hosted deployments private by
 * default.
 *
 * Supported env vars (first match wins):
 * - `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` (appended with `/v1/traces` when needed)
 */
export function resolveOtlpTracesEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (tracesEndpoint) return tracesEndpoint.replace(/\/+$/, "");

  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!baseEndpoint) return undefined;

  const normalized = baseEndpoint.replace(/\/+$/, "");
  if (normalized.endsWith("/v1/traces")) return normalized;
  return `${normalized}/v1/traces`;
}

/**
 * Initialize OpenTelemetry tracing for a service.
 * Call this as early as possible (before any other imports that make network calls).
 *
 * Default behavior:
 * - no remote exporter unless `OTEL_EXPORTER_OTLP_*` is configured
 * - console exporter is opt-in via `OTEL_CONSOLE_EXPORTER`
 * - set `OTEL_SDK_DISABLED=true` to skip initialization entirely
 */
export function initTracing(options: TracingOptions) {
  if (envFlag("OTEL_SDK_DISABLED")) return;

  const ENV = options.environment ?? process.env.ENV ?? "dev";
  const serviceName = resolveServiceName(serviceNameFromEnv(options.serviceName), ENV);
  const resource: Resource = resourceFromAttributes({
    "service.name": serviceName,
    "service.version": options.serviceVersion ?? process.env.IMAGE_TAG ?? "latest",
    "deployment.environment": ENV,
    "host.name": os.hostname(),
  });

  const spanProcessors: import("@opentelemetry/sdk-trace-base").SpanProcessor[] = [];

  const dropRealtimeRedisSpans = envFlag("OTEL_DROP_REALTIME_REDIS_SPANS", true);
  const wrapSpanProcessor = (processor: import("@opentelemetry/sdk-trace-base").SpanProcessor) =>
    new FilteringSpanProcessor(processor, { dropRealtimeRedisSpans });

  // Remote export is opt-in. Self-hosted installs stay silent until an OTLP
  // endpoint is configured explicitly.
  const otlpEndpoint = resolveOtlpTracesEndpoint();
  if (otlpEndpoint) {
    const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
    spanProcessors.push(wrapSpanProcessor(new BatchSpanProcessor(exporter)));
  }

  // Console span export is intentionally opt-in. It is very expensive for streaming
  // agent workloads because every span is serialized and written to stdout.
  if (envFlag("OTEL_CONSOLE_EXPORTER")) {
    spanProcessors.push(wrapSpanProcessor(new BatchSpanProcessor(new ConsoleSpanExporter(), {
      maxQueueSize: 256,
      maxExportBatchSize: 32,
      scheduledDelayMillis: 1000,
    })));
  }

  if (options.extraSpanProcessors) {
    spanProcessors.push(...options.extraSpanProcessors);
  }

  const provider = new NodeTracerProvider({
    resource,
    sampler: new TraceIdRatioBasedSampler(Math.min(1, Math.max(0, envNumber("OTEL_TRACE_SAMPLE_RATIO", 1)))),
    spanProcessors,
  });

  if (envFlag("OTEL_AUTO_INSTRUMENTATION", true)) {
    const instrumentations = [
      envFlag("OTEL_INSTRUMENT_HTTP", true) ? new HttpInstrumentation() : null,
      envFlag("OTEL_INSTRUMENT_UNDICI", true) ? new UndiciInstrumentation() : null,
      envFlag("OTEL_INSTRUMENT_REDIS", options.serviceName !== "cohub-agent")
        ? new IORedisInstrumentation({
            requireParentSpan: true,
            dbStatementSerializer: (cmdName, cmdArgs) => {
              const firstArg = String(cmdArgs[0] ?? "");
              return firstArg ? `${cmdName} ${firstArg}` : cmdName;
            },
            requestHook: (span, requestInfo) => {
              const firstArg = String(requestInfo.cmdArgs[0] ?? "");
              if (firstArg) span.setAttribute("redis.key", firstArg.slice(0, 160));
            },
          })
        : null,
    ].filter((item): item is NonNullable<typeof item> => item != null);

    registerInstrumentations({
      tracerProvider: provider,
      instrumentations,
    });
  }

  provider.register();
}
