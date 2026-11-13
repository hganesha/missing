import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanV2Schema, type HarnessPlanV2 } from "@ehf/contracts";
import { assembleContextPack, chooseSkillPolicy } from "@ehf/context-plane";
import { evaluateCondition } from "@ehf/runtime-core";
import { agentSkillResults, evaluatePackCheckpoint, runAgentLoop, skillParametersFor, type PackGateConfig } from "./index.js";

// The agentic KYC and KYB flows (agentic plan phase 4), compiled by harnessc from
// domains/{kyc,kyb}-agentic (scripts/sync-agentic-flows.ts).
const load = (name: string) => harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL(`../../../artifacts/${name}.plan.json`, import.meta.url), "utf8"))) as HarnessPlanV2;
const kyc = load("kyc-agentic");
const kyb = load("kyb-agentic");
const securities = load("securities-agentic");
const node = (plan: HarnessPlanV2, id: string) => plan.graph.nodes.find((item) => item.id === id)!;
// Retain the frozen TypeScript pack evaluator as an oracle, not executable gate authority.
function legacyConfig(plan:HarnessPlanV2,id:string):PackGateConfig {
  const n=node(plan,id);
  return {gateId:n.config.gateId as PackGateConfig["gateId"],packs:n.config.policyPacks as PackGateConfig["packs"],
    recordSelectors:Object.fromEntries(n.contextSelectorIds.map(id=>plan.contextSelectors.find(s=>s.id===id)!).map(s=>[s.path.split(".").at(-1),s.id]))};
}
/** The run's main path: intake to result, never through the stop node. */
function mainPath(plan: HarnessPlanV2): string[] {
  const path = ["intake"];
  while (path.at(-1) !== "result") {
    const next = plan.graph.edges.find((edge) => edge.from === path.at(-1) && edge.to !== "stopped");
    if (!next) throw new Error(`no path from ${path.at(-1)}`);
    path.push(next.to);
  }
  return path;
}
/** Corpus records by type, in the shape the case store selects them (`object_id`, not the corpus `id`). */
const records = (party: string, file = "records.jsonl") => {
  const out: Record<string, unknown[]> = {};
  for (const line of readFileSync(new URL(`../../../fixtures/context-corpus/parties/${party}/${file}`, import.meta.url), "utf8").split("\n").filter(Boolean)) {
    const record = JSON.parse(line) as { object_type: string; id: string; version_id: string; observed_at: string; data: unknown };
    (out[record.object_type] ??= []).push({ ...record, object_id: record.id });
  }
  return out;
};

