import { sandboxDocumentObservationSchema, sandboxPayloadShape, sandboxSkillObservationSchema, type SandboxRuntimeObservation } from "@ehf/runtime-state";
import type { CapabilityResult, SkillResultStatus } from "@ehf/contracts";
import type { RuntimeContext } from "@ehf/runtime-core";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function sandboxObservationSink(context: RuntimeContext, rootInput: unknown) {
  if (context.draftTest || object(rootInput)?.sandboxObservation !== true || !context.state.recordSandboxObservation) return undefined;
  const fence = { runId: context.runId, attempt: context.runAttempt, workerId: context.workerId, fencingEpoch: context.fencingEpoch };
  return async (observation: SandboxRuntimeObservation) => {
    try {
      await context.state.recordSandboxObservation!(fence, observation);
    } catch {
      await context.state.appendEvent(fence, {
        eventKey: `sandbox-observation-unavailable:${observation.nodeId}:${context.runAttempt}`,
        code: "sandbox.observation.unavailable", nodeId: observation.nodeId, status: "observed", values: {},
      }).catch(() => undefined);
    }
  };
}

export function sandboxSkillObservation(input: {
  nodeId: string; skillId: string; skillVersion: string | null; status: SkillResultStatus;
  contextHash: string | null; resultDigest?: string | null; invocationId?: string | null; step?: number;
  input?: unknown; output?: unknown;
}) {
  const extractions = input.skillId === "document.fields.contract_extract" ? object(input.output)?.extractions : undefined;
  const documents = Array.isArray(extractions) ? extractions.slice(0, 30).flatMap(value => {
    const extraction = object(value);
    const version = extraction?.document_version;
    const status = extraction?.extraction_status;
    return typeof version === "string" && /^(?:sha256:)?[a-f0-9]{64}$/.test(version)
      && typeof status === "string" && ["NEEDS_REVIEW", "NEEDS_EVIDENCE", "COMPLETED", "FAILED"].includes(status) ? [{ version, status }] : [];
  }) : [];
  return sandboxSkillObservationSchema.safeParse({
    kind: "skill", nodeId: input.nodeId, key: `skill:${input.step ?? "node"}:${input.skillId}`, invocationId: input.invocationId ?? null,
    data: { skillId: input.skillId, skillVersion: input.skillVersion, status: input.status, contextHash: input.contextHash,
      resultDigest: input.resultDigest ?? null, input: sandboxPayloadShape(input.input), output: sandboxPayloadShape(input.output), documents },
  }).data;
}

export function sandboxDocumentsObservation(nodeId: string, result: CapabilityResult) {
  const records = object(result.output)?.records;
  if (!Array.isArray(records)) return undefined;
  const documents = records.flatMap(value => {
    const item = object(value);
    const data = object(item?.data);
    return item?.object_type === "DocumentVersion" && data ? [{ documentId: data.document_id, version: data.artifact_hash }] : [];
  }).slice(0, 30);
  return sandboxDocumentObservationSchema.safeParse({
    kind: "documents", nodeId, key: "document-evidence-package", invocationId: result.invocationId, data: { documents },
  }).data;
}
