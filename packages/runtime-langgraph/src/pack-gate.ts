import {
  casePolicyContextFromRelationship, evaluatePackGate, packDigest,
  type EffectivePolicyPack, type PackGateId, type PackGateResult,
} from "@ehf/policy-engine";

/**
 * A policy-pack checkpoint node (agentic plan phase 2, docs/implementation/policy-packs.md):
 * a transform whose `config.packGate` names the gate, the effective packs the plan pinned, and the
 * record selectors that feed it. The same pattern as the banking-product readiness checkpoint:
 * deterministic TypeScript over canonical records, not an OPA bundle.
 *
 * The pack is the one the case is pinned to, by id and digest; a pack whose content no longer
 * matches its digest is refused. Nothing here defaults: no pin, no relationship or an out-of-scope
 * customer type is UNKNOWN, and the workflow routes UNKNOWN to a person.
 */
export type PackGateConfig = {
  gateId: PackGateId;
  packs: EffectivePolicyPack[];
  /** Canonical record type -> the node's selector that reads it. */
  recordSelectors: Record<string, string>;
};

type Authority = { policyId?: string | null; policyBundleDigest?: string | null } | null | undefined;
type Snapshot = { policyAuthority?: Authority; capturedAt?: string } | null | undefined;
type SelectedRecord = { object_type?: string; object_id?: string; id?: string; data: Record<string, unknown>; observed_at?: string };

export function evaluatePackCheckpoint(config: PackGateConfig, selection: Readonly<Record<string, unknown>>, snapshot: Snapshot): PackGateResult {
  const authority = snapshot?.policyAuthority;
  const bare = (digest: string | null | undefined) => (digest ?? "").replace(/^sha256:/, "");
  const pinned = config.packs.find((pack) => pack.id === authority?.policyId && pack.digest === bare(authority?.policyBundleDigest));
  if (!pinned) {
    return { gateId: config.gateId, outcome: "UNKNOWN", reasonCodes: ["POLICY_PACK_NOT_PINNED"], packId: authority?.policyId ?? "", packDigest: bare(authority?.policyBundleDigest), details: {} };
  }
  const { digest, ...content } = pinned;
  if (packDigest(content) !== digest) throw new Error(`runtime.policy_pack_digest_mismatch:${pinned.id}`);
  const records: Record<string, SelectedRecord[]> = {};
  for (const [objectType, selectorId] of Object.entries(config.recordSelectors)) {
    const value = selection[selectorId];
    records[objectType] = Array.isArray(value) ? value as SelectedRecord[] : [];
  }
  const relationships = records.BankingRelationship ?? [];
  const context = relationships.length === 1 ? casePolicyContextFromRelationship(relationships[0]!.data) : null;
  const customerType = context?.customerType === "individual" || context?.customerType === "corporate" ? context.customerType : null;
  return evaluatePackGate(pinned, config.gateId, {
    authority, customerType, legalArrangement: context?.legalArrangement ?? null, records, asOf: snapshot?.capturedAt ?? new Date(0).toISOString(),
  });
}