describe.each([["kyc-agentic", kyc, 9], ["kyb-agentic", kyb, 10]] as const)("%s", (_name, plan, agentCount) => {
  const path = mainPath(plan);

  it("runs its agents in roster order, each review after its own skills, and ends with the policy-owned disposition gate", () => {
    const reviews = path.filter((id) => node(plan, id).kind === "agent");
    expect(reviews).toHaveLength(agentCount);
    expect(reviews.slice(0, 3)).toEqual(["intake-profile-review", "document-intelligence-review", "identity-verification-review"]);
    expect(reviews.at(-1)).toBe("qa-assurance-review");
    for (const review of reviews) {
      const own = (node(plan, review).config.completion as { criteria: Array<{ nodeId: string }> }).criteria.map((criterion) => criterion.nodeId);
      for (const skillNode of own) expect(path.indexOf(skillNode), `${review}:${skillNode}`).toBeLessThan(path.indexOf(review));
    }
    expect(path.slice(-3)).toEqual(["qa-assurance-review", "pack-disposition", "result"]);
    expect(plan.graph.nodes.some(n=>n.kind==="approval")).toBe(false);
    expect(node(plan,"result").config.requireFinalDisposition).toBe(true);
  });

  it("uses three released OPA gates with typed states after intake, before decision support and before disposition", () => {
    const gates = path.filter((id) => id.startsWith("pack-"));
    expect(gates).toEqual(["pack-intake-ready", "pack-decision-ready", "pack-disposition"]);
    expect(path.indexOf("pack-intake-ready")).toBe(path.indexOf("intake-profile-review") + 1);
    expect(path.indexOf("pack-decision-ready")).toBe(path.indexOf("decision-requirements-compile") - 1);
    expect(path.indexOf("pack-disposition")).toBe(path.indexOf("result") - 1);
    for (const gate of gates) {
      const continueEdge = plan.graph.edges.find((edge) => edge.from === gate && edge.to !== "stopped")!;
      expect(continueEdge.outcome).toBe("DECIDED");
      expect(node(plan,gate)).toMatchObject({kind:"gate",config:{businessDecision:"v2",inputProfile:"canonical.onboarding.v2"}});
      expect(node(plan,gate).config.packGate).toBeUndefined();
      expect(plan.policyBundles.some(b=>b.policyId===node(plan,gate).config.policyRef)).toBe(true);
      expect(plan.graph.edges.some((edge) => edge.from === gate && edge.to === "stopped")).toBe(true);
    }
  });

  it("routes typed policy states, with human work owned by the gate service",()=>{
    const next=(gate:string,state:string)=>plan.graph.edges.filter(edge=>edge.from===gate && edge.outcome===state).map(edge=>edge.to);
    expect(next("pack-disposition","DECIDED")).toEqual(["result"]);
    for(const gate of ["pack-intake-ready","pack-decision-ready","pack-disposition"]){
      for(const state of ["NEEDS_HUMAN","NEEDS_EVIDENCE","UNRESOLVED","NOT_APPLICABLE"])expect(next(gate,state)).toEqual(["stopped"]);
      expect(next(gate,"DECIDED")).not.toContain("stopped");
    }
  });

  it("binds every parameter from earlier results or the case, never a placeholder", () => {
    const extract = node(plan, "document-fields-adjudicated-extract");
    expect(extract.config).toMatchObject({ skillParameterBindings: { classifications: "document-classify-catalog.payload.classifications" }, skillContextBindings: { subject: "subjectId" }, requireBoundParameters: true });
    expect(node(plan, "entity-resolve").config).toMatchObject({ skillContextBindings: { name: "subjectName" }, requireBoundParameters: true });
    expect(node(plan, "decision-rules-evaluate").config.skillParameterBindings).toEqual({ "facts.tier": "risk-tier-assign.payload.tier", "facts.identity_verified": "entity-identity-verify.payload.verifications.0.verified" });
    // Identity resolution gets the case subject's identifier values from its IdentityIdentifier records.
    const resolve = node(plan, "entity-resolve");
    const h03 = records("H03");
    const bound = skillParametersFor(resolve, {}, { subjectName: "Adaeze Okonkwo-Bell", subjectId: "h03.entity.adaeze", subjectIdentifiers: h03.IdentityIdentifier });
    expect(bound).toMatchObject({ parameters: { name: "Adaeze Okonkwo-Bell", identifiers: ["SPECIMEN-H03-PP-0001"] }, unresolvedBindings: [] });
    // Another party's identifiers never reach the customer's resolution; no identifiers is an empty list, not a gap.
    expect(skillParametersFor(resolve, {}, { subjectName: "x", subjectId: "nobody", subjectIdentifiers: h03.IdentityIdentifier }).parameters.identifiers).toEqual([]);
    // Unbound until the classifier has run: the extraction cannot run on an empty list.
    expect(skillParametersFor(extract, {}, { subjectId: "e-1" }).unresolvedBindings).toEqual(["classifications"]);
  });

  it("gives every policy-reading skill one projection per pinned pack, and the case's pin chooses", () => {
    const withPolicies = plan.graph.nodes.filter((item) => item.config.skillPolicies !== undefined);
    expect(withPolicies.length).toBeGreaterThan(5);
    const gate = legacyConfig(plan,"pack-intake-ready");
    for (const item of withPolicies) {
      const alternatives = item.config.skillPolicies as Array<{ policyRef: string; bundleDigest: string }>;
      expect(alternatives.map((alternative) => alternative.policyRef).sort()).toEqual(gate.packs.map((pack) => pack.id).sort());
      const [us, gb] = gate.packs;
      expect(chooseSkillPolicy(undefined, alternatives as never, { policyId: gb!.id, policyBundleDigest: gb!.digest, policyVersion: gb!.version, policySnapshotDigest: "d".repeat(64) })).toMatchObject({ policyRef: gb!.id });
      expect(us!.id).toMatch(/\.us\./);
    }
  });
});

