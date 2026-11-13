import type { SandboxRuntimeObservation } from "./sandbox-observation.js";
export * from "./sandbox-observation.js";
import { z } from "zod";
import { injectTraceContext } from "@ehf/telemetry";
export * from "./invocations.js";

/**
 * The run, attempt and fence a runtime is acting under.
 *
 * Every state write names its fence so a runtime that lost its lease cannot journal
 * over the work of the worker that replaced it.
 */
export type FencedRun = {
  runId: string;
  attempt: number;
  workerId: string;
  fencingEpoch: number;
};

export const runtimeEventSchema = z.object({
  eventKey: z.string().min(1),
  code: z.string().regex(/^[a-z0-9_.-]+$/),
  nodeId: z.string().min(1).nullable(),
  status: z.enum(["observed", "passed", "failed", "denied"]),
  values: z.record(z.string(), z.unknown()),
}).strict();

/**
 * A node transition may carry the journal event that announces it, so the runtime records
 * both in one write instead of two round trips to the control plane.
 */
export const nodeStartedSchema = z.object({
  nodeId: z.string().min(1),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  traceId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  spanId: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  event: runtimeEventSchema.optional(),
  /**
   * Ask for the node's case-read envelope in the same write. Starting a node is exactly when
   * its read authority is issued, and the control plane has just re-checked the grant and the
   * fence for this write, so issuing it here saves a separate exchange per node.
   */
  issueCaseReadEnvelope: z.boolean().optional(),
}).strict();

/** What starting a node may hand back: the node's case-read envelope, when asked for. */
export type NodeStartedResult = { caseReadEnvelope?: { envelope: string; expiresInSeconds: number } };

export const nodeFinishedSchema = z.object({
  nodeId: z.string().min(1),
  status: z.enum(["completed", "failed"]),
  outputDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  errorCode: z.string().min(1).optional(),
  event: runtimeEventSchema.optional(),
}).strict();

export const checkpointSchema = z.object({
  checkpointId: z.string().min(1).nullable(),
  nodeId: z.string().min(1).nullable(),
}).strict();

/**
 * One context pack a node was given, for the context store. Unlike every other write here
 * it carries content (the pack is what the model saw), so it has its own surface and the
 * control plane verifies the pack's digests before recording it.
 */
export const contextPackRecordSchema = z.object({
  caseId: z.string().min(1).nullable(),
  nodeId: z.string().min(1),
  pack: z.record(z.string(), z.unknown()),
}).strict();

export type NodeStarted = z.infer<typeof nodeStartedSchema>;
export type NodeFinished = z.infer<typeof nodeFinishedSchema>;
export type RuntimeStateEvent = z.infer<typeof runtimeEventSchema>;
export type CheckpointMark = z.infer<typeof checkpointSchema>;
export type ContextPackRecord = z.infer<typeof contextPackRecordSchema>;

/**
 * Durable run journal, as seen by the runtime.
 *
 * The runtime used to hold a PostgreSQL connection and write run state, node attempts
 * and the event stream directly. That is a much wider grant than the "checkpoints only"
 * the repository documented, and it is not a grant a hosted agent running outside the
 * platform's trust boundary can be given at all. The runtime now describes what
 * happened; the control plane decides whether to record it.
 *
 * The journal methods only ever receive digests and bounded operational values -- never
 * node inputs, outputs, prompts or case payloads. The one exception is recordContextPack,
 * which hands the context store exactly what a model was shown; it goes to a separate
 * surface, and a store that has no context store simply does not implement it.
 */
export interface RuntimeStateStore {
  nodeStarted(run: FencedRun, input: NodeStarted): Promise<NodeStartedResult | void>;
  nodeFinished(run: FencedRun, input: NodeFinished): Promise<void>;
  appendEvent(run: FencedRun, input: RuntimeStateEvent): Promise<void>;
  markCheckpoint(run: FencedRun, input: CheckpointMark): Promise<void>;
  recordContextPack?(run: FencedRun, input: ContextPackRecord): Promise<void>;
  recordSandboxObservation?(run: FencedRun, input: SandboxRuntimeObservation): Promise<void>;
}

export type AccessTokenProvider = () => Promise<string>;
export type WorkloadCredential = string | AccessTokenProvider;

export type HttpRuntimeStateStoreOptions = {
  baseUrl: string;
  /** Workload credential identifying the runtime to the control plane. */
  serviceToken: WorkloadCredential;
  /** Per-invocation grant; the control plane re-checks it against the live fence. */
  executionGrant: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export class RuntimeStateError extends Error {}

/** Journals through the control plane, so the runtime needs no database credential. */
export class HttpRuntimeStateStore implements RuntimeStateStore {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: HttpRuntimeStateStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async nodeStarted(run: FencedRun, input: NodeStarted): Promise<NodeStartedResult | void> {
    const body = await this.post("node-started", run, input) as { caseReadEnvelope?: unknown; expiresInSeconds?: unknown } | undefined;
    if (body && typeof body.caseReadEnvelope === "string" && body.caseReadEnvelope) {
      return { caseReadEnvelope: { envelope: body.caseReadEnvelope, expiresInSeconds: Number(body.expiresInSeconds ?? 0) } };
    }
  }

  async nodeFinished(run: FencedRun, input: NodeFinished): Promise<void> {
    await this.post("node-finished", run, input);
  }

  async appendEvent(run: FencedRun, input: RuntimeStateEvent): Promise<void> {
    await this.post("events", run, input);
  }

  async markCheckpoint(run: FencedRun, input: CheckpointMark): Promise<void> {
    await this.post("checkpoint", run, input);
  }

  recordContextPack(run: FencedRun, input: ContextPackRecord): Promise<void> {
    return this.post("context-packs", run, input, "/v1/runtime/context-packs").then(() => undefined);
  }

  recordSandboxObservation(run: FencedRun, input: SandboxRuntimeObservation): Promise<void> {
    return this.post("sandbox-observations", run, input, "/v1/runtime/sandbox-observations").then(() => undefined);
  }

  private async post(path: string, run: FencedRun, body: unknown, url = `/v1/runtime/state/${path}`): Promise<unknown> {
    const token = typeof this.options.serviceToken === "string"
      ? this.options.serviceToken
      : await this.options.serviceToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "x-runtime-grant": this.options.executionGrant,
      "content-type": "application/json",
    };
    injectTraceContext(headers);
    const response = await this.fetchImpl(`${this.options.baseUrl}${url}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ run, ...(body as Record<string, unknown>) }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (response.ok) return response.status === 204 ? undefined : response.json().catch(() => undefined);
    const detail = await response.json().catch(() => ({})) as { error?: string };
    throw new RuntimeStateError(detail.error ?? `runtime_state.http_${response.status}`);
  }
}

export const fencedRunSchema = z.object({
  runId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  workerId: z.string().min(1),
  fencingEpoch: z.number().int().nonnegative(),
}).strict();
