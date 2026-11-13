import { describe, expect, it } from "vitest";
import { defaultDeploymentProfile, type SetupDocument } from "./deployment.js";
import { createDeploymentPlan } from "./deployment-plan.js";

const catalog = { revision: "curated-1", models: [{ id: "approved", name: "Approved", publisher: "Publisher", family: "frontier" as const, providers: { openrouter: "publisher/wire-model" } }] };
const document = (): SetupDocument => ({ revision: 2, phase: "draft", updatedAt: "2026-11-08T00:00:00Z", tests: [], profile: defaultDeploymentProfile({ provider: "azure", region: "centralus", scopeId: "resource-group", recipe: "azure-container-apps-bootstrap-v1" }) });
describe("cloud-neutral runtime planning", () => {
  it("describes ADLS container retention without promising per-file WORM controls", () => {
    const doc = document(); doc.profile.foundation.objectStore = { provider: "adls_gen2", endpoint: "https://testaccount.dfs.core.windows.net", bucket: "evidence", credentialRef: "env:ADLS_CREDENTIAL" };
    const plan = createDeploymentPlan({ document: doc, catalog, identityVerified: false, image: null });
    expect(plan.resources.find(resource => resource.id === "objects")).toMatchObject({ service: "Azure Data Lake Storage Gen2", detail: expect.stringContaining("entire filesystem") });
    expect(plan.gates.find(gate => gate.id === "object-storage")?.message).toContain("Per-file policy changes are not supported");
  });
  it("includes document endpoint references without claiming document processing is qualified", () => {
    const doc = document(); doc.profile.intelligence.documentIntelligence = { endpoint: "https://documents.example.com", credentialRef: "env:DOCUMENT_TOKEN" };
    const plan = createDeploymentPlan({ document: doc, catalog, identityVerified: true, image: null, deploymentVerified: true });
    expect(plan.documentIntelligence).toEqual({ adapter: "evidence", endpoint: "https://documents.example.com", credentialRef: "env:DOCUMENT_TOKEN", state: "configured", qualified: false });
    expect(plan.resources.find(resource => resource.id === "document-intelligence")?.operation).toBe("bind");
  });
  it("keeps one image, seven distinct service principals and three isolated stores without inventing connector identities", () => {
    const doc = document();
    const plan = createDeploymentPlan({ document: doc, catalog, identityVerified: false, image: null });
    expect(new Set(plan.services.map(service => service.identity)).size).toBe(7);
    expect(plan.services.find(service => service.entrypoint === "runtime-host")?.databases).toEqual([]);
    expect(plan.database.stores.find(store => store.id === "case")?.extensions).toEqual(["vector"]);
    expect(plan.database.stores.find(store => store.id === "context")?.extensions).toEqual(["vector", "age"]);
    expect(plan.runtimeReady).toBe(false);
    expect(plan.resources.every(resource => resource.count > 0 && resource.service.length > 0 && resource.detail.length > 0)).toBe(true);
    expect(plan.gates.find(gate => gate.id === "image")?.passed).toBe(false);
  });
  it("changes hosting vocabulary without changing application identities or mechanisms", () => {
    const doc = document();
    const azure = createDeploymentPlan({ document: doc, catalog, identityVerified: false, image: null });
    doc.profile.target.provider = "aws";
    const aws = createDeploymentPlan({ document: doc, catalog, identityVerified: false, image: null });
    expect(aws.services).toEqual(azure.services);
    expect(aws.resources[0]?.service).toBe("ECS / Fargate");
  });
  it("removes the hosted runtime replica when an existing endpoint is selected", () => {
    const doc = document(); doc.profile.intelligence.runtimeEndpoint = "https://runtime.example.com";
    const plan = createDeploymentPlan({ document: doc, catalog, identityVerified: false, image: null });
    expect(plan.resources.find(resource => resource.id === "runtime")?.count).toBe(6);
    expect(plan.services.find(service => service.entrypoint === "runtime-host")).toMatchObject({ replicas: 0, operation: "bind-external", identity: "harness-runtime" });
  });
  it("binds curated wire IDs, invalidates qualification after catalog or profile changes, and never treats health as deployment", () => {
    const doc = document(); doc.profile.intelligence.models.low = "approved";
    doc.tests = [{ kind: "inference", catalogRevision: catalog.revision, revision: 2, checkedAt: doc.updatedAt, status: "passed", message: "qualified" }, { kind: "runtime", revision: 2, checkedAt: doc.updatedAt, status: "passed", message: "healthy" }];
    const input = { document: doc, catalog, identityVerified: true, image: `registry/app@sha256:${"a".repeat(64)}` };
    expect(createDeploymentPlan(input).modelBindings[0]?.model).toBe("publisher/wire-model");
    expect(createDeploymentPlan(input).gates.find(gate => gate.id === "inference")?.passed).toBe(true);
    expect(createDeploymentPlan({ ...input, catalog: { ...catalog, revision: "curated-2" } }).gates.find(gate => gate.id === "inference")?.passed).toBe(false);
    doc.revision++;
    expect(createDeploymentPlan(input).gates.find(gate => gate.id === "inference")?.passed).toBe(false);
    expect(createDeploymentPlan(input).gates.find(gate => gate.id === "runtime")?.passed).toBe(false);
  });
});