it("gate profiles include current agent observations, proposals and prior policy adoptions",()=>{
  for(const plan of [kyc,kyb]){
    const selectors=new Map(plan.contextSelectors.map(selector=>[selector.id,selector]));
    for(const gate of plan.graph.nodes.filter(node=>node.config.businessDecision==="v2")){
      const paths=gate.contextSelectorIds.map(id=>selectors.get(id)?.path);
      for(const path of ["records.ControlAssessment","records.Finding","records.ExtractedAssertion","records.FraudSignal","records.DocumentVersion","claims","facts","contradictions","decisionRecommendations","adoptedAssessments"])
        expect(paths,gate.id+": "+path).toContain(path);
    }
  }
});

it("technical provider callback admission does not supply unreviewed installation provider permission",()=>{
  for(const plan of [kyc,kyb]){
    const projections=plan.graph.nodes.flatMap(node=>node.config.skillPolicies as Array<{fields:string[];values:Record<string,unknown>;unresolved:string[]}>??[]).filter(policy=>policy.fields.includes("permitted_providers"));
    expect(projections.length).toBeGreaterThan(0);
    for(const policy of projections){expect(policy.unresolved).toContain("permitted_providers");expect(policy.values.permitted_providers).toBeUndefined();}
  }
});

describe("hydration (delivery plan W3/W4)", () => {
  const next = (plan: HarnessPlanV2, from: string) => plan.graph.edges.filter((edge) => edge.from === from && edge.to !== "stopped").map((edge) => edge.to);
  it("acquires the case's documents and data before the agents that read them, and screening before screening", () => {
    expect(next(kyc, "pack-intake-ready")).toEqual(["acquire-documents"]);
    expect(next(kyc, "acquire-documents")).toEqual(["document-authenticity-assess"]);
    expect(next(kyb, "pack-intake-ready").sort()).toEqual(["acquire-documents", "acquire-lei", "acquire-officers", "acquire-ownership", "acquire-registry"]);
    expect(next(kyb, "identity-acquired")).toEqual(["document-authenticity-assess"]);
    for (const plan of [kyc, kyb]) {
      expect(next(plan, "screening-acquired")).toEqual(["screening-sanctions-execute"]);
      for (const id of ["acquire-sanctions", "acquire-pep", "acquire-adverse-media"]) expect(next(plan, id), id).toEqual(["screening-acquired"]);
      // Acquisitions write canonical records as the system's normalizer, citing the captured provider output.
      const documents = node(plan, "acquire-documents");
      expect(documents.config).toMatchObject({ caseWriteActor: "system", evidenceCapture: { sourceType: "TOOL" } });
      expect((documents.config.caseWrites as Array<{ commandType: string }>).map((write) => write.commandType)).toEqual(["LinkEvidence", "RecordCanonicalRecords", "RecordScreeningFinding"]);
    }
    // An individual has no registry, officers or ownership to acquire.
    for (const id of ["acquire-registry", "acquire-officers", "acquire-ownership", "acquire-lei"]) expect(kyc.graph.nodes.some((item) => item.id === id), id).toBe(false);
  });

  it("runs the optional authenticity checks when the documents arrive, owned by the document agent, outside its completion", () => {
    for (const plan of [kyc, kyb]) {
      expect(next(plan, "document-authenticity-assess")).toEqual(["fraud-document-tamper-detect"]);
      expect(next(plan, "fraud-document-tamper-detect")).toEqual(["document-classify-catalog"]);
      const review = node(plan, "document-intelligence-review");
      const criteria = (review.config.completion as { criteria: Array<{ nodeId: string }> }).criteria.map((criterion) => criterion.nodeId);
      for (const id of ["document-authenticity-assess", "fraud-document-tamper-detect"]) {
        expect(criteria).not.toContain(id);
        expect(node(plan, id).config).toMatchObject({ agentRef: "agent.document_intelligence" });
      }
      expect(review.config.observedSkillNodes).toEqual(["document-authenticity-assess", "fraud-document-tamper-detect"]);
      // Each detector is a delegated provider capability served by its sandbox connector.
      for (const [skillId, capabilityId, connector] of [["document.authenticity.assess", "document.forensics.assess.v1", "simulator:library.document.forensics"], ["fraud.document.tamper.detect", "fraud.document.tamper.v1", "simulator:library.fraud.document_tamper"]] as const) {
        expect(plan.skillBindings!.find((binding) => binding.skillId === skillId)!.dependencyCapabilities).toEqual([capabilityId]);
        expect(plan.capabilities.find((capability) => capability.id === capabilityId)).toMatchObject({ adapterBindingId: connector, effect: "read" });
      }
      // Both agents that weigh documents read the signals.
      for (const id of ["document-intelligence-review", "identity-verification-review"]) expect(node(plan, id).contextSelectorIds, id).toContain(`readFraudSignal-${id}`);
    }
  });

  it("records an informative tamper answer as a FraudSignal, and an inconclusive one as nothing", () => {
    const tamper = node(kyb, "fraud-document-tamper-detect");
    const write = (tamper.config.caseWrites as Array<Record<string, unknown>>).find((entry) => entry.commandType === "RecordCanonicalRecords")!;
    const output = (assessment: string, status = "COMPLETED") => ({ output: { computation: { business_status: status, payload: { assessment: { assessment, score: "0.82", model_version: "vendor-v3", limitations: [] } } } } });
    expect(evaluateCondition(String(write.when), output("TAMPER_INDICATED"))).toBe(true);
    expect(evaluateCondition(String(write.when), output("INCONCLUSIVE"))).toBe(false);
    expect(evaluateCondition(String(write.when), output("TAMPER_INDICATED", "NEEDS_EVIDENCE"))).toBe(false);
    expect(evaluateCondition(String(write.when), { output: { status: "NEEDS_EVIDENCE" } })).toBe(false);
    expect(write.payload).toMatchObject({ records: [{ object_type: "FraudSignal", data: { kind: "document_tamper", score: "{{ output.computation.payload.assessment.score }}" }, provenance: { method: "platform", capability_id: "fraud.document.tamper.v1" } }] });
    expect(tamper.config.evidenceCapture).toMatchObject({ trustTier: "PLATFORM_DERIVED" });
  });

  it("shows the document review its hydration checks' results beside its own skills'", () => {
    const review = node(kyb, "document-intelligence-review");
    const inconclusive = { lifecycle: "COMPLETED_EXECUTION", computation: { business_status: "COMPLETED", payload: { assessment: { assessment: "INCONCLUSIVE", score: "0.5" } } } };
    const results = agentSkillResults(review, { "fraud-document-tamper-detect": inconclusive })!.skillResults;
    expect(results).toEqual({ "fraud-document-tamper-detect": { lifecycle: inconclusive.lifecycle, computation: inconclusive.computation } });
  });
});

