import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harnessPlanV2Schema, verifyHarnessPlanDigest } from "@ehf/contracts";
import { runtimeTargetValid } from "./agent-profiles.js";
import { compilePackage, COMPILER_IDENTITY, mergeExtensionConfig, nodeKindSupported, validatePackage, type CompiledPlan } from "./compiler.js";
import { CompilerError } from "./errors.js";
import { digest, object, parseJson, stringify, type JsonObject } from "./json.js";
import { businessSkillIdValid, semverValid } from "./skill-bindings.js";
import {
  acceptedCases,
  bindSanctionsNode,
  extendedAcceptedCases,
  extendedRefusalCases,
  invoiceFixture,
  invoiceWorkflowWithGroupAndSubgraph,
  INVOICE_PACKAGE,
  INVESTIGATION_LIMITS,
  investigationSkillNode,
  KYC_FIXTURE,
  KYC_FIXTURE_PLAN,
  kycSkillFixture,
  modelProfilesPath,
  refusalCases,
  replaceAll,
  replaceFirst,
  SANCTIONS_SKILL,
  SKILL_HOSTED_FIXTURE_PLAN,
  skillHostedFixture,
  unboundSanctionsSkill,
} from "./test-support.js";

type Plan = Record<string, any>;

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Track a scratch fixture for cleanup. */
function fixture(directory: string): string {
  scratch.push(directory);
  return directory;
}

function compile(directory: string): Plan {
  return compilePackage(directory, { modelProfiles: modelProfilesPath }).plan as Plan;
}

/** The plan digest re-computed from the emitted bytes (floats stay floats). */
function selfDigest(compiled: CompiledPlan): string {
  const document = parseJson(compiled.document) as JsonObject;
  delete document.planDigest;
  delete document.planId;
  return digest(document);
}

/** The package compiles to its committed plan, byte for byte. */
function expectCommittedPlan(compiled: CompiledPlan, path: string): void {
  expect(compiled.document).toBe(readFileSync(path, "utf8"));
}

function refusal(directory: string): string {
  try {
    compilePackage(directory, { modelProfiles: modelProfilesPath });
  } catch (error) {
    expect(error).toBeInstanceOf(CompilerError);
    return (error as Error).message;
  }
  throw new Error(`expected ${directory} to be refused`);
}

const node = (plan: Plan, id: string) => plan.graph.nodes.find((item: Plan) => item.id === id);
const profile = (plan: Plan, id: string) => plan.agentProfiles.find((item: Plan) => item.id === id);
const envelope = (plan: Plan, id: string) => plan.permissionEnvelopes.find((item: Plan) => item.nodeId === id);

describe("normalization", () => {
  it("preserves config keys the normalizer does not model", () => {
    // LGIR's node config is a closed set of keys; compiling through it alone dropped
    // caseWrites/agentRef/runtimeTarget and produced a plan with no case-write authority.
    const normalized: JsonObject = Object.assign(object(), { operation: "", expression: "" });
    mergeExtensionConfig(normalized, Object.assign(object(), {
      operation: "should-not-override",
      caseWrites: [Object.assign(object(), { commandType: "AddSubject" })],
      agentRef: "agent.kyc.policy.v1",
      runtimeTarget: "local_http",
    }));
    expect(normalized.operation).toBe("");
    expect(normalized.agentRef).toBe("agent.kyc.policy.v1");
    expect(normalized.runtimeTarget).toBe("local_http");
    expect((normalized.caseWrites as JsonObject[])[0]!.commandType).toBe("AddSubject");
  });

  it("reads the authored config per node into the plan", () => {
    const plan = compile(fixture(invoiceFixture("node-config", INVOICE_PACKAGE, replaceFirst(
      invoiceWorkflowWithGroupAndSubgraph(),
      "    - { id: vendor-check, kind: tool, name: Vendor lookup }\n",
      "    - { id: vendor-check, kind: tool, name: Vendor lookup, config: { caseWrites: [{ commandType: AddNote }], runtimeTarget: databricks } }\n",
    ))));
    expect(node(plan, "vendor-check").config.caseWrites).toEqual([{ commandType: "AddNote" }]);
    expect(node(plan, "vendor-check").config.runtimeTarget).toBe("databricks");
    expect(node(plan, "po-check").config).not.toHaveProperty("caseWrites");
    expect(node(plan, "verification-phase").config.subgraph).toEqual({
      ref: "ladder://workflows/verification", inputMap: { request: "/input" }, outputMap: { result: "/output" }, checkpointer: "perInvocation",
    });
  });

  it("orders canonical keys by UTF-8 bytes", () => {
    // The plan is re-digested in TypeScript with a code-unit sort; both must agree.
    const value = Object.assign(object(), { Zebra: 1, apple: 2, Apple: 3, a_b: 4, aB: 5 });
    expect(stringify(value)).toBe('{"Apple":3,"Zebra":1,"aB":5,"a_b":4,"apple":2}');
    // A supplementary-plane key sorts after U+E000 in UTF-8 (code point) order.
    expect(stringify(Object.assign(object(), { "\u{1F600}": 1, "": 2 }))).toBe('{"":2,"\u{1F600}":1}');
  });
});

