import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  context,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { isProductionProfile, telemetryExporter } from "@ehf/identity";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

export { SpanKind, SpanStatusCode, context, trace, type Span } from "@opentelemetry/api";

const TRACE_ID = /^[a-f0-9]{32}$/;
const SPAN_ID = /^[a-f0-9]{16}$/;

export type TraceReference = { traceId: string; spanId: string; traceFlags: number };

/**
 * The OTLP trace exporter. Every observability backend -- an OpenTelemetry Collector,
 * Jaeger, Tempo, Honeycomb, Datadog, Elastic or a cloud vendor's OTLP endpoint -- accepts
 * OTLP, so the platform ships no vendor exporter; routing and vendor authentication belong
 * in the collector. `OTEL_EXPORTER_OTLP_PROTOCOL` picks `grpc`, `http/protobuf` or the
 * default `http/json`. Production must never silently export to the SDK's loopback
 * default, so it needs an explicit endpoint.
 */
export function createTraceExporter(env: NodeJS.ProcessEnv = process.env): SpanExporter {
  telemetryExporter(env);
  if (isProductionProfile(env) && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT && !env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    throw new Error("platform.production_requires:OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  }
  if (env.OTEL_EXPORTER_OTLP_PROTOCOL === "http/protobuf") {
    return new ProtoTraceExporter(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ? { url: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT } : {});
  }
  return env.OTEL_EXPORTER_OTLP_PROTOCOL === "grpc"
    ? new GrpcTraceExporter({
        ...(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
          ? { url: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }
          : env.OTEL_EXPORTER_OTLP_ENDPOINT
            ? { url: env.OTEL_EXPORTER_OTLP_ENDPOINT }
            : {}),
      })
    : new HttpTraceExporter({
        ...(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
          ? { url: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }
          : {}),
      });
}

export function initializeTelemetry(input: {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  region?: string;
}): NodeSDK {
  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? "1");
  const root = Number.isFinite(ratio) && ratio >= 0 && ratio < 1
    ? new TraceIdRatioBasedSampler(ratio)
    : new AlwaysOnSampler();
  const exporter = createTraceExporter(process.env);
  const sdk = new NodeSDK({
    resource: defaultResource().merge(resourceFromAttributes({
      [ATTR_SERVICE_NAME]: input.serviceName,
      [ATTR_SERVICE_VERSION]: input.serviceVersion ?? "0.1.0",
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: input.environment ?? process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
      "cloud.region": input.region ?? process.env.CLOUD_REGION ?? (isProductionProfile(process.env) ? "unknown" : "local"),
      "harness.telemetry.classification": "internal-operational",
    })),
    sampler: new ParentBasedSampler({ root }),
    traceExporter: exporter,
  });
  sdk.start();
  return sdk;
}

export function traceReference(span: Span): TraceReference {
  const value = span.spanContext();
  return { traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags };
}

export function contextFromTraceReference(reference: TraceReference | null | undefined): Context {
  if (!reference || !TRACE_ID.test(reference.traceId) || !SPAN_ID.test(reference.spanId)) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: reference.traceId,
    spanId: reference.spanId,
    traceFlags: reference.traceFlags & TraceFlags.SAMPLED,
    isRemote: true,
  });
}

export function extractTraceContext(carrier: Record<string, string | string[] | undefined>): Context {
  return propagation.extract(ROOT_CONTEXT, carrier, {
    keys: (value) => Object.keys(value),
    get: (value, key) => value[key.toLowerCase()],
  });
}

export function injectTraceContext(headers: Record<string, string>): void {
  propagation.inject(context.active(), headers, {
    set: (carrier, key, value) => { carrier[key] = value; },
  });
}

export function errorType(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 80);
  return "UnknownError";
}

export function recordFailure(span: Span, error: unknown): void {
  span.addEvent("exception", { "exception.type": errorType(error) });
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute("harness.outcome", "ERROR");
}

export async function withSpan<T>(
  name: string,
  options: SpanOptions & { attributes?: Attributes },
  fn: (span: Span) => Promise<T>,
  parent: Context = context.active(),
): Promise<T> {
  const tracer = trace.getTracer("harness.runtime", "0.1.0");
  const span = tracer.startSpan(name, options, parent);
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      return await fn(span);
    } catch (error) {
      recordFailure(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

export function workerSpanOptions(attributes: Attributes): SpanOptions {
  return { kind: SpanKind.CONSUMER, attributes };
}
