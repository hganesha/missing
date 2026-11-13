import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setup } from "./test-support.js";

const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());
beforeEach(() => { env.at("ownership_review"); env.as("agent_architect"); });
afterEach(() => expect(env.state.violations).toEqual([]));

const getDraft = async () => (await env.call("getAuthoringDraftsDraftId")).body;
const mutate = (revision: number, mutation: unknown) => env.call("postAuthoringDraftsDraftIdGraph", { body: { expectedRevision: revision, mutation } });

describe("contextual workflow authoring", () => {
  it("persists a revision-checked process title and refuses stale overwrites",async()=>{
    const draft=await getDraft();
    const mutation={type:"rename-process",name:"Customer onboarding"};
    const saved=await mutate(draft.revision,mutation);
    expect(saved.status).toBe(200);
    expect(saved.body.draft.name).toBe("Customer onboarding");
    expect(saved.body.draft.parsedWorkflow.metadata.title).toBe("Customer onboarding");
    expect((await mutate(draft.revision,{...mutation,name:"Old revision"})).status).toBe(409);
    expect((await getDraft()).name).toBe("Customer onboarding");
  });
  it("inserts once on the selected conditional edge and keeps its sibling branch", async () => {
    const draft = await getDraft();
    const workflow = structuredClone(draft.parsedWorkflow);
    const selected = workflow.spec.edges[0];
    selected.condition = "review_needed";
    const sibling = { id: "other-branch", from: selected.from, to: workflow.spec.nodes.at(-1).id, kind: "control", condition: "skip_review" };
    workflow.spec.edges.push(sibling);
    const saved = await env.call("putAuthoringDraftsDraftId", { body: { expectedRevision: draft.revision, packageSource: draft.packageSource, workflowSource: JSON.stringify(workflow) } });
    const response = await mutate(saved.body.revision, { type: "insert-on-edge", edgeId: selected.id, node: { id: "manual-check", kind: "approval", name: "Manual check", description: "Check the source" } });
    expect(response.status).toBe(200);
    expect(response.body.draft.revision).toBe(saved.body.revision + 1);
    expect(response.body.draft.parsedWorkflow.spec.edges).toContainEqual({ ...selected, to: "manual-check" });
    expect(response.body.draft.parsedWorkflow.spec.edges).toContainEqual(sibling);
    expect(response.body.draft.parsedWorkflow.spec.edges).toContainEqual(expect.objectContaining({ from: "manual-check", to: selected.to }));
  });

  it("retains edits on a stale revision failure and only applies an explicit retry", async () => {
    const draft = await getDraft();
    const nodeId = draft.parsedWorkflow.spec.nodes[0].id;
    const edit = { type: "update-node", nodeId, name: "Other author", description: "First edit" };
    expect((await mutate(draft.revision, edit)).status).toBe(200);
    expect((await mutate(draft.revision, { ...edit, name: "My edit" })).status).toBe(409);
    expect((await getDraft()).parsedWorkflow.spec.nodes[0].name).toBe("Other author");
    expect((await mutate(draft.revision + 1, { ...edit, name: "My edit" })).status).toBe(200);
    expect((await getDraft()).parsedWorkflow.spec.nodes[0].name).toBe("My edit");
  });

  it("rolls back a rejected insertion and invalid batched layout", async () => {
    const draft = await getDraft();
    const badEdge = await mutate(draft.revision, { type: "insert-on-edge", edgeId: "missing", node: { id: "new-step", kind: "approval", name: "Review" } });
    expect(badEdge.status).toBe(400);
    expect(badEdge.body.error).toBe("authoring.edge_not_found");
    const positions = [{ nodeId: draft.parsedWorkflow.spec.nodes[0].id, position: { x: 0, y: 0 } }, { nodeId: "missing", position: { x: 10, y: 10 } }];
    expect((await mutate(draft.revision, { type: "layout", positions })).status).toBe(400);
    expect(await getDraft()).toEqual(draft);
  });

  it.each([{ type: "unknown" }, { type: "layout", positions: [] }, { type: "update-node", nodeId: "intake", name: "New name" }])("rejects an invalid mutation without changing the draft", async mutation => {
    const draft = await getDraft();
    expect((await mutate(draft.revision, mutation)).body.error).toBe("authoring.graph_mutation_invalid");
    expect(await getDraft()).toEqual(draft);
  });

  it("enforces draft.write and published immutability", async () => {
    const draft = await getDraft();
    const mutation = { type: "update-node", nodeId: draft.parsedWorkflow.spec.nodes[0].id, name: "Changed", description: "" };
    env.as("harness_approver");
    expect((await mutate(draft.revision, mutation)).status).toBe(403);
    env.as("agent_architect");
    env.state.platform.drafts[0].status = "PUBLISHED";
    expect((await mutate(draft.revision, mutation)).status).toBe(409);
  });
});
