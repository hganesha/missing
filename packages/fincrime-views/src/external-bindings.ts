import type { Schemas } from "@ehf/ui-contracts";
import type { CatalogSnapshot } from "./catalogs.js";

type Revision = Schemas["ExternalBindingRevision"];
const title = (value: string) => value.replaceAll("_", " ").replace(/^./, char => char.toUpperCase());
/** Tenant authoring revisions overlay discovery only. Opaque binding IDs and runtime restrictions survive. */
export async function withExternalBindingRevisions(snapshot: CatalogSnapshot, revisions: Revision[]): Promise<CatalogSnapshot> {
  if (!revisions.length) return snapshot;
  const byId = new Map(revisions.map(revision => [revision.bindingId, revision]));
  const definitions = new Map(snapshot.entries.filter(entry => entry.kind === "external-capabilities" && entry.entryType === "definition").map(entry => [entry.id, entry]));
  const entries = await Promise.all(snapshot.entries.map(async entry => {
    const revision = byId.get(entry.id);
    if (!revision || entry.kind !== "external-capabilities" || entry.entryType !== "binding") return entry;
    const draft = revision.definition;
    const definition = definitions.get(draft.capabilityPath);
    if (!definition) throw new Error("external_binding.definition_unavailable");
    const previous = entry.contract;
    const jurisdiction = draft.jurisdiction;
    const coverage = draft.coverage;
    const originalPath = entry.relationships.find(link => link.kind === "external-capabilities" && link.entryType === "definition")?.id;
    const changedCapability = originalPath !== draft.capabilityPath;
    const governance = previous.governance as { quarantine?: boolean; blockers?: string[] };
    const blockers = [...new Set([...(governance.blockers ?? []).filter(code => !["jurisdiction_unresolved", "coverage_unknown"].includes(code)),
      ...(jurisdiction.code === "unresolved" ? ["jurisdiction_unresolved"] : ["jurisdiction_not_approved"]),
      ...(coverage.status === "unknown" ? ["coverage_unknown"] : []),
      ...(changedCapability ? ["native_operation_mapping_missing", "request_response_mapping_missing"] : []), "binding_revision_not_approved"])];
    const contract = { ...previous, capability_id: `${draft.capabilityPath}.intelligence.${jurisdiction.code}`, capability_path: draft.capabilityPath,
      capability_definition_ref: `${draft.capabilityPath}@${definition.version}`, actions: draft.actions,
      ...(changedCapability ? { subject_types: definition.contract.subject_types,
        implementation: { ...(previous.implementation as object), request_mapping: "not_defined", response_mapping: "not_defined", validation: "none", v2_validated: false, accepted_test_evidence_refs: [] },
        versions: { ...(previous.versions as object), request_mapping: null, response_mapping: null, host_schema: null } } : {}),
      jurisdiction: { code: jurisdiction.code, basis: definition.contract.jurisdiction_basis, resolution_status: "proposed", assignment_basis: "admin_proposal", evidence_refs: jurisdiction.evidenceRefs },
      coverage: { status: coverage.status, eligible_subject_countries: coverage.eligibleSubjectCountries, eligible_account_countries: coverage.eligibleAccountCountries,
        issuing_authorities: coverage.issuingAuthorities, dataset_refs: coverage.datasetRefs, excluded_scopes: coverage.excludedScopes, coverage_evidence_refs: coverage.evidenceRefs, freshness_policy_ref: coverage.freshnessPolicyRef, assessed_at: null },
      governance: { ...governance, enabled: false, approval_ref: null, blockers },
      catalog_revision: { revision: revision.revision, updated_by: revision.updatedBy, updated_at: revision.updatedAt, source_digest: revision.sourceDigest, reason: revision.reason },
    };
    return { ...entry, title: `${entry.title.split(" · ")[0]} · ${definition.title}`, description: definition.description, group: definition.group,
      ...(definition.collection ? { collection: definition.collection } : {}),
      digest: [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(contract))))].map(byte => byte.toString(16).padStart(2, "0")).join(""), status: governance.quarantine ? "quarantined" : "disabled", statusLabel: governance.quarantine ? "Quarantined" : "Not enabled",
      tags: [String(previous.provider_record_id), jurisdiction.code, `revision ${revision.revision}`],
      facts: [{ label: "Jurisdiction", value: jurisdiction.code === "unresolved" ? "Not established" : jurisdiction.code }, { label: "Jurisdiction basis", value: title(String(definition.contract.jurisdiction_basis)) },
        { label: "Jurisdiction status", value: "Proposed" }, { label: "Coverage", value: title(coverage.status) }, { label: "Catalog revision", value: String(revision.revision) }],
      relationships: [{ kind: "external-capabilities" as const, id: definition.id, label: definition.title, entryType: "definition" as const }],
      fields: blockers.map(code => ({ name: title(code), description: "Must be resolved before this binding can be enabled.", key: true })), contract,
      notice: `${revision.sourceDigest !== entry.digest ? "The source has changed since this edit; review the binding against the latest source. " : ""}Tenant catalog revision ${revision.revision}. Jurisdiction, coverage and evidence references are proposals. This binding is not enabled for execution.`,
    };
  }));
  const bytes = new TextEncoder().encode(JSON.stringify([snapshot.digest, revisions.map(revision => [revision.bindingId, revision.digest]).sort((a, b) => a[0]!.localeCompare(b[0]!))]));
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { ...snapshot, entries, digest, note: `${snapshot.note} Includes tenant catalog revisions; edits do not grant execution authority.` };
}
