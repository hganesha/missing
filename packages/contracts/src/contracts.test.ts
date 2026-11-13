import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  artifactRegistryEntrySchema,
  businessCommandSchema,
  canonicalCapabilityIdSchema,
  capabilityRegistrationSchema,
  canonicalJson,
  connectorCatalogSchema,
  connectorRegistrationSchema,
  caseSnapshotSchema,
  contextManifestSchema,
  createKycCaseRequestSchema,
  domainPackageV2Schema,
  executionWorkItemSchema,
  graphNodeV2Schema,
  harnessPlanV2Schema,
  humanWorkDecisionSchema,
  integrationContractsSchema,
  policyBundleSchema,
  policyEvaluationSchema,
  releaseManifestSchema,
  releaseRecordSchema,
  runtimeInvocationV2Schema,
  computeReleaseManifestDigest,
  stableDigest,
  parseHarnessPlan,
  PLAN_V1_REMOVED,
  verifyHarnessPlanDigest,
  verifyPlanV2Digest,
  verifyReleaseManifestDigest,
} from "./index.js";

describe("canonical contracts", () => {
  it("sorts object keys while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] })).toBe(
      '{"a":{"x":3,"y":2},"list":[2,1],"z":1}',
    );
  });

  it("keeps unconfigured capability placeholders in draft status", () => {
    const placeholder = {
      id: "identity.ocr.extract.v1",
      kind: "tool",
      effect: "read",
      adapterBindingId: "unconfigured:identity-ocr-extract",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      timeoutMs: 15_000,
      maxAttempts: 1,
      idempotent: true,
      description: "OCR placeholder",
      owner: "identity-platform",
      dataClasses: ["identity"],
      status: "draft",
    };
    expect(capabilityRegistrationSchema.parse(placeholder).status).toBe("draft");
    expect(() => capabilityRegistrationSchema.parse({ ...placeholder, status: "active" }))
      .toThrow("capability.active_binding_unconfigured");
  });

  it("orders keys by code unit rather than locale collation", () => {
    // localeCompare would emit _leading,a_b,aB,apple,Apple,Zebra here, which is not the
    // the UTF-8 byte order the plan compiler produces. The plan digest depends on this.
    expect(canonicalJson({ Zebra: 1, apple: 2, Apple: 3, a_b: 4, aB: 5, _leading: 6 })).toBe(
      '{"Apple":3,"Zebra":1,"_leading":6,"aB":5,"a_b":4,"apple":2}',
    );
  });

  it("re-verifies a plan digest produced by the plan compiler", () => {
    // Regenerate with: make fixtures
    // The fixture's schema property names are deliberately mixed-case and
    // underscore-bearing so any divergence between the two canonicalizations fails here
    // rather than silently rejecting a legitimately compiled plan at admission.
    const plan = harnessPlanV2Schema.parse(JSON.parse(
      readFileSync(new URL("../test-fixtures/conformance.plan.json", import.meta.url), "utf8"),
    ));
    expect(Object.keys(plan.schemas.input.properties as Record<string, unknown>)).toEqual([
      "VendorId", "Zebra", "apple", "taxId", "tax_id", "vendorName",
    ]);
    expect(verifyHarnessPlanDigest(plan)).toBe(true);
  });

  it("parses a compiled plan without coercing it", () => {
    // A plan must have exactly one canonical form. zod applies schema defaults during
    // parsing, so a compiler that omits a defaulted key produces a document whose digest
    // no longer matches the value every consumer actually works with -- and admission
    // then rejects a legitimately compiled plan. Parsing has to be a no-op.
    const document = JSON.parse(
      readFileSync(new URL("../test-fixtures/conformance.plan.json", import.meta.url), "utf8"),
    );
    expect(harnessPlanV2Schema.parse(document)).toEqual(document);
  });

  it("produces stable SHA-256 digests", () => {
    expect(stableDigest({ b: 2, a: 1 })).toBe(stableDigest({ a: 1, b: 2 }));
    expect(stableDigest({ list: [1, 2] })).not.toBe(stableDigest({ list: [2, 1] }));
  });

  it("validates the KYC case and command authority boundary", () => {
    const digest = "a".repeat(64);
    expect(createKycCaseRequestSchema.parse({
      tenantId: "tenant_demo",
      policySnapshotDigest: digest,
      harnessPlanDigest: digest,
      actor: { type: "HUMAN", principalId: "analyst@example.test", roles: ["KYC.Analyst"] },
    }).schemaVersion).toBe("kyc.case.v1");
    expect(businessCommandSchema.parse({
      commandId: "cmd_1",
      commandType: "AddSubject",
      commandVersion: "kyc.command.add_subject.v1",
      tenantId: "tenant_demo",
      caseId: "case_1",
      actor: { type: "HUMAN", principalId: "analyst@example.test", roles: ["KYC.Analyst"] },
      authority: { planDigest: digest, permissionEnvelopeDigest: digest, policySnapshotDigest: digest },
      payload: { subjectType: "individual" },
      preconditions: { caseSequence: 1 },
      idempotencyKey: "tenant_demo:case_1:add-subject:primary",
    }).commandType).toBe("AddSubject");
  });

  it("refuses removed v1 plans with a dedicated code", () => {
    const plan = JSON.parse(readFileSync(
      new URL("../test-fixtures/conformance.plan.json", import.meta.url),
      "utf8",
    ));
    expect(parseHarnessPlan(plan).apiVersion).toBe("harness.factory/plan-v2");
    const v1 = { ...plan, apiVersion: "harness.factory/plan-v1" };
    expect(() => parseHarnessPlan(v1)).toThrow(PLAN_V1_REMOVED);
    expect(harnessPlanV2Schema.safeParse(v1).success).toBe(false);
  });

  it("validates v2 plans and their runtime invocation envelope", () => {
    const digest = "a".repeat(64);
    const content = {
      apiVersion: "harness.factory/plan-v2" as const,
      kind: "HarnessPlan" as const,
      packageDigest: digest,
      compiler: {
        name: "harnessc" as const,
        version: "2.0.0",
        digest,
        compatibilityVersion: "4",
        lgirCoreRevision: "abcdef0",
      },
      metadata: { name: "contract-test", version: "2.0.0", domain: "test", objective: "Test v2" },
      execution: {
        engine: { kind: "harness-runtime" as const, adapterVersion: "harness-runtime-v2", profile: "production-v2" },
        coordinationMode: "caseStore" as const,
        maxTransitions: 100,
        maxConcurrency: 4,
        durability: "durable" as const,
      },
      budgets: { maxDurationMs: 60_000, maxCostUsd: 1, maxModelCalls: 2, maxCapabilityCalls: 4 },
      schemas: { input: { type: "object" }, output: { type: "object" }, schemaSetDigest: digest },
      modelProfiles: [],
      agentProfiles: [],
      capabilities: [],
      permissionEnvelopes: [],
      policyBundles: [{ policyId: "policy.test", bundleDigest: digest }],
      contextSelectors: [],
      contextClassificationPolicies: [],
      graph: {
        apiVersion: "ladder.dev/v1alpha1" as const,
        name: "test",
        nodes: [{ id: "input", kind: "input" as const, name: "Input", contextSelectorIds: [], config: {} }],
        edges: [],
        nodeOrder: ["input"],
      },
      releaseConstraints: { regions: ["US"], dataClasses: ["CONFIDENTIAL"], evaluationRequirementIds: ["contract"] },
      dependencyManifest: [{ kind: "policy", id: "policy.test", digest }],
      dependencyManifestDigest: digest,
      createdAt: "2026-09-19T12:00:00.000Z",
      buildProvenanceDigest: digest,
    };
    const plan = harnessPlanV2Schema.parse({
      ...content,
      planId: "plan_test_v2",
      planDigest: stableDigest(content),
    });
    expect(harnessPlanV2Schema.parse(plan).apiVersion).toBe("harness.factory/plan-v2");
    expect(verifyPlanV2Digest(plan)).toBe(true);
    expect(verifyHarnessPlanDigest(plan)).toBe(true);
    expect(runtimeInvocationV2Schema.parse({
      contractVersion: "runtime.invocation.v2",
      invocationId: "invocation_v2",
      runId: "run_v2",
      attempt: 1,
      workerId: "worker_1",
      leaseId: "lease_1",
      fencingEpoch: 1,
      deadlineAt: "2026-09-19T12:01:00.000Z",
      planDigest: plan.planDigest,
      executionProfileDigest: digest,
      executionGrant: "grant",
      plan,
      input: { caseId: "case_1" },
    }).contractVersion).toBe("runtime.invocation.v2");
  });

  it("validates bounded gate and fanout nodes", () => {
    expect(graphNodeV2Schema.parse({
      id: "gate",
      kind: "gate",
      name: "Policy gate",
      contextSelectorIds: ["case.decision"],
      config: { policyRef: "policy.kyc.v1", gateId: "disposition" },
    }).kind).toBe("gate");
    expect(graphNodeV2Schema.safeParse({
      id: "fanout",
      kind: "fanout",
      name: "Unbounded fanout",
      contextSelectorIds: [],
      config: { itemsPath: "$.subjects", bodyRef: "screen-subject", joinMode: "all" },
    }).success).toBe(false);
    expect(graphNodeV2Schema.parse({
      id: "fanout",
      kind: "fanout",
      name: "Bounded fanout",
      contextSelectorIds: [],
      config: {
        itemsPath: "$.subjects",
        bodyRef: "screen-subject",
        maxItems: 20,
        maxConcurrency: 4,
        joinMode: "allSettled",
      },
    }).kind).toBe("fanout");
  });

  it("validates policy bundles, snapshots, context, and reproducible evaluations", () => {
    const digest = "b".repeat(64);
    const bundle = {
      apiVersion: "harness.factory/policy-bundle-v1",
      kind: "PolicyBundle",
      bundleId: "bundle_1",
      policyId: "policy.kyc.us",
      policyVersion: "1.0.0",
      sourceDigest: digest,
      bundleDigest: digest,
      opaVersion: "1.9.0",
      regoModules: [{ path: "policy/kyc.rego", digest }],
      dataDigest: digest,
      gates: [{ gateId: "disposition", entrypoint: "data.harness.kyc.disposition", allowedOutcomes: ["ALLOW", "REVIEW", "BLOCK"] }],
      ruleIds: ["KYC-GATE-001"],
      testsDigest: digest,
      authority: { source: "POLICY_DB", casePath: "$.policyAuthority", requireSnapshotDigest: true },
    };
    expect(policyBundleSchema.parse(bundle).opaVersion).toBe("1.9.0");
    // Authority lives in the artifact registry, not in the artifact: a bundle that
    // still carries a detached signature is not a valid bundle.
    expect(policyBundleSchema.safeParse({ ...bundle, signature: { keyId: "k" } }).success).toBe(false);
    expect(artifactRegistryEntrySchema.parse({
      tenantId: "tenant_1", kind: "policy-bundle", digest, reference: "policy:kyc/3", status: "approved",
      registeredBy: "author", approvedBy: "approver", revokedBy: null, reasonCode: null,
      registeredAt: "2026-09-19T12:00:00.000Z", approvedAt: "2026-09-19T12:05:00.000Z", revokedAt: null,
    }).status).toBe("approved");
    expect(artifactRegistryEntrySchema.safeParse({ tenantId: "t", kind: "plan-signature", digest }).success).toBe(false);

    const snapshot = caseSnapshotSchema.parse({
      apiVersion: "harness.factory/case-snapshot-v1",
      kind: "CaseSnapshot",
      snapshotId: "snapshot_1",
      snapshotDigest: digest,
      tenantId: "tenant_1",
      caseId: "case_1",
      caseSequence: 42,
      dependencyDigest: digest,
      planDigest: digest,
      policyAuthority: {
        policyId: "policy.kyc.us",
        policyVersion: "1.0.0",
        policySnapshotDigest: digest,
        policyBundleDigest: digest,
      },
      consistency: "strong",
      classification: "CONFIDENTIAL",
      data: { evidence: [], findings: [] },
      capturedAt: "2026-09-19T12:00:00.000Z",
    });
    expect(snapshot.caseSequence).toBe(42);

    expect(contextManifestSchema.parse({
      apiVersion: "harness.factory/context-manifest-v1",
      kind: "ContextManifest",
      manifestId: "context_1",
      manifestDigest: digest,
      tenantId: "tenant_1",
      caseId: "case_1",
      workItemId: "work_1",
      caseSnapshotId: "snapshot_1",
      caseSnapshotDigest: digest,
      caseSequence: 42,
      purpose: "KYC_DISPOSITION",
      authorizationDecisionId: "authz_1",
      authorizationDecisionDigest: digest,
      items: [{
        itemId: "item_1",
        selector: "$.findings",
        schemaRef: "kyc.findings.v1",
        classification: "CONFIDENTIAL",
        trust: "UNTRUSTED_EXTERNAL",
        purpose: "KYC_DISPOSITION",
        provenanceRef: "evidence_1",
        contentRef: "blob://evidence_1",
        contentDigest: digest,
        expiresAt: null,
      }],
      createdAt: "2026-09-19T12:00:00.000Z",
      expiresAt: "2026-09-19T12:05:00.000Z",
    }).items[0]?.trust).toBe("UNTRUSTED_EXTERNAL");

    expect(policyEvaluationSchema.parse({
      apiVersion: "harness.factory/policy-evaluation-v1",
      kind: "PolicyEvaluation",
      evaluationId: "evaluation_1",
      tenantId: "tenant_1",
      caseId: "case_1",
      caseSequence: 42,
      caseSnapshotDigest: digest,
      dependencyDigest: digest,
      policyBundleDigest: digest,
      gateId: "disposition",
      inputDigest: digest,
      outcome: "UNKNOWN",
      ruleResults: [{ ruleId: "KYC-GATE-001", outcome: "UNKNOWN", reasonCode: "REQUIRED_FACT_MISSING", evidenceRefs: [] }],
      reasonCodes: ["REQUIRED_FACT_MISSING"],
      obligations: [{ code: "REQUEST_HUMAN_REVIEW", parameters: { priority: "HIGH" } }],
      evidenceRefs: [],
      evaluatedAt: "2026-09-19T12:00:00.000Z",
      receiptDigest: digest,
    }).outcome).toBe("UNKNOWN");
  });

  it("validates durable work and release lifecycle records", () => {
    const digest = "c".repeat(64);
    expect(executionWorkItemSchema.parse({
      apiVersion: "harness.factory/execution-work-item-v1",
      kind: "ExecutionWorkItem",
      tenantId: "tenant_1",
      caseId: "case_1",
      workItemId: "work_1",
      workType: "KYC_SCREENING",
      capabilityId: "screening.sanctions.search",
      assuranceClass: "HIGH",
      revision: 3,
      caseSequenceBasis: 42,
      planDigest: digest,
      policyContextRef: "policy_context_1",
      schemaVersion: "kyc.work.v1",
      objective: "Screen the subject",
      subjectRefs: ["subject_1"],
      requiredOutputs: ["kyc.screening.result.v1"],
      constraints: { region: "US" },
      dependencyIds: [],
      dependencyDigest: digest,
      invalidationPolicy: "REEVALUATE",
      status: "READY",
      reasonCode: null,
      priority: 100,
      readyAt: "2026-09-19T12:00:00.000Z",
      deadlineAt: null,
      terminalAt: null,
      dispatch: { generation: 1, queue: "kyc", publishedAt: null, brokerMessageId: null },
      lease: null,
      limits: { maxAttempts: 3, maxReworkCycles: 1, maxDurationMs: 60_000, maxCostUsd: 1, maxModelCalls: 2, maxCapabilityCalls: 5 },
      result: null,
      createdBy: { type: "SYSTEM", principalId: "execution-kernel", roles: [] },
      transitionSequence: 2,
      traceId: null,
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:01.000Z",
    }).status).toBe("READY");

    const manifest = releaseManifestSchema.parse({
      apiVersion: "harness.factory/release-manifest-v1",
      kind: "ReleaseManifest",
      releaseId: "release_1",
      manifestDigest: digest,
      planDigest: digest,
      packageDigest: digest,
      policyBundleDigests: [digest],
      schemaSetDigest: digest,
      agentDigests: [digest],
      skillDigests: [digest],
      capabilityDigests: [digest],
      modelProfileDigests: [digest],
      executionProfileDigest: digest,
      compilerDigest: digest,
      runtimeDigest: digest,
      dependencyManifestDigest: digest,
      evaluationAttestationDigest: digest,
      provenanceDigest: digest,
      scope: { environment: "production", tenants: ["tenant_1"], regions: ["US"], cohort: "low-risk-5pct" },
      createdAt: "2026-09-19T12:00:00.000Z",
    });
    expect(releaseRecordSchema.parse({
      releaseId: manifest.releaseId,
      manifestDigest: manifest.manifestDigest,
      status: "active",
      revision: 4,
      activatedAt: "2026-09-19T13:00:00.000Z",
      deprecatedAt: null,
      revokedAt: null,
      reasonCode: null,
      updatedAt: "2026-09-19T13:00:00.000Z",
    }).status).toBe("active");
  });

  it("validates immutable human work decisions", () => {
    expect(humanWorkDecisionSchema.parse({
      decisionId: "decision_1",
      tenantId: "tenant_1",
      caseId: "case_1",
      workItemId: "work_1",
      principalId: "reviewer@example.test",
      decision: "APPROVE",
      reasonCode: "KYC_REVIEW_COMPLETE",
      rationale: "Evidence and policy obligations verified.",
      evidenceRefs: ["evidence_1"],
      decidedAt: "2026-09-19T12:00:00.000Z",
    }).decision).toBe("APPROVE");
  });

  it("binds a release manifest digest to the unsigned immutable payload", () => {
    const digest = "a".repeat(64);
    const candidate = {
      apiVersion: "harness.factory/release-manifest-v1" as const,
      kind: "ReleaseManifest" as const,
      releaseId: "release_1",
      manifestDigest: digest,
      planDigest: digest,
      packageDigest: digest,
      policyBundleDigests: [digest],
      schemaSetDigest: digest,
      agentDigests: [digest],
      skillDigests: [digest],
      capabilityDigests: [digest],
      modelProfileDigests: [digest],
      executionProfileDigest: digest,
      compilerDigest: digest,
      runtimeDigest: digest,
      dependencyManifestDigest: digest,
      evaluationAttestationDigest: digest,
      provenanceDigest: digest,
      scope: { environment: "test", tenants: ["tenant_1"], regions: ["US"], cohort: "all" },
      createdAt: "2026-09-19T12:00:00.000Z",
    };
    candidate.manifestDigest = computeReleaseManifestDigest(candidate);
    expect(verifyReleaseManifestDigest(candidate)).toBe(true);
    expect(verifyReleaseManifestDigest({ ...candidate, runtimeDigest: "b".repeat(64) })).toBe(false);
  });

  it("defines the v2 domain package compatibility surface", () => {
    const digest = "d".repeat(64);
    expect(domainPackageV2Schema.parse({
      apiVersion: "harness.factory/domain-package-v2",
      kind: "DomainPackage",
      metadata: {
        name: "kyc-us",
        version: "2.0.0",
        domain: "kyc",
        objective: "Evaluate US KYC",
        owners: ["KYC Platform"],
        riskClass: "HIGH",
      },
      workflow: "workflow.yaml",
      coordinationMode: "caseStore",
      budgets: { maxDurationMs: 60_000, maxCostUsd: 1, maxModelCalls: 2, maxCapabilityCalls: 5 },
      modelProfiles: [],
      agentProfiles: [],
      capabilities: [],
      bindings: {},
      policies: [{ policyId: "policy.kyc.us", policyVersion: "1.0.0", source: "policies/kyc.yaml", digest }],
      contextSelectors: [{ id: "case.decision", source: "case", path: "$.decision", purpose: "KYC_DISPOSITION", classification: "CONFIDENTIAL", required: true }],
      contextClassificationPolicies: [{ classification: "CONFIDENTIAL", action: "mask", transform: { kind: "replace", replacement: "[REDACTED]" } }],
      allowedRegions: ["US"],
      dataClasses: ["CONFIDENTIAL"],
      evaluationRequirements: ["kyc-golden-v1"],
    }).coordinationMode).toBe("caseStore");
  });

  it("validates governed integration contracts and rejects direct trigger loops", () => {
    const valid = integrationContractsSchema.parse({
      triggers: [{ id: "case-created-run", name: "Start after creation", source: { kind: "internal_event", eventTypes: ["case.created"] },
        inputSchema: { type: "object", properties: {} }, target: { intent: "start_run" }, mapping: { caseId: "{{ event.data.caseId }}" },
        idempotencyPath: "$.id", maxHops: 4 }],
      humanActions: [{ id: "request-info", label: "Request information", description: "Return the case for more information.",
        commandType: "TransitionCaseStatus", inputSchema: { type: "object", properties: { rationale: { type: "string" } }, required: ["rationale"] },
        ui: { rationale: { control: "textarea" } }, payload: { rationale: "{{ input.rationale }}" }, allowedCaseStatuses: ["HUMAN_REVIEW"],
        allowedRoles: ["Case.Reviewer"], confirmation: "typed_reason", effect: "reversible" }],
      publications: [{ id: "case-events", eventTypes: ["case.created"], maximumClassification: "CONFIDENTIAL" }],
    });
    expect(valid.triggers[0]?.target.intent).toBe("start_run");
    expect(() => integrationContractsSchema.parse({ ...valid, triggers: [{ ...valid.triggers[0], target: { intent: "create_case" } }] })).toThrow(/integration.trigger_direct_cycle/);
    expect(() => integrationContractsSchema.parse({ ...valid, triggers: [{ ...valid.triggers[0], source: { kind: "internal_event", eventTypes: ["case.status_transitioned"] }, target: { intent: "submit_case_command", commandType: "TransitionCaseStatus" } }] })).toThrow(/integration.trigger_direct_cycle/);
    expect(() => integrationContractsSchema.parse({ ...valid, humanActions: [{ ...valid.humanActions[0], allowedRoles: ["Unknown.Role"] }] })).toThrow();
  });
});