describe("QA independence (delivery plan wave 5)", () => {
  it("judges with a model no reviewed agent uses, in every profile set", () => {
    for (const plan of [kyc, kyb]) {
      const profiles = new Map(plan.agentProfiles.map((profile) => [profile.id, profile.modelProfileId]));
      expect(profiles.get("agent.qa_assurance")).toBe("model.judge.v1");
      for (const [agent, profile] of profiles) if (agent !== "agent.qa_assurance") expect(profile, agent).not.toBe("model.judge.v1");
    }
    for (const file of ["model-profiles.json", "model-profiles.claude.json", "model-profiles.claude-openrouter.json"]) {
      const set = (JSON.parse(readFileSync(new URL(`../../../config/${file}`, import.meta.url), "utf8")) as { profiles: Array<{ id: string; model: string }> }).profiles;
      const judge = set.find((profile) => profile.id === "model.judge.v1")!.model;
      for (const profile of set) if (profile.id !== "model.judge.v1") expect(profile.model, `${file}: ${profile.id}`).not.toBe(judge);
    }
  });
});

describe("customer type", () => {
  it("leaves company-only checks and the ownership agent out of KYC", () => {
    for (const id of ["registry-company-verify", "screening-sanctions-ownership-evaluate", "identity-ownership-review", "ownership-graph-build"]) {
      expect(kyc.graph.nodes.some((item) => item.id === id), id).toBe(false);
      expect(kyb.graph.nodes.some((item) => item.id === id), id).toBe(true);
    }
    expect(kyc.agentProfiles.find((profile) => profile.id === "agent.identity_verification")!.allowedSkills.map((skill) => skill.skillId)).not.toContain("registry.company.verify");
  });

  it("pins the personal-banking packs to KYC and the business-banking packs to KYB", () => {
    const packsOf = (plan: HarnessPlanV2) => (legacyConfig(plan,"pack-intake-ready")).packs.map((pack) => pack.id).sort();
    expect(packsOf(kyc)).toEqual(["policy.pack.gb.bank-synthetic.personal-banking", "policy.pack.us.bank-synthetic.personal-banking"]);
    expect(packsOf(kyb)).toEqual(["policy.pack.gb.bank-synthetic.business-banking", "policy.pack.us.bank-synthetic.business-banking"]);
  });

  it("preserves the archived pack oracle for a corpus business while OPA owns active gates", () => {
    const config = legacyConfig(kyb,"pack-decision-ready");
    const gb = config.packs.find((pack) => pack.id.includes(".gb."))!;
    const h04 = records("H04");
    const selection = Object.fromEntries(Object.entries(config.recordSelectors).map(([type, selectorId]) => [selectorId, h04[type] ?? []]));
    const result = evaluatePackCheckpoint(config, selection, { capturedAt: "2026-09-30T00:00:00Z", policyAuthority: { policyId: gb.id, policyBundleDigest: gb.digest } });
    expect(result.packId).toBe(gb.id);
    expect(["ALLOW", "REVIEW"]).toContain(result.outcome);
  });
});

