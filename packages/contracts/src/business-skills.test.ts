import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  businessSkillDependencies,
  businessSkillEffects,
  businessSkillIdSchema,
  businessSkillManifestDigest,
  businessSkillManifestSchema,
  businessSkillPermissions,
  capabilityRequestSchema,
  checkSkillSelection,
  contextEnvelopeV1Schema,
  domainPackageV2Schema,
  harnessPlanV2Schema,
  isTransientSkillError,
  librarySkillBundleLockEntry,
  librarySkillManifestSchema,
  platformSkillManifestSchema,
  skillBindingForNode,
  skillBundleLockEntrySchema,
  skillInputV1Schema,
  skillResultV1Schema,
  verifyPlanV2Digest,
} from "./index.js";

const plan = harnessPlanV2Schema.parse(JSON.parse(
  readFileSync(new URL("../test-fixtures/skill-bound.plan.json", import.meta.url), "utf8"),
));

// The vendored skill library catalog (config/skill-library) and its release lock.
const library = JSON.parse(readFileSync(new URL("../../../config/skill-library/catalog.json", import.meta.url), "utf8")) as {
  version: string; bundle_code_hash: string; skills: Array<Record<string, unknown> & { id: string; semver: string; effects: string }>;
};
const releaseLock = JSON.parse(readFileSync(new URL("../../../config/skill-library/release-lock.json", import.meta.url), "utf8")) as { catalog_hash: string };
const librarySkill = (id: string) => library.skills.find((skill) => skill.id === id)!;

// A platform-authored manifest (the reference skill host's form).
const manifest = {
  id: "screening.sanctions.execute",
  semver: "0.1.0",
  description: "Screen against applicable sanctions sources.",
  business_outcome: "Screening hits and disposition candidates with match evidence.",
  input_schema: { type: "object" },
  output_schema: { type: "object" },
  required_context: ["Entity", "Alias", "WatchlistEntry"],
  composition_type: "composite",
  execution_mode: "hybrid",
  failure_codes: ["SOURCE_UNAVAILABLE", "TIMEOUT"],
  owner: "financial-crime-platform",
  data_classification: "CONFIDENTIAL_PII",
};

