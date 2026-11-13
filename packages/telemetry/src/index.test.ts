import { describe, expect, it } from "vitest";
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { contextFromTraceReference, createTraceExporter, errorType } from "./index.js";
import { trace } from "@opentelemetry/api";

describe("telemetry safety helpers", () => {
  it("reconstructs only valid W3C span context", () => {
    const valid = contextFromTraceReference({
      traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1,
    });
    expect(trace.getSpanContext(valid)?.traceId).toBe("a".repeat(32));
    expect(trace.getSpanContext(contextFromTraceReference({ traceId: "bad", spanId: "bad", traceFlags: 1 }))).toBeUndefined();
  });

  it("does not expose exception messages", () => {
    expect(errorType(new TypeError("customer name and secret"))).toBe("TypeError");
  });
});

describe("TELEMETRY_EXPORTER", () => {
  it("defaults to OTLP over HTTP, or gRPC when the protocol asks for it", () => {
    expect(createTraceExporter({})).toBeInstanceOf(HttpTraceExporter);
    expect(createTraceExporter({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317" })).toBeInstanceOf(GrpcTraceExporter);
  });
  it("requires an explicit OTLP endpoint under the production profile", () => {
    expect(() => createTraceExporter({ SECURITY_PROFILE: "production" })).toThrow("platform.production_requires:OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
    expect(createTraceExporter({ SECURITY_PROFILE: "production", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example.test/v1/traces" })).toBeInstanceOf(HttpTraceExporter);
  });
  it("speaks OTLP protobuf when asked and refuses vendor-specific exporters", () => {
    expect(createTraceExporter({ OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" })).toBeInstanceOf(ProtoTraceExporter);
    expect(() => createTraceExporter({ TELEMETRY_EXPORTER: "azure_monitor" })).toThrow("platform.setting_unsupported:TELEMETRY_EXPORTER=azure_monitor");
    expect(() => createTraceExporter({ TELEMETRY_EXPORTER: "jaeger" })).toThrow("platform.setting_unsupported:TELEMETRY_EXPORTER=jaeger");
  });
});