describe("package contract", () => {
  it("refuses removed v1 packages on compile and validate", () => {
    const directory = fixture(invoiceFixture("v1", replaceAll(INVOICE_PACKAGE, "harness.factory/domain-package-v2", "harness.factory/domain-package-v1")));
    const messages = [refusal(directory)];
    try {
      validatePackage(directory);
    } catch (error) {
      messages.push((error as Error).message);
    }
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).toContain("package.v1_removed");
      expect(message).toContain("harness.factory/domain-package-v2");
    }
  });

  it("accepts native group and subgraph primitives", () => {
    for (const kind of ["loop", "teacher"]) expect(nodeKindSupported(kind)).toBe(false);
    for (const kind of ["gate", "fanout", "approval", "transform", "group", "subgraph"]) expect(nodeKindSupported(kind)).toBe(true);
  });

  it("addresses runtime targets as an adapter and an optional binding", () => {
    for (const target of ["local_http", "hosted_http", "databricks:kyc-investigator", "hosted_http:kyc.v2"]) expect(runtimeTargetValid(target)).toBe(true);
    for (const target of ["", "Databricks", "databricks:", "databricks:Upper", "a", "x:y:z!"]) expect(runtimeTargetValid(target)).toBe(false);
  });

  it("validates catalog-style identifiers", () => {
    for (const id of ["entity.resolve", "screening.adverse_media.execute", "ownership.ubo.resolve", "risk_x.a1"]) expect(businessSkillIdValid(id)).toBe(true);
    for (const id of ["entity", "Entity.resolve", "entity.", "1x.y", "a.B", "a.b-c", "entity.resolve.v1."]) expect(businessSkillIdValid(id)).toBe(false);
    for (const version of ["0.1.0", "1.0.0-rc.1", "10.20.30+build.5"]) expect(semverValid(version)).toBe(true);
    for (const version of ["1.0", "01.0.0", "1.0.x", ""]) expect(semverValid(version)).toBe(false);
  });

  it("emits policy and release authority", () => {
    const compiled = compilePackage(fixture(invoiceFixture("v2", INVOICE_PACKAGE, invoiceWorkflowWithGroupAndSubgraph())), { modelProfiles: modelProfilesPath });
    const plan = compiled.plan as Plan;
    expect(plan.compiler.compatibilityVersion).toBe("4");
    const integrated = compile(fixture(invoiceFixture(
      "v2-integrations",
      `${INVOICE_PACKAGE}\nintegrations:\n  triggers: []\n  humanActions: []\n  publications: []\n`,
      invoiceWorkflowWithGroupAndSubgraph(),
    )));
    expect(plan.apiVersion).toBe("harness.factory/plan-v2");
    expect(plan.execution.engine.kind).toBe("harness-runtime");
    expect(plan.execution.engine.adapterVersion).toBe("harness-runtime-v2");
    expect(plan.execution.coordinationMode).toBe("caseStore");
    expect(plan.execution.durability).toBe("durable");
    expect(integrated.compiler.compatibilityVersion).toBe("5");
    expect(integrated.integrations.triggers).toEqual([]);
    expect(plan.policyBundles[0].policyId).toBe("policy.invoice.test");
    expect(plan.policyBundles[0].bundleDigest).toBe("a".repeat(64));
    expect(plan.releaseConstraints.regions).toEqual(["US"]);
    expect(plan.graph.nodes.some((item: Plan) => item.id === "checks" && item.kind === "group")).toBe(true);
    expect(plan.graph.nodes.some((item: Plan) => item.id === "verification-phase" && item.kind === "subgraph")).toBe(true);
    expect(plan.planDigest).toBe(selfDigest(compiled));
  });

  it("emits the compiler identity and a contract-valid, self-verifying plan", () => {
    const plan = compile(fixture(invoiceFixture("identity")));
    expect(plan.compiler).toEqual({
      name: COMPILER_IDENTITY.name,
      version: COMPILER_IDENTITY.version,
      lgirCoreRevision: COMPILER_IDENTITY.lgirCoreRevision,
      compatibilityVersion: "4",
      digest: digest(Object.assign(object(), { ...COMPILER_IDENTITY, compatibilityVersion: "4" })),
    });
    const parsed = harnessPlanV2Schema.parse(plan);
    expect(verifyHarnessPlanDigest(parsed)).toBe(true);
    expect(plan.planId).toBe(`invoice-match@0.1.0:${plan.planDigest.slice(0, 12)}`);
    expect(plan.createdAt).toBe("1970-01-01T00:00:00Z");
  });

  it("keeps the compiler version in step with the package version", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(COMPILER_IDENTITY.version).toBe(manifest.version);
  });
});