describe("canonical capability naming and connector catalog", () => {
  it("accepts only versioned, provider-neutral capability IDs", () => {
    for (const id of ["screening.sanctions.v1", "screening.adverse_media.v1", "reference.identifier.lookup.v1", "model.kyc.case_assessment.v2"]) {
      expect(canonicalCapabilityIdSchema.safeParse(id).success).toBe(true);
    }
    for (const id of ["screening.sanctions", "sanctions.v1", "screening.adverse-media.search.v1", "Screening.pep.v1", "screening.pep.v1.0", "screening..pep.v1"]) {
      expect(canonicalCapabilityIdSchema.safeParse(id).success).toBe(false);
    }
  });

  const connector = {
    connectorId: "wiring:companies-house:business.registry.lookup",
    adapterId: "wiring",
    providerId: "companies-house",
    providerName: "Companies House",
    capabilityId: "business.registry.lookup.v1",
    operation: "business.registry.lookup",
    resultFamily: "business",
    status: "available",
    demoSupported: true,
    liveBlockers: ["vendor_credentials_missing"],
    source: { catalog: "data-adapters/api-wiring/vendor/atlas", revision: "abc123" },
  } as const;

  it("requires a connector ID prefixed by its adapter and a canonical capability", () => {
    expect(connectorRegistrationSchema.parse(connector).connectorId).toBe(connector.connectorId);
    expect(() => connectorRegistrationSchema.parse({ ...connector, adapterId: "opensanctions" })).toThrow(/connector.adapter_prefix_mismatch/);
    expect(() => connectorRegistrationSchema.parse({ ...connector, capabilityId: "registry.company.lookup" })).toThrow();
    expect(() => connectorRegistrationSchema.parse({ ...connector, status: "enabled" })).toThrow();
  });

  const capability = {
    capabilityId: "business.registry.lookup.v1", atlasCapability: "business.registry.lookup", resultFamily: "business",
    kind: "tool", effect: "read", description: "Registry lookup.", dataClasses: ["pii"], defaultConnectorId: connector.connectorId,
  } as const;
  const catalog = {
    apiVersion: "harness.factory/connector-catalog-v1",
    generatedFrom: { catalog: "data-adapters/api-wiring/vendor/atlas", revision: "abc123" },
    capabilities: [capability],
    connectors: [connector],
  };

  it("rejects a catalog whose default connector serves another capability or is quarantined", () => {
    expect(connectorCatalogSchema.parse(catalog).connectors).toHaveLength(1);
    expect(() => connectorCatalogSchema.parse({ ...catalog, connectors: [{ ...connector, status: "quarantined" }] }))
      .toThrow(/connector_catalog.default_connector_unusable/);
    expect(() => connectorCatalogSchema.parse({ ...catalog, capabilities: [{ ...capability, defaultConnectorId: "opensanctions:sanctions" }] }))
      .toThrow(/connector_catalog.default_connector_invalid/);
    expect(() => connectorCatalogSchema.parse({ ...catalog, connectors: [connector, connector] }))
      .toThrow(/connector_catalog.connector_duplicate/);
    expect(() => connectorCatalogSchema.parse({ ...catalog, connectors: [{ ...connector, capabilityId: "business.verify.v1" }] }))
      .toThrow(/connector_catalog.capability_unknown/);
  });

  it("validates the committed connector catalog", () => {
    const committed = connectorCatalogSchema.parse(JSON.parse(readFileSync(new URL("../../../config/connector-catalog.json", import.meta.url), "utf8")));
    const defaults = Object.fromEntries(committed.capabilities.map((item) => [item.capabilityId, item.defaultConnectorId]));
    expect(defaults["screening.sanctions.v1"]).toBe("opensanctions:sanctions");
    expect(defaults["screening.pep.v1"]).toBe("opensanctions:pep");
    expect(defaults["investigation.web.search.v1"]).toBe("simulator:investigation.web.search");
    expect(committed.connectors.some((item) => item.connectorId.startsWith("agents:"))).toBe(false);
    expect(committed.connectors.filter((item) => item.adapterId === "wiring")).toHaveLength(824);
    expect(committed.connectors.filter((item) => item.status === "quarantined")).toHaveLength(2);
  });

  it("carries the v2 canonical model and refuses corrected defaults, wrong families and bad substitution references", () => {
    const canonicalCapability = {
      capabilityPath: "business.registry", modelVersion: "2.0.0", definitionVersion: "1.0.0", status: "proposed", kind: "intelligence",
      jurisdictionBasis: "registry_authority", requiredScopeFields: ["registry_namespace"], subjectTypes: ["organization"], defaultAction: "lookup",
      resultFamily: "business", legacyCapability: "business.registry.lookup", notSubstitutableFor: [],
    } as const;
    const canonicalConnector = {
      legacyBindingId: "companies-house:business.registry.lookup", bindingIds: ["binding:companies-house:business.registry.intelligence.gb:v1"],
      capabilityIds: ["business.registry.intelligence.gb"], capabilityPaths: ["business.registry"], jurisdictions: ["gb"],
      migration: "vocabulary_mapping", runtimeDisposition: "alias_pending_approval",
    } as const;
    const v2 = { ...catalog, capabilities: [{ ...capability, canonical: canonicalCapability }], connectors: [{ ...connector, canonical: canonicalConnector }] };
    expect(connectorCatalogSchema.parse(v2).connectors[0]!.canonical?.capabilityIds).toEqual(["business.registry.intelligence.gb"]);
    expect(connectorCatalogSchema.parse(catalog).capabilities[0]!.canonical).toBeNull();
    expect(() => connectorCatalogSchema.parse({ ...v2, connectors: [{ ...connector, canonical: { ...canonicalConnector, runtimeDisposition: "migration_required", migration: "semantic_correction" } }] }))
      .toThrow(/connector_catalog.default_connector_unusable/);
    expect(() => connectorCatalogSchema.parse({ ...v2, connectors: [{ ...connector, canonical: { ...canonicalConnector, capabilityPaths: ["business.ownership"], capabilityIds: ["business.ownership.intelligence.gb"] } }] }))
      .toThrow(/connector_catalog.canonical_family_mismatch/);
    expect(() => connectorCatalogSchema.parse({ ...v2, capabilities: [{ ...capability, canonical: { ...canonicalCapability, notSubstitutableFor: ["business.verify.v1"] } }] }))
      .toThrow(/connector_catalog.substitution_reference_invalid/);
    expect(() => connectorRegistrationSchema.parse({ ...connector, canonical: { ...canonicalConnector, capabilityIds: ["business.registry.v1"] } })).toThrow();

    const committed = connectorCatalogSchema.parse(JSON.parse(readFileSync(new URL("../../../config/connector-catalog.json", import.meta.url), "utf8")));
    const byId = new Map(committed.capabilities.map((item) => [item.capabilityId, item]));
    expect(committed.capabilities.filter((item) => item.canonical)).toHaveLength(56);
    expect(byId.get("account.profile.v1")?.canonical?.notSubstitutableFor).toEqual(["account.ownership.verify.v1"]);
    expect(byId.get("screening.watchlist.v1")?.canonical?.notSubstitutableFor).toContain("screening.sanctions.v1");
    expect(byId.get("business.verify.v1")?.canonical?.capabilityPath).toBe("business.verification");
    const wiring = committed.connectors.filter((item) => item.adapterId === "wiring");
    expect(wiring.every((item) => item.canonical)).toBe(true);
    expect(wiring.filter((item) => item.canonical?.runtimeDisposition === "migration_required")).toHaveLength(13);
    expect(committed.connectors.find((item) => item.connectorId === "wiring:fincen-boi:business.registry.lookup")?.canonical?.capabilityIds)
      .toEqual(["business.ownership.intelligence.us"]);
    expect(committed.generatedFrom.canonicalModelVersion).toBe("2.0.0");
  });

  it("validates connector templates and lists the cloud templates in the committed catalog", () => {
    const template = {
      adapterId: "databricks-vector", cloud: "databricks", bindingPattern: "^[a-z_]+$",
      capabilityIds: ["business.registry.lookup.v1"], configEnv: ["DATABRICKS_HOST"], description: "Index.",
    } as const;
    expect(connectorCatalogSchema.parse(catalog).connectorTemplates).toEqual([]);
    expect(connectorCatalogSchema.parse({ ...catalog, connectorTemplates: [template] }).connectorTemplates).toHaveLength(1);
    expect(() => connectorCatalogSchema.parse({ ...catalog, connectorTemplates: [template, template] })).toThrow(/connector_catalog.template_duplicate/);
    expect(() => connectorCatalogSchema.parse({ ...catalog, connectorTemplates: [{ ...template, capabilityIds: ["knowledge.vector.search.v1"] }] }))
      .toThrow(/connector_catalog.capability_unknown/);
    expect(() => connectorCatalogSchema.parse({ ...catalog, connectorTemplates: [{ ...template, bindingPattern: "[a-z]+" }] })).toThrow(/binding_pattern_invalid/);
    expect(() => connectorCatalogSchema.parse({ ...catalog, connectorTemplates: [{ ...template, configEnv: ["secret=value"] }] })).toThrow();

    const committed = connectorCatalogSchema.parse(JSON.parse(readFileSync(new URL("../../../config/connector-catalog.json", import.meta.url), "utf8")));
    const served = Object.fromEntries(committed.connectorTemplates.map((item) => [item.adapterId, item.capabilityIds]));
    expect(served).toEqual({
      "context-postgres": ["context.records.fetch.v1"],
      "context-salesforce": ["context.records.fetch.v1"],
      "context-fenergo": ["context.records.fetch.v1"],
      "context-documents": ["context.documents.citation.v1", "context.documents.search.v1"],
      "context-source": ["context.source.read.v1"],
      "databricks-serving": ["model.general.inference.v1"],
      "databricks-uc": ["function.uc.invoke.v1"],
      "databricks-vector": ["knowledge.vector.search.v1"],
      decisions: ["decision.document.advisory.v1"],
      "foundry-agent": ["foundry.agent.prompt.v1"],
      "http-operation": ["integration.http.operation.v1"],
      skills: ["skill.business.execute.v1"],
    });
    expect(committed.capabilities.find((item) => item.capabilityId === "function.uc.invoke.v1")).toMatchObject({ kind: "tool", defaultConnectorId: null });
  });
});
