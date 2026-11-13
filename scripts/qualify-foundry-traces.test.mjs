import { strict as assert } from "node:assert";
import { test } from "node:test";
import { qualify } from "./qualify-foundry-traces.mjs";

const scope = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/ehf/providers/";
const instant = Date.parse("2026-11-12T20:32:00.000Z");
const input = {
  tenantId: "tenant_demo",
  projectEndpoint: "https://foundry-example.services.ai.azure.com/api/projects/test",
  agentName: "probe",
  agentVersion: "1",
  applicationInsightsResourceId: scope + "Microsoft.Insights/components/foundry",
  workspaceResourceId: scope + "Microsoft.OperationalInsights/workspaces/foundry",
  workspaceTransformationResourceId: scope + "Microsoft.Insights/dataCollectionRules/scrub",
  workspaceTransformationEtag: '"etag"',
  queryIdentityId: scope + "Microsoft.ManagedIdentity/userAssignedIdentities/trace-reader",
  queryIdentityClientId: "22222222-2222-4222-8222-222222222222",
  traceId: "a".repeat(32),
  responseId: "resp_synthetic",
  sampleStartedAt: "2026-11-12T20:31:00.000Z",
  parentSpanId: "b".repeat(16),
  sentinel: "ehf-synthetic-" + "c".repeat(24),
  unrelatedApplicationInsightsResourceId: scope + "Microsoft.Insights/components/other",
};
const success = (markers) => new Response(JSON.stringify({
  tables: [{ columns: ["Spans", "Anchors", "InlineMarkers"].map(name => ({ name })), rows: [[2, 1, markers]] }],
}));

test("qualification requires an exact native anchor, no inline content, and both Azure denials", async () => {
  const observed = [];
  const result = await qualify(input, () => "private-token", async (url, options) => {
    const { query } = JSON.parse(options.body);
    observed.push({ url, query });
    return query.includes("summarize") ? success(0) : new Response(null, { status: 403 });
  }, () => instant);
  assert.equal(result.queryIdentityClientId, input.queryIdentityClientId);
  assert.equal(result.protectedContentDenied, true);
  assert.equal(observed.length, 3);
  assert.match(observed[0].query, /resp_synthetic/);
  assert.equal(observed[1].query, "genAIContent | take 1 | count");
  assert.match(observed[2].url, /components\/other\/query$/);
});

test("qualification refuses inline content and successful protected reads", async () => {
  await assert.rejects(qualify(input, () => "", async () => success(1), () => instant), /inline|ordinary dependency/);
  await assert.rejects(qualify(input, () => "", async (_url, options) =>
    JSON.parse(options.body).query.includes("summarize") ? success(0) : new Response(null, { status: 200 }),
  () => instant), /not explicitly denied/);
});

test("Azure's successful empty result must include scoped protected-table denial metadata", async () => {
  const run = (denyScope) => qualify(input, () => "token", async (url, options) => {
    const { query } = JSON.parse(options.body);
    if (query.includes("summarize")) return success(0);
    if (url.includes("/components/other/")) return new Response(null, { status: 403 });
    assert.match(options.headers.prefer, /include-permissions=true/);
    return Response.json({
      tables: [{ columns: [{ name: "Count" }], rows: [[0]] }],
      permissions: { workspaces: [{ resourceId: denyScope, denyTables: ["AppGenAIContent"] }] },
    });
  }, () => instant);
  assert.equal((await run(input.workspaceResourceId)).protectedContentDenied, true);
  await assert.rejects(run(input.workspaceResourceId + "-other"), /not explicitly denied/);
});