describe("business skill contracts", () => {
  it("accepts catalog-style skill IDs and rejects capability-style ones", () => {
    for (const id of ["entity.resolve", "screening.adverse_media.execute", "ownership.ubo.resolve"]) {
      expect(businessSkillIdSchema.safeParse(id).success).toBe(true);
    }
    for (const id of ["entity", "Entity.resolve", "screening.sanctions.v1.", "screening-sanctions.execute", "1x.y"]) {
      expect(businessSkillIdSchema.safeParse(id).success).toBe(false);
    }
  });

  it("validates a platform-authored manifest strictly on its required fields and the §4.3 failure codes", () => {
    expect(platformSkillManifestSchema.parse(manifest).id).toBe("screening.sanctions.execute");
    expect(businessSkillManifestSchema.parse(manifest).id).toBe("screening.sanctions.execute");
    for (const field of ["id", "semver", "description", "business_outcome", "input_schema", "output_schema",
      "required_context", "composition_type", "execution_mode", "failure_codes", "owner", "data_classification"]) {
      const { [field]: _omitted, ...rest } = manifest as Record<string, unknown>;
      expect(businessSkillManifestSchema.safeParse(rest).success, field).toBe(false);
    }
    expect(businessSkillManifestSchema.safeParse({ ...manifest, failure_codes: ["PROVIDER_DOWN"] }).success).toBe(false);
    expect(businessSkillManifestSchema.safeParse({ ...manifest, execution_mode: "agentic" }).success).toBe(false);
    expect(businessSkillManifestSchema.safeParse({ ...manifest, semver: "1.0" }).success).toBe(false);
    expect(businessSkillManifestSchema.safeParse({ ...manifest, unknown_field: true }).success).toBe(false);
    expect(businessSkillManifestSchema.safeParse({ ...manifest, timeout: "PT30S", retry_policy: "bounded exponential" }).success).toBe(true);
    expect(businessSkillManifestSchema.safeParse({ ...manifest, maturity: "implemented" }).success).toBe(false);
  });

  it("ingests every library catalog entry verbatim, and refuses a field the library schema does not have", () => {
    for (const skill of library.skills) {
      const parsed = librarySkillManifestSchema.parse(skill);
      // No defaults or transforms: what the registry digests is exactly the catalog entry.
      expect(businessSkillManifestDigest(parsed)).toBe(businessSkillManifestDigest(skill));
    }
    const entry = librarySkill("entity.resolve");
    expect(businessSkillManifestSchema.safeParse({ ...entry, review_status: "approved" }).success).toBe(false);
    const { code_hash: _code, ...withoutCode } = entry;
    expect(librarySkillManifestSchema.safeParse(withoutCode).success).toBe(false);
    expect(librarySkillManifestSchema.safeParse({ ...entry, failure_codes: ["PROVIDER_DOWN"] }).success).toBe(false);
    expect(librarySkillManifestSchema.safeParse({ ...entry, maturity: "catalogued" }).success).toBe(false);
  });

  it("digests manifests with the library's own rule (the release lock's catalog_hash is the same function)", () => {
    expect(businessSkillManifestDigest(library)).toBe(releaseLock.catalog_hash);
  });

  it("maps library effect modes per CR-5: human_gated becomes a write mode with approval required", () => {
    const effects = (id: string) => businessSkillEffects(librarySkillManifestSchema.parse(librarySkill(id)));
    expect(effects("entity.resolve")).toEqual({ mode: "read_only", approval: "none" });
    expect(effects("case.create")).toEqual({ mode: "internal_write", approval: "none" });
    expect(effects("decision.disposition.record")).toEqual({ mode: "internal_write", approval: "required" });
    expect(effects("regulatory.filing.submit")).toEqual({ mode: "external_write", approval: "required" });
    expect(effects("evidence.retention.enforce")).toEqual({ mode: "external_write", approval: "required" });
    const gated = library.skills.filter((skill) => skill.effects === "human_gated").map((skill) => skill.id);
    expect(gated).toHaveLength(7);
    for (const id of gated) expect(effects(id).approval).toBe("required");
    expect(businessSkillEffects(platformSkillManifestSchema.parse(manifest))).toEqual({ mode: "read_only", approval: "none" });
    const proposal = { ...manifest, package: { effects: { mode: "proposal" }, authorization: { required_permissions: ["case_command:ProposeClaim"] } } };
    expect(businessSkillEffects(platformSkillManifestSchema.parse(proposal))).toEqual({ mode: "proposal", approval: "none" });
    expect(businessSkillPermissions(platformSkillManifestSchema.parse(proposal))).toEqual(["case_command:ProposeClaim"]);
  });

  it("derives dependencies and permissions from the library manifest", () => {
    const extract = librarySkillManifestSchema.parse(librarySkill("document.entities.extract"));
    expect(businessSkillDependencies(extract)).toEqual({ capabilities: ["document.entities"], skills: [] });
    expect(businessSkillPermissions(librarySkillManifestSchema.parse(librarySkill("case.create")))).toEqual(["skill:case.create", "effect:internal_write"]);
  });

  it("builds the bundle-lock entry a host must serve for a library skill", () => {
    const skill = librarySkillManifestSchema.parse(librarySkill("decision.disposition.record"));
    const entry = skillBundleLockEntrySchema.parse(librarySkillBundleLockEntry(skill, () => undefined));
    expect(entry).toMatchObject({
      id: "decision.disposition.record", version: skill.semver, maturity: "implemented_synthetic",
      manifest_digest: `sha256:${businessSkillManifestDigest(librarySkill("decision.disposition.record"))}`,
      instructions_digest: `sha256:${skill.instruction_hash}`, code_digest: `sha256:${skill.code_hash}`,
      effects: "internal_write", dependencies: { capabilities: [], skills: [] },
    });
    expect(() => librarySkillBundleLockEntry({ ...skill, dependencies: { ...skill.dependencies, skills: ["case.create"] } }, () => undefined))
      .toThrow("skill_bundle.dependency_unresolved:decision.disposition.record:case.create");
  });

  it("models SkillInput.v1 and SkillResult.v1 exactly, and never lets missing evidence read as completed", () => {
    expect(skillInputV1Schema.safeParse({
      execution_id: "4f8f4f53-6c2f-4a8e-9d1c-3d0e7b8f9a10", tenant_id: "t1", case_id: null, subject_refs: ["party:P-1"],
      parameters: {}, context_manifest_ref: "ctx_1", policy_snapshot_ref: "policy:1", as_of_time: "2026-11-07T00:00:00Z",
      purpose: "onboarding", actor_ref: "user:analyst", idempotency_key: "k", trace_id: "trace",
    }).success).toBe(true);
    const result = {
      execution_id: "4f8f4f53-6c2f-4a8e-9d1c-3d0e7b8f9a10", skill_id: "screening.sanctions.execute", skill_version: "0.1.0",
      status: "COMPLETED", result_refs: [], evidence_refs: [], finding_refs: [], unresolved_items: [],
      policy_snapshot_ref: "policy:1", context_hash: "a".repeat(64), trace_ref: "trace",
      metrics: { duration_ms: 1, provider_calls: 1, cost_estimate: 0 }, error: null,
    };
    expect(skillResultV1Schema.safeParse(result).success).toBe(true);
    expect(skillResultV1Schema.safeParse({ ...result, status: "PASS" }).success).toBe(false);
    expect(skillResultV1Schema.safeParse({ ...result, status: "NEEDS_EVIDENCE" }).success).toBe(false);
    expect(skillResultV1Schema.safeParse({ ...result, status: "FAILED" }).success).toBe(false);
    expect(skillResultV1Schema.safeParse({ ...result, status: "FAILED", error: { code: "TIMEOUT", retryable: true } }).success).toBe(true);
    expect(isTransientSkillError("RATE_LIMITED")).toBe(true);
    expect(isTransientSkillError("ACCESS_DENIED")).toBe(false);
  });

  it("requires every context envelope field instead of accepting empty placeholders", () => {
    const envelope = {
      tenant_id: "t1", case_id: "c1", subject_refs: ["party:P-1"], jurisdiction: "US", purpose: "KYC_SCREENING",
      actor: "runtime:worker", policy_snapshot_ref: "policy:1", as_of_time: "2026-11-07T00:00:00Z", object_refs: [],
      evidence_refs: [], graph_scope: null, freshness_requirements: {}, permitted_providers: ["opensanctions:sanctions"],
      redaction_profile: "classification:PII=allow", token_budget: 1000, correlation_id: "RUN-1:node", context_hash: "b".repeat(64),
    };
    expect(contextEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
    expect(contextEnvelopeV1Schema.safeParse({ ...envelope, subject_refs: [] }).success).toBe(false);
    expect(contextEnvelopeV1Schema.safeParse({ ...envelope, jurisdiction: "" }).success).toBe(false);
    const { actor: _actor, ...withoutActor } = envelope;
    expect(contextEnvelopeV1Schema.safeParse(withoutActor).success).toBe(false);
  });

});

describe("skill bindings in plans", () => {
  it("parses a harnessc plan with pinned skill bindings and verifies its digest", () => {
    expect(verifyPlanV2Digest(plan)).toBe(true);
    expect(plan.skillBindings?.map((binding) => binding.skillId)).toEqual(["screening.pep.execute", "screening.sanctions.execute"]);
    const binding = skillBindingForNode(plan, "sanctions-screen");
    expect(binding?.candidates.map((candidate) => candidate.connectorId)).toEqual([
      "opensanctions:sanctions", "wiring:dow-jones-risk-compliance:screening.sanctions", "wiring:opensanctions:screening.sanctions",
    ]);
    expect(skillBindingForNode(plan, "intake")).toBeNull();
  });

  it("accepts a package that authors candidates as bare capability IDs", () => {
    const parsed = domainPackageV2Schema.shape.skillBindings.parse([{
      skillId: "screening.pep.execute", semver: "0.1.0", manifestDigest: "a".repeat(64), candidates: ["screening.pep.v1"],
      policy: { require_entitlement: true, require_list_freshness: true, require_jurisdiction_coverage: true, allow_fallback: false, log_selected_implementation: true },
    }]);
    expect(parsed?.[0]?.candidates).toEqual(["screening.pep.v1"]);
  });

  it("checks a selection record against the pinned candidate", () => {
    const selection = {
      skillId: "screening.sanctions.execute", skillVersion: "0.1.0", selectedCapabilityId: "screening.sanctions.v1",
      selectedConnectorId: "wiring:opensanctions:screening.sanctions", candidateIndex: 2, reason: "fallback",
    };
    expect(capabilityRequestSchema.parse({ invocationId: "i", capabilityId: "screening.sanctions.v1", effect: "read", input: {}, skill: selection }).skill)
      .toEqual(selection);
    expect(checkSkillSelection(plan, "sanctions-screen", "screening.sanctions.v1", selection).connectorId)
      .toBe("wiring:opensanctions:screening.sanctions");
    expect(() => checkSkillSelection(plan, "sanctions-screen", "screening.sanctions.v1", { ...selection, candidateIndex: 7 }))
      .toThrow("skill.selection_candidate_mismatch");
    expect(() => checkSkillSelection(plan, "sanctions-screen", "screening.sanctions.v1", { ...selection, selectedConnectorId: "opensanctions:sanctions" }))
      .toThrow("skill.selection_connector_mismatch");
    expect(() => checkSkillSelection(plan, "sanctions-screen", "screening.sanctions.v1", { ...selection, skillVersion: "0.2.0" }))
      .toThrow("skill.selection_version_mismatch");
    expect(() => checkSkillSelection(plan, "pep-screen", "screening.sanctions.v1", selection)).toThrow("skill.selection_skill_mismatch");
    expect(() => checkSkillSelection(plan, "intake", "screening.sanctions.v1", selection)).toThrow("skill.selection_skill_mismatch");
  });
});
