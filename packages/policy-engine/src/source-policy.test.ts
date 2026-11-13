import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceArtifactSchema, stableDigest, type SourceContext, type SourceBinding, type SourceAccess, type JurisdictionSourcePolicy, type SourceEvidenceObservation } from "@ehf/contracts";
import { compileJurisdictionSourcePolicy, evaluateSourceAuthorization, type SourceEvaluationInput } from "./source-policy.js";

const fixture = JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/source-policy.json", import.meta.url), "utf8")) as {
  context: SourceContext; binding: SourceBinding; access: SourceAccess; policy: JurisdictionSourcePolicy; observation: SourceEvidenceObservation;
};
const base: SourceEvaluationInput = { ...fixture, policies: [fixture.policy], capabilityId: fixture.binding.capabilityId,
  connectorId: fixture.binding.connectorId, connectorDigest: fixture.binding.connectorDigest,
  request: { stage: "acquire", recipientId: "tenant_demo", redistribute: false }, evaluatedAt: "2026-11-08T12:00:00Z" };
const run = (change: Partial<SourceEvaluationInput> = {}) => evaluateSourceAuthorization({ ...structuredClone(base), ...change });

describe("jurisdiction source policy", () => {
  it("allows US-authority screening of a German subject under an approved US institutional context", () => {
    expect(stableDigest(fixture.binding)).toBe(fixture.access.bindingDigest);
    const decision = run();
    expect(decision.outcome).toBe("ALLOW");
    expect(decision.obligations.datasetIds).toEqual(["synthetic-us-list"]);
    expect(decision.validUntil).toBe("2026-11-08T12:01:00.000Z");
  });
  it("fails closed on absent facts, proposed scope, unknown jurisdictions and changed bindings", () => {
    for (const change of [{ context: null }, { binding: null }, { access: null }, { policies: [] },
      { binding: { ...fixture.binding, readiness: "proposed" as const } }, { binding: { ...fixture.binding, jurisdiction: "unresolved" as const } }]) expect(run(change).outcome).not.toBe("ALLOW");
    expect(run({ connectorDigest: "b".repeat(64) }).reasonCodes).toContain("source_policy.binding_changed");
    for (const change of [{ purpose: "marketing" }, { product: "crypto" }, { bookingEntityId: "bank-de" }, { institutionId: "other-bank" }]) {
      expect(run({ context: { ...fixture.context, ...change } }).outcome).not.toBe("ALLOW");
    }
  });
  it("enforces exact access validity boundaries, consent and subject coverage", () => {
    expect(run({ evaluatedAt: fixture.access.validFrom }).outcome).toBe("ALLOW");
    expect(run({ evaluatedAt: fixture.access.expiresAt }).outcome).toBe("DENY");
    expect(run({ evaluatedAt: "2025-12-31T23:59:59Z" }).outcome).toBe("DENY");
    expect(run({ access: { ...fixture.access, consentRequired: true } }).reasonCodes).toContain("source_policy.consent_missing");
    expect(run({ context: { ...fixture.context, subjectCountries: ["JP"] } }).outcome).toBe("DENY");
  });
  it("requires registration/issuer/account authority facts independently of residence and policy geography", () => {
    const binding: SourceBinding = { ...fixture.binding, jurisdiction: "gb", jurisdictionBasis: "registry_authority" };
    const access = { ...fixture.access, bindingDigest: stableDigest(binding) };
    const policies = [{ ...fixture.policy, rules: [{ ...fixture.policy.rules[0]!, sourceJurisdictions: ["gb" as const] }] }];
    expect(run({ binding, access, policies }).reasonCodes).toContain("source_policy.source_authority_mismatch");
    expect(run({ binding, access, policies, context: { ...fixture.context, registrationJurisdictions: [] } }).outcome).toBe("UNRESOLVED");
    expect(run({ binding, access, policies, context: { ...fixture.context, registrationJurisdictions: ["gb"] } }).outcome).toBe("ALLOW");
  });
  it("requires every applicable regime and intersects policy obligations; deny always wins", () => {
    const context = { ...fixture.context, policyJurisdictions: ["us", "gb"] } as SourceContext;
    expect(run({ context }).reasonCodes).toContain("source_policy.applicability_unresolved");
    const uk: JurisdictionSourcePolicy = { ...fixture.policy, id: "host-policy", scope: { ...fixture.policy.scope, policyJurisdictions: ["gb"] },
      rules: [{ ...fixture.policy.rules[0]!, maxAgeSeconds: 60, maxRetentionSeconds: 3600 }] };
    const decision = run({ context, policies: [fixture.policy, uk] });
    expect(decision.outcome).toBe("ALLOW");
    expect(decision.obligations.maxAgeSeconds).toBe(60);
    expect(decision.obligations.maxRetentionSeconds).toBe(3600);
    const deny = { ...uk, rules: [{ ...uk.rules[0]!, effect: "DENY" as const }] };
    for (const policies of [[fixture.policy, deny], [deny, fixture.policy]]) expect(run({ context, policies }).outcome).toBe("DENY");
    const conflict = { ...uk, rules: [{ ...uk.rules[0]!, evidenceRoles: ["supplemental" as const] }] };
    expect(run({ context, policies: [fixture.policy, conflict] }).reasonCodes).toContain("source_policy.obligations_conflict");
    const review = { ...uk, rules: [{ ...uk.rules[0]!, effect: "REVIEW_REQUIRED" as const }] };
    expect(run({ context, policies: [fixture.policy, review] }).outcome).toBe("REVIEW_REQUIRED");
  });
  it("refuses unauthorized processing, subprocessors, redistribution and recipients", () => {
    expect(run({ access: { ...fixture.access, processingRegions: ["de-central"] } }).reasonCodes).toContain("source_policy.data_flow_denied");
    const policies = [{ ...fixture.policy, rules: [{ ...fixture.policy.rules[0]!, processingRegions: ["de-central"] }] }];
    expect(run({ policies }).reasonCodes).toContain("source_policy.processing_region_denied");
    expect(run({ request: { stage: "acquire", recipientId: "tenant_demo", redistribute: true } }).outcome).toBe("DENY");
    expect(run({ request: { stage: "acquire", recipientId: "other-tenant", redistribute: false } }).outcome).toBe("DENY");
  });
  it("separates an allowed acquisition from incomplete, stale, future or weaker evidence", () => {
    expect(run().outcome).toBe("ALLOW");
    const use = (observation: SourceEvidenceObservation | undefined) => run({ request: { stage: "use", recipientId: "tenant_demo", redistribute: false, ...(observation ? { observation } : {}) } });
    expect(use(fixture.observation).outcome).toBe("ALLOW");
    for (const observation of [undefined, { ...fixture.observation, complete: false }, { ...fixture.observation, datasetIds: [] },
      { ...fixture.observation, fields: [] }, { ...fixture.observation, fields: [...fixture.observation.fields, "unapproved-sensitive-field"] }, { ...fixture.observation, role: "supplemental" as const },
      { ...fixture.observation, observedAt: "2026-11-09T00:00:00Z" }, { ...fixture.observation, observedAt: "2026-11-01T00:00:00Z" }]) expect(use(observation).outcome).not.toBe("ALLOW");
  });
  it("rejects wildcard/ambiguous schemas, duplicate rules and invalid effective periods", () => {
    const compiled = compileJurisdictionSourcePolicy(fixture.policy);
    expect(compiled.digest).toBe(stableDigest(fixture.policy));
    for (const artifact of [{ ...fixture.binding, jurisdiction: "*" }, { ...fixture.binding, jurisdiction: "global", globalScopeRef: null },
      { ...fixture.binding, approvedEndpoints: ["https://user:password@source.test"] },
      { ...fixture.policy, expiresAt: fixture.policy.validFrom }, { ...fixture.policy, rules: [...fixture.policy.rules, ...fixture.policy.rules] }]) {
      expect(sourceArtifactSchema.safeParse(artifact).success).toBe(false);
    }
  });
});