describe("documents to identity", () => {
  it("has the identity review read what the document agent extracted, beside the identity and registry records", () => {
    for (const plan of [kyc, kyb]) {
      const review = node(plan, "identity-verification-review");
      for (const type of ["ExtractedAssertion", "Identity", "IdentityIdentifier", "VerificationRecord", "RegistryRecord"]) {
        const selector = plan.contextSelectors.find((item) => item.id === `read${type}-identity-verification-review`)!;
        expect(review.contextSelectorIds, type).toContain(selector.id);
        expect(selector).toMatchObject({ path: `records.${type}`, required: false });
      }
      // The document agent re-reads pages only through the read-only parser, never by writing.
      const loop = node(plan, "document-intelligence-review").config.loop as { skills: Array<{ skillId: string }> };
      expect(loop.skills.map((skill) => skill.skillId).sort()).toEqual(["document.parse.artifact", "document.request.compose"]);
    }
  });

  it("puts the extracted assertions in the identity agent's context pack", async () => {
    const assertion = { object_type: "ExtractedAssertion", object_id: "assert-dob", version_id: "v1", observed_at: "2026-09-30T00:00:00Z", data: { subject: "h03.entity.adaeze", field: "date_of_birth", value: "1984-11-02", document_version: "a".repeat(64) } };
    const pack = assembleContextPack({
      plan: kyc, nodeId: "identity-verification-review", runId: "RUN-flow",
      selection: { caseSubjects: [{ subject_id: "h03.entity.adaeze", display_name: "Adaeze Okonkwo-Bell" }], "readExtractedAssertion-identity-verification-review": [assertion],
        "readIdentity-identity-verification-review": records("H03").Identity },
      snapshot: { snapshotId: `snapshot_${"a".repeat(64)}`, snapshotDigest: "a".repeat(64), tenantId: "tenant-1", caseId: "case-1", caseSequence: 1 },
      envelope: { tenantId: "tenant-1", caseId: "case-1", jurisdiction: "GB", asOfTime: "2026-09-30T00:00:00.000Z" },
    });
    expect(JSON.stringify(pack)).toContain("1984-11-02");
    expect(JSON.stringify(pack)).toContain("1984-02-11");
    // And a scripted identity agent can report the conflict within its schema.
    const result = await runAgentLoop({
      plan: kyc, nodeId: "identity-verification-review", pack,
      invoke: async () => ({ status: "succeeded", output: { action: "final", output: {
        summary: "The passport's date of birth conflicts with the identity record.",
        findings: [{ type: "IDENTITY_CONFLICT", severity: "REVIEW", reason: "Passport states 1984-11-02; the identity record holds 1984-02-11.", sourceRefs: ["assert-dob"] }],
        gaps: [], requiresHumanReview: true,
        verifications: [{ entityRef: "h03.entity.adaeze", status: "CONFLICT", sourceRefs: ["assert-dob"] }],
        documentChecks: [{ entityRef: "h03.entity.adaeze", field: "date_of_birth", documentValue: "1984-11-02", recordValue: "1984-02-11", outcome: "CONFLICT", sourceRefs: ["assert-dob", "h03.identity.adaeze"] }],
      } } }),
      invokeSkill: async () => ({ status: "succeeded", output: {} }),
    });
    expect(result.steps.at(-1)).toMatchObject({ action: "final", status: "accepted" });
  });

  it("shows each review its own skills' results, which its completion is judged by", () => {
    const review = node(kyb, "document-intelligence-review");
    const values = {
      "document-classify-catalog": { lifecycle: "COMPLETED_EXECUTION", computation: { business_status: "COMPLETED", payload: { classifications: [{ document_type: "passport" }] } }, __internal: true },
      "screening-pep-execute": { lifecycle: "COMPLETED_EXECUTION", computation: { business_status: "COMPLETED", payload: {} } },
    };
    const results = agentSkillResults(review, values)!.skillResults;
    // Only its own skills, and of those only the ones that ran; nothing runtime-internal.
    expect(Object.keys(results)).toEqual(["document-classify-catalog"]);
    expect(results["document-classify-catalog"]).toEqual({ lifecycle: "COMPLETED_EXECUTION", computation: values["document-classify-catalog"].computation });
    const pack = assembleContextPack({
      plan: kyb, nodeId: review.id, runId: "RUN-flow", selection: { caseSubjects: [] }, skillResults: results,
      snapshot: { snapshotId: `snapshot_${"a".repeat(64)}`, snapshotDigest: "a".repeat(64), tenantId: "tenant-1", caseId: "case-1", caseSequence: 1 },
      envelope: { tenantId: "tenant-1", caseId: "case-1", jurisdiction: "GB", asOfTime: "2026-09-30T00:00:00.000Z" },
    });
    expect(pack.sections.find((section) => section.id === "skillResults")).toMatchObject({ trust: "UNTRUSTED_DATA", value: results });
    expect(agentSkillResults(node(kyb, "document-classify-catalog"), values)).toBeUndefined();
  });
});

