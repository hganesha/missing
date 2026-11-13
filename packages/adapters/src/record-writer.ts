import { canonicalRecordInputSchema, stableDigest, type CanonicalRecordInput } from "@ehf/contracts";
import { assertRecordData, LIBRARY_CONTEXT_SCHEMA_VERSION } from "@ehf/library-contracts";
import type { RecordSourceContext } from "./canonical-records.js";

/**
 * Shared writer for the transaction-family normalizers: validates each record against the library
 * contract before it leaves, derives a content-addressed version id (a replay re-submits the same
 * version), and cites the gateway invocation as a source ref.
 */
export function recordWriter(context: RecordSourceContext, normalizer: string, version: string, synthetic: boolean) {
  const records: CanonicalRecordInput[] = [];
  const add = (objectType: string, objectId: string, data: Record<string, unknown>, subjectIds: string[], observedAt: string): void => {
    assertRecordData(objectType, data);
    const content = { objectType, objectId, data, observedAt, synthetic };
    records.push(canonicalRecordInputSchema.parse({
      object_type: objectType, object_id: objectId, version_id: `v-${stableDigest(content).slice(0, 32)}`,
      schema_version: LIBRARY_CONTEXT_SCHEMA_VERSION, data, subject_ids: subjectIds, valid_from: null, valid_to: null,
      observed_at: observedAt,
      source_refs: context.invocationId
        ? [{ tenant_id: context.tenantId ?? "unknown", object_type: "GatewayInvocation", object_id: context.invocationId, version_id: "receipt" }]
        : [],
      provenance: {
        method: "connector_normalizer", normalizer: `${normalizer}@${version}`, connector_id: context.connectorId,
        ...(context.capabilityId ? { capability_id: context.capabilityId } : {}),
        ...(context.invocationId ? { invocation_id: context.invocationId } : {}),
      },
      classification: context.classification ?? "CONFIDENTIAL", synthetic,
    }));
  };
  return { records, add };
}