describe("business skill bindings", () => {
  it("keeps the bytes of plans without skill bindings", () => {
    const compiled = compilePackage(KYC_FIXTURE, { modelProfiles: modelProfilesPath });
    expect(compiled.plan).not.toHaveProperty("skillBindings");
    expectCommittedPlan(compiled, KYC_FIXTURE_PLAN);
    // Declared but unreferenced bindings do not reach the plan either.
    expect(compile(fixture(kycSkillFixture("unreferenced", SANCTIONS_SKILL)))).not.toHaveProperty("skillBindings");
  });

  it("pins skill candidates into the plan and the node envelope", () => {
    // The node keeps its explicit binding (the first candidate) and gains every candidate.
    const plan = compile(fixture(kycSkillFixture("explicit", SANCTIONS_SKILL, (p, w) => [p, bindSanctionsNode(w)])));
    const bindings = plan.skillBindings;
    expect(bindings).toHaveLength(1);
    expect(bindings[0].skillId).toBe("screening.sanctions.execute");
    expect(bindings[0].manifestDigest).toBe("b".repeat(64));
    // An omitted connector is pinned to the capability's own binding.
    expect(bindings[0].candidates[0]).toEqual({
      capabilityId: "screening.sanctions.v1", connectorId: "opensanctions:sanctions", equivalentCoverageGroup: "opensanctions.sanctions",
    });
    expect(bindings[0].candidates[1].connectorId).toBe("wiring:opensanctions:screening.sanctions");
    expect(bindings[0].candidates[2].equivalentCoverageGroup).toBeNull();
    expect(bindings[0].policy.allow_fallback).toBe(true);
    expect(envelope(plan, "sanctions-screen").capabilities).toEqual(["screening.sanctions.v1", "screening.enforcement.v1"]);
    expect(plan.capabilities.some((capability: Plan) => capability.id === "screening.enforcement.v1")).toBe(true);
    expect(node(plan, "sanctions-screen").config.skillId).toBe("screening.sanctions.execute");
    expect(node(plan, "sanctions-screen").config.capabilityId).toBe("screening.sanctions.v1");
  });

  it("binds an unbound skill node to its first candidate", () => {
    const compiled = compilePackage(fixture(kycSkillFixture("unbound", unboundSanctionsSkill(), (p, w) => [
      replaceAll(p, "  sanctions-screen: screening.sanctions.v1\n", ""), bindSanctionsNode(w),
    ])), { modelProfiles: modelProfilesPath });
    const plan = compiled.plan as Plan;
    expect(node(plan, "sanctions-screen").config.capabilityId).toBe("screening.enforcement.v1");
    expect(envelope(plan, "sanctions-screen").capabilities).toEqual(["screening.enforcement.v1", "screening.sanctions.v1"]);
    // skillBindings are covered by the plan digest.
    expect(plan.skillBindings).toHaveLength(1);
    expect(plan.planDigest).toBe(selfDigest(compiled));
  });

  it("pins skill-host bundles and dependency capabilities", () => {
    const compiled = compilePackage(fixture(skillHostedFixture("pinned")), { modelProfiles: modelProfilesPath });
    const plan = compiled.plan as Plan;
    const binding = plan.skillBindings[0];
    expect(binding.bundleDigest).toBe("sha256:c0e0ba20bd921f24f6a1b095f5fd049bfcb5cb79a66208f0acea870ef29e852f");
    expect(binding.dependencyCapabilities).toEqual(["business.registry.lookup.v1"]);
    expect(binding.candidates[0].connectorId).toBe("skills:sample.registry.verify");
    // Declared dependencies join the node envelope, so a delegated envelope can be narrowed to them.
    expect(envelope(plan, "registry-verify").capabilities).toEqual(["skill.sample.registry.verify.v1", "business.registry.lookup.v1"]);
    expectCommittedPlan(compiled, SKILL_HOSTED_FIXTURE_PLAN);
  });
});