describe("the diligence level reaches the skills that read it", () => {
  const decision = (state: string, level?: string, requirements: string[] = []) => ({ result: { state, ...(level ? { outputs: { diligence: { level, requirements } } } : {}) } });
  it.each([["kyc-agentic", kyc], ["kyb-agentic", kyb], ["securities-agentic", securities]] as const)("%s: the gate precedes the risk skills and binds its level into their facts", (_name, plan) => {
    const gate = node(plan, "diligence-level");
    expect(gate).toMatchObject({ kind: "gate", config: { gateId: "diligence-level", businessDecision: "v2", inputProfile: "canonical.onboarding.v2" } });
    // A decided level hands over to the risk agent's first skill.
    const next = plan.graph.edges.filter((edge) => edge.from === "diligence-level" && edge.outcome === "DECIDED").map((edge) => edge.to);
    expect(next).toHaveLength(1);
    expect(node(plan, next[0]!).config.agentRef).toBe("agent.risk_edd");
    for (const id of ["edd-trigger-evaluate", "decision-requirements-compile"]) {
      const reader = node(plan, id);
      const values = { "diligence-level": decision("DECIDED", "EDD", ["EVD-SOURCE-OF-FUNDS", "EVD-PUBLIC-SOURCE-RESEARCH"]), "risk-tier-assign": { computation: { payload: { tier: "HIGH" } } } };
      const bound = skillParametersFor(reader, values);
      expect((bound.parameters.facts as Record<string, unknown>).diligence_level).toBe("EDD");
      // Requirement-driven planning: the readers also get what the decision resolved, rules included.
      expect((bound.parameters.facts as Record<string, unknown>).diligence_requirements).toEqual(["EVD-SOURCE-OF-FUNDS", "EVD-PUBLIC-SOURCE-RESEARCH"]);
      // An unresolved gate gives the skill nothing to read, so it reports missing input rather than a lower level.
      const missing = skillParametersFor(reader, { ...values, "diligence-level": decision("UNRESOLVED") });
      expect(missing.unresolvedBindings).toContain("facts.diligence_level");
      expect(missing.required).toBe(true);
    }
  });

  it.each([["kyc-agentic", kyc], ["kyb-agentic", kyb], ["securities-agentic", securities]] as const)("%s: the requirements skill's content applies each requirement when the decision lists it", (_name, plan) => {
    const reader = node(plan, "decision-requirements-compile");
    const policies = (reader.config as { skillPolicies?: Array<{ values?: { requirements?: Array<{ id: string; when?: unknown }> } }> }).skillPolicies ?? [];
    expect(policies.length).toBeGreaterThan(0);
    const listed = (id: string) => ({ field: "diligence_requirements", op: "contains", value: id });
    for (const policy of policies) {
      const requirements = policy.values?.requirements ?? [];
      // A requirement only a rule adds applies exactly when the decision lists it.
      expect(requirements.find((entry) => entry.id === "EVD-PUBLIC-SOURCE-RESEARCH")?.when).toEqual(listed("EVD-PUBLIC-SOURCE-RESEARCH"));
      // The SYNTHETIC placeholders stay: one that always applies still does, and a conditional one
      // also applies when the decision lists it.
      for (const entry of requirements) {
        if (entry.when === undefined) continue;
        const when = entry.when as { any?: unknown[] };
        expect(when.any ? when.any : [when], entry.id).toContainEqual(listed(entry.id));
      }
    }
  });
});

