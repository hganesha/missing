import { afterAll, describe, expect, it } from "vitest";
import { stableDigest, type BusinessDecisionBasis } from "@ehf/contracts";
import { closeBusinessPolicyEvaluators, compileBusinessPolicy, evaluateBusinessPolicy, type BusinessPolicySource } from "./business-policy.js";

const d = "a".repeat(64);
const human = { roles: ["Case.Reviewer"], quorum: 2, independentOfProposer: true, allowedChoices: ["APPROVE" as const, "REJECT" as const], actionIntents:{APPROVE:[],REJECT:[]}, ttlSeconds: 3600 };
const result = (state: "DECIDED" | "NEEDS_HUMAN" | "NEEDS_EVIDENCE" | "UNRESOLVED", reason: string, actions: unknown[] = []) => ({
  state, reasonCodes: [reason], ruleIds: [], actions, humanRequirement: state === "NEEDS_HUMAN" ? human : null, gaps: [],
});
function source(): BusinessPolicySource {
  return {
    apiVersion: "harness.factory/business-policy-v2", kind: "BusinessPolicy",
    metadata: { id: "policy.business.test", version: "2.0.0", owner: "policy.owner" }, decisionTtlSeconds: 60,
    policySets: [{ id: "installation.test", version: "2.0.0", status: "CANDIDATE", packPin: { id: "pack.test", digest: d },
      scope: { jurisdiction: "US", institution: "bank.test", products: ["deposit"], customerTypes: ["individual"], purposes: ["CDD_ONBOARDING"] },
      modules: [{ id: "institution.test", version: "2.0.0", digest: d }], configuration: { automaticApproval: true, automaticDecline: false } }],
    gates: { disposition: { inputProfile: "onboarding.disposition.v2", rules: [
      { id: "MISSING", when: { path: "/facts/identity", op: "missing" }, result: result("NEEDS_EVIDENCE", "IDENTITY_MISSING") as never },
      { id: "DECLINE", when: { all: [{ path: "/configuration/automaticDecline", op: "eq", value: true }, { path: "/facts/identity", op: "eq", value: false }] },
        result: result("DECIDED", "DECLINED", [{ kind: "case_command", commandType: "FinalizeDisposition", payload: { outcome: "DECLINED", rationale: "Policy decline", recommendationRef: "$input/facts/recommendation" } }]) as never },
      { id: "APPROVE", when: { all: [{ path: "/configuration/automaticApproval", op: "eq", value: true }, { path: "/facts/identity", op: "eq", value: true }] },
        result: result("DECIDED", "APPROVED", [{ kind: "case_command", commandType: "FinalizeDisposition", payload: { outcome: "APPROVED", rationale: "Policy approval", recommendationRef: "$input/facts/recommendation" } }]) as never },
    ], otherwise: result("NEEDS_HUMAN", "HUMAN_REQUIRED") as never } },
  };
}
const compile = (s = source()) => compileBusinessPolicy(s, { opaVersion: "1.9.0" });
function basis(compiled: ReturnType<typeof compile>): BusinessDecisionBasis {
  return { tenantId: "tenant.test", caseId: "case.test", planDigest: d, releaseDigest: d, caseSequence: 12,
    snapshotDigest: d, selectedInputDigest: d, proposerPrincipalIds: [], dependencyDigest: d, effectivePolicySetDigest: compiled.policySets[0]!.setDigest,
    policyBundleDigest: compiled.manifest.bundleDigest, gateId: "disposition", inputProfile: "onboarding.disposition.v2",
    purpose: "CDD_ONBOARDING", subjectIds: ["party.test"], evaluatedAt: "2026-11-09T12:00:00Z", knowledgeCutoff: "2026-11-09T12:00:00Z",
    scope: { jurisdiction: "US", institution: "bank.test", products: ["deposit"], customerType: "individual" } };
}
afterAll(closeBusinessPolicyEvaluators);