describe("agent profiles", () => {
  it("compiles agent profiles into the plan", () => {
    const plan = compile(KYC_FIXTURE);
    expect(plan).not.toHaveProperty("skills");
    expect(plan).not.toHaveProperty("agents");
    expect(plan.compiler.compatibilityVersion).toBe("4");
    const investigation = profile(plan, "agent.kyc.investigation.v1");
    // The sorted union of the instructions' capabilities and the primary capability.
    expect(investigation.allowedCapabilities).toEqual([
      "business.officers.lookup.v1", "business.ownership.discover.v1", "business.registry.lookup.v1",
      "document.evidence.package.v1", "identity.document.verify.v1", "model.kyc.investigation.v1",
      "reference.identifier.lookup.v1", "screening.adverse_media.v1", "screening.enforcement.v1",
    ]);
    expect(investigation.instructions[0].id).toBe("skill.kyc.investigation.v1");
    expect(investigation.instructions[0].text.startsWith("Start from the canonical case.")).toBe(true);
    expect(investigation.purposes).toEqual(["KYC_INVESTIGATION"]);
    expect(investigation.limits).toEqual({ maxSteps: 8, maxObservationChars: 12000 });
    expect(investigation.allowedSkills).toEqual([]);
    const assessment = profile(plan, "agent.kyc.case-assessment.v2");
    // Omitted limits take the defaults.
    expect(assessment.limits).toEqual({ maxSteps: 8, maxObservationChars: 64000 });
    expect(assessment.allowedCapabilities).toEqual(["model.kyc.case_assessment.v2"]);
    expect(node(plan, "case-assessment").config).not.toHaveProperty("skillRefs");
  });

  it("rule 3: a matching agentVersion compiles", () => {
    compile(fixture(kycSkillFixture("version-match", "", (p, w) => [p, replaceAll(w, "        agentRef: agent.kyc.case-assessment.v2\n", "        agentRef: agent.kyc.case-assessment.v2\n        agentVersion: 1.0.0\n")])));
  });

  it("rule 4: the primary capability alone allows the bound model", () => {
    const plan = compile(fixture(kycSkillFixture("primary-only", "", (p, w) => [replaceAll(p, "        allowedCapabilityIds: [model.kyc.case_assessment.v2]\n", ""), w])));
    expect(profile(plan, "agent.kyc.case-assessment.v2").allowedCapabilities).toEqual(["model.kyc.case_assessment.v2"]);
  });

  it("rule 5: an allowed skill compiles", () => {
    const plan = compile(fixture(kycSkillFixture("skill-allowed", SANCTIONS_SKILL, (p, w) => [
      replaceFirst(p, INVESTIGATION_LIMITS, `${INVESTIGATION_LIMITS}    allowedSkills: [{skillId: screening.sanctions.execute, semver: 0.1.0}]\n`),
      investigationSkillNode(w),
    ])));
    expect(profile(plan, "agent.kyc.investigation.v1").allowedSkills).toEqual([{ skillId: "screening.sanctions.execute", semver: "0.1.0" }]);
  });

  it("rule 7: a node inherits omitted loop limits and keeps narrower ones", () => {
    const inherited = compile(fixture(kycSkillFixture("inherit", "", (p, w) => [
      replaceAll(p, INVESTIGATION_LIMITS, "    limits: {maxSteps: 12, maxObservationChars: 9000}\n"),
      replaceAll(replaceAll(w, "          maxObservationChars: 12000\n", ""), "          maxSteps: 8\n", ""),
    ])));
    expect(node(inherited, "kyc-investigation").config.loop.maxSteps).toBe(12);
    expect(node(inherited, "kyc-investigation").config.loop.maxObservationChars).toBe(9000);
    const narrowed = compile(fixture(kycSkillFixture("narrow", "", (p, w) => [replaceAll(p, INVESTIGATION_LIMITS, "    limits: {maxSteps: 12, maxObservationChars: 20000}\n"), w])));
    expect(node(narrowed, "kyc-investigation").config.loop.maxSteps).toBe(8);
    expect(node(narrowed, "kyc-investigation").config.loop.maxObservationChars).toBe(12000);
  });
});