describe("the securities firm's flow", () => {
  const policy = JSON.parse(readFileSync(new URL("../../../artifacts/policy/securities-agentic.business-v2.json", import.meta.url), "utf8")) as {
    source: { policySets: Array<{ scope: { institution: string; products: string[]; customerTypes: string[] } }>;
      diligence: { products: string[]; roleRequirements: Record<string, string[]>; screening: Record<string, string> } };
  };
  it("serves the firm's institutional clients on taxonomy nodes, under the firm's own pack", () => {
    expect(policy.source.policySets.map((set) => set.scope)).toEqual([expect.objectContaining({ institution: "securities.synthetic", products: ["BRK", "CUS", "WLT"], customerTypes: ["corporate"] })]);
    expect(policy.source.diligence.products).toEqual(["BRK", "BRK.RETAIL", "BRK.PRIME", "BRK.FINANCING", "CUS", "WLT"]);
    const gate = node(securities, "diligence-level");
    expect(gate.config.policyRef).toBe("policy.securities-agentic.business.v2");
    expect(securities.policyBundles.map((bundle) => bundle.policyId)).toContain("policy.securities-agentic.business.v2");
  });

  it("carries the firm's role requirements and screening map into the compiled policy", () => {
    expect(Object.keys(policy.source.diligence.roleRequirements).sort()).toEqual(["AUTHORIZED_USER", "COUNTERPARTY", "INTERMEDIARY", "UNDERLYING_INVESTOR"]);
    expect(policy.source.diligence.screening).toEqual({ sanctions: "EVD-SANCTIONS-SCREENING", pep: "EVD-PEP-SCREENING", adverse_media: "EVD-ADVERSE-MEDIA" });
    // An underlying investor's obligations reach the requirements skill like any other.
    const reader = node(securities, "decision-requirements-compile");
    const policies = (reader.config as { skillPolicies?: Array<{ values?: { requirements?: Array<{ id: string }> } }> }).skillPolicies ?? [];
    for (const entry of policies) expect(entry.values?.requirements?.map((requirement) => requirement.id)).toContain("EVD-SOURCE-OF-FUNDS");
  });
});

describe("fail-closed task outcomes reach the checkpoints", () => {
  it.each([["kyc-agentic", kyc], ["kyb-agentic", kyb]] as const)("%s: every agent review records its task outcome as a claim", (_name, plan) => {
    const reviews = plan.graph.nodes.filter((item) => item.kind === "agent" && item.config.completion !== undefined);
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) {
      const writes = (review.config.caseWrites as Array<{ commandType: string; when?: string; payload?: { predicate?: string } }>) ?? [];
      const outcome = writes.find((write) => write.commandType === "ProposeClaim" && write.payload?.predicate === "agent_task_outcome");
      expect(outcome, review.id).toBeDefined();
      // The write fires whenever the runtime judged the task, whatever the outcome, and never without a judgment.
      for (const status of ["COMPLETED", "NEEDS_REVIEW", "NEEDS_EVIDENCE", "BLOCKED"]) {
        expect(evaluateCondition(outcome!.when, { output: { __taskCompletion: { status } } }), `${review.id}:${status}`).toBe(true);
      }
      expect(evaluateCondition(outcome!.when, { output: { findings: [] } }), review.id).toBe(false);
    }
  });

  it.each([["kyc-agentic", kyc], ["kyb-agentic", kyb]] as const)("%s: EDD sees the screening outcomes, not only the tier", (_name, plan) => {
    const edd = node(plan, "edd-trigger-evaluate");
    expect(Object.keys(edd.config.skillParameterBindings as Record<string, string>).sort())
      .toEqual(["facts.adverse_media_events", "facts.diligence_level", "facts.diligence_requirements", "facts.pep_hits", "facts.sanctions_hits", "facts.tier"]);
  });
});