describe("business policies execute the emitted OPA bundle (required, never skipped)", () => {
  it("permits automatic approval, binds the exact action/input/engine and reproduces a replay", async () => {
    const compiled = compile(); const request = { compiled, basis: basis(compiled), facts: { identity: true, recommendation: "rec.1" } };
    const decision = await evaluateBusinessPolicy(request);
    expect(decision.result).toMatchObject({ state: "DECIDED", reasonCodes: ["APPROVED"], actions: [{ payload: { recommendationRef: "rec.1", outcome: "APPROVED" } }] });
    expect(decision.evaluator).toEqual({ kind: "OPA", version: "1.9.0" });
    expect(await evaluateBusinessPolicy(request)).toEqual(decision);
    const { receiptDigest, ...body } = decision; expect(receiptDigest).toBe(stableDigest(body));
  });
  it("the same facts require humans under a different released installation configuration", async () => {
    const s = source(); s.policySets[0]!.configuration.automaticApproval = false; const compiled = compile(s);
    const decision = await evaluateBusinessPolicy({ compiled, basis: basis(compiled), facts: { identity: true, recommendation: "rec.1" } });
    expect(decision.result).toMatchObject({ state: "NEEDS_HUMAN", actions: [], humanRequirement: human });
  });
  it("decline requires an explicit matching rule and an enabled installation option", async () => {
    const s = source(); s.policySets[0]!.configuration.automaticDecline = true; const compiled = compile(s);
    expect((await evaluateBusinessPolicy({ compiled, basis: basis(compiled), facts: { identity: false, recommendation: "rec.1" } })).result)
      .toMatchObject({ state: "DECIDED", actions: [{ payload: { outcome: "DECLINED" } }] });
  });
  it("missing facts request evidence rather than becoming approval/decline or default false", async () => {
    const compiled = compile(); const b = basis(compiled);
    for (const facts of [{}, { identity: null }]) expect((await evaluateBusinessPolicy({ compiled, basis: b, facts })).result)
      .toMatchObject({ state: "NEEDS_EVIDENCE", actions: [] });
  });
  it("a source value that looks like a template is data, never evaluated twice", async () => {
    const compiled = compile(); const decision = await evaluateBusinessPolicy({ compiled, basis: basis(compiled), facts: { identity: true, recommendation: "$input/configuration/automaticApproval" } });
    expect(decision.result.actions[0]).toMatchObject({ payload: { recommendationRef: "$input/configuration/automaticApproval" } });
  });
  it("does not authorize an action whose required template input is missing", async () => {
    const compiled = compile(); await expect(evaluateBusinessPolicy({ compiled, basis: basis(compiled), facts: { identity: true } })).rejects.toThrow("policy.action_input_missing");
  });
  it("rejects changed bundles, set/scope/purpose/profile and the wrong OPA version", async () => {
    const compiled = compile(); const b = basis(compiled);
    for (const changed of [{ purpose: "REPORTING" }, { effectivePolicySetDigest: "b".repeat(64) }, { inputProfile: "wrong" },
      { scope: { ...b.scope, jurisdiction: "GB" } }, { scope: { ...b.scope, products: ["lending"] } }])
      await expect(evaluateBusinessPolicy({ compiled, basis: { ...b, ...changed }, facts: {} })).rejects.toThrow("policy.decision_authority_mismatch");
    const modified = structuredClone(compiled); modified.files["data.json"] = "{}";
    await expect(evaluateBusinessPolicy({ compiled: modified, basis: b, facts: {} })).rejects.toThrow("policy.compilation_integrity_mismatch");
    const wrong = compileBusinessPolicy(source(), { opaVersion: "1.8.0" });
    await expect(evaluateBusinessPolicy({ compiled: wrong, basis: basis(wrong), facts: {} })).rejects.toThrow("policy.opa_version_mismatch");
  });
  it("quantified relationships cannot pass vacuously or with a missing row field", async () => {
    const s = source(); const gate = s.gates.disposition!;
    gate.rules = [{ id: "COVERED", when: { every: { path: "/facts/parties", allowEmpty: false, where: { all: [{ path: "/screened", op: "eq", value: true }, { path: "/coverage", op: "gte", value: "1" }] } } }, result: result("DECIDED", "COVERED") as never }];
    gate.otherwise = result("UNRESOLVED", "PARTIAL") as never;
    const compiled = compile(s);
    for (const parties of [[], [{}], [{ screened: true }], [{ screened: true, coverage: "1" }, { screened: false, coverage: "1" }]])
      expect((await evaluateBusinessPolicy({ compiled, basis: basis(compiled), facts: { parties } })).result.state).toBe("UNRESOLVED");
    expect((await evaluateBusinessPolicy({ compiled, basis: basis(compiled), facts: { parties: [{ screened: true, coverage: "1" }] } })).result.state).toBe("DECIDED");
  });
  it("covers every party and screening type through correlated OPA predicates",async()=>{
    const s=source();
    s.policySets[0]!.configuration.types=["sanctions","pep"];
    s.gates.disposition!.rules=[{id:"ALL_PARTIES",when:{every:{path:"/facts/parties",allowEmpty:false,where:{every:{path:"/configuration/types",fromInput:true,allowEmpty:false,where:{some:{path:"/facts/screens",fromInput:true,where:{all:[
      {path:"/subject",op:"eq",valueFromParent:{depth:2,path:"/id"}},
      {path:"/type",op:"eq",valueFromParent:{depth:1,path:""}},
      {path:"/status",op:"eq",value:"COMPLETED"},
    ]}}}}}}},result:result("DECIDED","COVERED") as never}];
    s.gates.disposition!.otherwise=result("NEEDS_EVIDENCE","COVERAGE_GAP") as never;
    const compiled=compile(s),b=basis(compiled);
    const parties=[{id:"customer"},{id:"owner"},{id:"signatory"}];
    const screens=parties.flatMap(party=>["sanctions","pep"].map(type=>({subject:party.id,type,status:"COMPLETED"})));
    expect((await evaluateBusinessPolicy({compiled,basis:b,facts:{parties,screens}})).result.state).toBe("DECIDED");
    for(let index=0;index<screens.length;index++) expect((await evaluateBusinessPolicy({compiled,basis:b,facts:{parties,screens:screens.filter((_,i)=>i!==index)}})).result.state).toBe("NEEDS_EVIDENCE");
    expect((await evaluateBusinessPolicy({compiled,basis:b,facts:{parties:[],screens:[]}})).result.state).toBe("NEEDS_EVIDENCE");
  });
  it("uses the policy's freshness limit and rejects future, missing and invalid observations",async()=>{
    const s=source();s.policySets[0]!.configuration.maxAgeSeconds=60;
    s.gates.disposition!.rules=[{id:"CURRENT",when:{path:"/facts/observedAt",op:"age_lte_seconds",valueFrom:"/configuration/maxAgeSeconds"},result:result("DECIDED","CURRENT") as never}];
    s.gates.disposition!.otherwise=result("NEEDS_EVIDENCE","STALE") as never;
    const compiled=compile(s),b=basis(compiled),asOf="2026-11-09T12:01:00.000Z";
    for(const observedAt of [null,"invalid","2026-11-09T12:01:00.001Z","2026-11-09T11:59:59.999Z"])
      expect((await evaluateBusinessPolicy({compiled,basis:b,facts:{asOf,observedAt}})).result.state).toBe("NEEDS_EVIDENCE");
    expect((await evaluateBusinessPolicy({compiled,basis:b,facts:{asOf,observedAt:"2026-11-09T12:00:00.000Z"}})).result.state).toBe("DECIDED");
  });
  it("supersedes an outcome only by a strictly later one of the same kind",async()=>{
    const s=source();
    // Every BLOCKED run is followed by a later COMPLETED run of the same task.
    s.gates.disposition!.rules=[{id:"SETTLED",when:{every:{path:"/facts/runs",allowEmpty:false,where:{any:[
      {path:"/status",op:"eq",value:"COMPLETED"},
      {some:{path:"/facts/runs",fromInput:true,where:{all:[
        {path:"/task",op:"eq",valueFromParent:{depth:1,path:"/task"}},
        {path:"/status",op:"eq",value:"COMPLETED"},
        {path:"/at",op:"after",valueFromParent:{depth:1,path:"/at"}},
      ]}}},
    ]}}},result:result("DECIDED","SETTLED") as never}];
    s.gates.disposition!.otherwise=result("NEEDS_EVIDENCE","UNSETTLED") as never;
    const compiled=compile(s),b=basis(compiled);
    const run=(task:string,status:string,at:string)=>({task,status,at});
    const state=async(runs:unknown[])=>(await evaluateBusinessPolicy({compiled,basis:b,facts:{runs}})).result.state;
    expect(await state([run("a","BLOCKED","2026-11-09T12:00:00Z"),run("a","COMPLETED","2026-11-09T12:00:00.001Z")])).toBe("DECIDED");
    for(const later of ["2026-11-09T12:00:00Z","2026-11-09T11:59:59Z","invalid",null])
      expect(await state([run("a","BLOCKED","2026-11-09T12:00:00Z"),run("a","COMPLETED",later as never)])).toBe("NEEDS_EVIDENCE");
    expect(await state([run("a","BLOCKED","2026-11-09T12:00:00Z"),run("b","COMPLETED","2026-11-09T13:00:00Z")])).toBe("NEEDS_EVIDENCE");
  });

});

describe("business policy compilation and compatibility", () => {
  it("is deterministic and distinguishes composition, bundle and policy-set digests", () => {
    const c = compile(); expect(compile()).toEqual(c);
    expect(new Set([d, c.manifest.bundleDigest, c.policySets[0]!.setDigest]).size).toBe(3);
    expect(c.policySets[0]!.gateBindings.disposition?.bundleDigest).toBe(c.manifest.bundleDigest);
  });
  it("candidate sets cannot compile for production and a status field is not a runtime approval", () => {
    expect(() => compileBusinessPolicy(source(), { opaVersion: "1.9.0", release: "production" })).toThrow("policy.production_blocked");
  });
  it("rejects business effects in defaults, non-decisions and unscoped predicate inputs", () => {
    const s = source(); s.gates.disposition!.otherwise = s.gates.disposition!.rules[2]!.result;
    expect(() => compile(s)).toThrow("policy.default_business_action_forbidden");
    const other = source(); other.gates.disposition!.rules[0]!.when = { path: "/callerRoles", op: "present" };
    expect(() => compile(other)).toThrow("policy.predicate_path_invalid");
  });
});