describe("refusals", () => {
  it.each([...refusalCases, ...extendedRefusalCases].map((item) => [item.name, item] as const))("%s", (_name, item) => {
    const message = refusal(fixture(item.fixture()));
    for (const expected of item.expected) expect(message).toContain(expected);
  });
});

describe("accepted variants", () => {
  it.each([...acceptedCases, ...extendedAcceptedCases].map((item) => [item.name, item] as const))("%s", (_name, item) => {
    const compiled = compilePackage(fixture(item.fixture()), { modelProfiles: modelProfilesPath });
    expect(compiled.planDigest).toBe(selfDigest(compiled));
    expect(compiled.planId.endsWith(`:${compiled.planDigest.slice(0, 12)}`)).toBe(true);
  });

  it("keeps loop tools unique, joins them to the envelope and carries only reachable capabilities", () => {
    const item = extendedAcceptedCases.find((entry) => entry.name === "loop-accepted")!;
    const plan = compile(fixture(item.fixture()));
    expect(envelope(plan, "recommendation")).toMatchObject({
      capabilities: ["model.invoice.recommend", "vendor.lookup", "purchase_order.lookup"],
      effects: ["paid", "read"],
    });
    expect(plan.capabilities.map((capability: Plan) => capability.id)).toEqual(["vendor.lookup", "purchase_order.lookup", "model.invoice.recommend"]);
  });

  it("gives a context-reading node without a binding an empty envelope", () => {
    const item = extendedAcceptedCases.find((entry) => entry.name === "selector-envelope-only")!;
    const plan = compile(fixture(item.fixture()));
    expect(envelope(plan, "result")).toMatchObject({ capabilities: [], effects: [] });
    expect(node(plan, "result").contextSelectorIds).toEqual(["vendor"]);
  });

  it("restores gate and fanout kinds after LGIR analysis", () => {
    const item = extendedAcceptedCases.find((entry) => entry.name === "gate-and-fanout")!;
    const plan = compile(fixture(item.fixture()));
    expect(node(plan, "po-check")).toMatchObject({ kind: "gate", config: { policyRef: "policy.invoice.test", gateId: "g1", operation: "select" } });
    expect(node(plan, "vendor-check")).toMatchObject({ kind: "fanout", config: { joinMode: "allSettled", operation: "select" } });
    // An unbound gate that captures evidence still gets a (capability-less) envelope.
    expect(envelope(plan, "po-check")).toMatchObject({ capabilities: [], effects: [] });
    expect(envelope(plan, "vendor-check")).toBeUndefined();
  });

  it("writes floats as floats and keeps a missing policies block at its zero default", () => {
    const floats = compilePackage(fixture(extendedAcceptedCases.find((entry) => entry.name === "floats-and-integers")!.fixture()), { modelProfiles: modelProfilesPath }).document;
    expect(floats).toContain('"maxCostUsd": 1.0,');
    expect(floats).toContain('"threshold": 1.0,');
    for (const text of ["1e+21", "1e-7", "1000000000000000.0", "1e+16", "-0.0", "0.000025", "18446744073709551615", "9007199254740993", '"007"', '"1_0"', '"yes"']) {
      expect(floats).toContain(text);
    }
    const noPolicies = compile(fixture(extendedAcceptedCases.find((entry) => entry.name === "no-policies-block")!.fixture()));
    expect(noPolicies.execution.maxConcurrency).toBe(0);
    const emptyPolicies = compile(fixture(extendedAcceptedCases.find((entry) => entry.name === "empty-policies-block")!.fixture()));
    expect(emptyPolicies.execution.maxConcurrency).toBe(4);
  });
});

describe("determinism", () => {
  it("produces the same bytes from a directory and from the same files in memory", () => {
    const directory = fixture(invoiceFixture("memory"));
    const files = Object.fromEntries(["package.yaml", "workflow.yaml", "policy.yaml"].map((name) => [name, readFileSync(join(directory, name), "utf8")]));
    const fromDirectory = compilePackage(directory, { modelProfiles: modelProfilesPath });
    const fromMemory = compilePackage(files, { modelProfiles: JSON.parse(readFileSync(modelProfilesPath, "utf8")) });
    expect(fromMemory.document).toBe(fromDirectory.document);
    expect(compilePackage(directory, { modelProfiles: modelProfilesPath }).document).toBe(fromDirectory.document);
  });

  it("orders the dependency manifest by path components", () => {
    const plan = compilePackage({
      "package.yaml": INVOICE_PACKAGE,
      "workflow.yaml": readFileSync(join(fixture(invoiceFixture("manifest")), "workflow.yaml"), "utf8"),
      "policy.yaml": "kind: Policy\n",
      "a-b": "x",
      "a/b": "y",
      "Z": "z",
    }, { modelProfiles: modelProfilesPath }).plan as Plan;
    expect(plan.dependencyManifest.map((item: Plan) => item.id)).toEqual(["Z", "a/b", "a-b", "package.yaml", "policy.yaml", "workflow.yaml"]);
    expect(plan.packageDigest).toBe(plan.dependencyManifestDigest);
  });

  it("refuses in-memory paths that leave the package", () => {
    expect(() => compilePackage({ "../package.yaml": "x" })).toThrow("package.dependency_path_unsafe:../package.yaml");
  });

  it("refuses a workflow outside the package", () => {
    const directory = fixture(invoiceFixture("workflow-outside", replaceAll(INVOICE_PACKAGE, "workflow: workflow.yaml", "workflow: ../workflow.yaml")));
    expect(refusal(directory)).toBe("package.dependency_path_unsafe:../workflow.yaml");
  });
});

describe("validate", () => {
  it("returns the LGIR analysis of a valid package", () => {
    const result = validatePackage(KYC_FIXTURE);
    expect(result.ok).toBe(true);
    expect(result.analysis.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(result.report)).toMatchObject({ ok: true, stats: { nodes: result.analysis.stats.nodes } });
  });

  it("reports LGIR errors without throwing", () => {
    const directory = fixture(invoiceFixture("validate-cycle", INVOICE_PACKAGE, `${readFileSync(join(fixture(invoiceFixture("base")), "workflow.yaml"), "utf8")}    - { id: e5, from: po-check, to: vendor-check, kind: data }\n`));
    const result = validatePackage(directory);
    expect(result.ok).toBe(false);
    expect(result.analysis.diagnostics.map((item) => item.code)).toContain("LG150");
  });
});
