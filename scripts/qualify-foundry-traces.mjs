// Run using the exact deployed query managed identity and a fresh synthetic prompt-agent trace.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { foundryTraceQualificationSchema } from "../packages/contracts/src/deployment.ts";

const PROOF_VERSION = "integralflow/foundry-trace-qualification-v1";
const LOGS_RESOURCE = "https://api.loganalytics.io";

function verify(condition, reason) {
  if (!condition) throw new Error(reason);
}

function managedIdentityToken(input) {
  const token = execFileSync("az", ["account", "get-access-token", "--resource", LOGS_RESOURCE, "--query", "accessToken", "-o", "tsv", "--only-show-errors"], { encoding: "utf8" }).trim();
  const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  const clientId = claims.appid ?? claims.azp;
  verify(typeof clientId === "string" && clientId.toLowerCase() === input.queryIdentityClientId.toLowerCase() &&
    typeof claims.xms_mirid === "string" && claims.xms_mirid.toLowerCase() === input.queryIdentityId.toLowerCase(),
    "The Azure CLI session must use the exact query managed identity.");
  return token;
}

async function query(resourceId, token, timespan, kql, transport, permissions = false) {
  const path = resourceId.split("/").map(encodeURIComponent).join("/");
  return transport(`https://api.loganalytics.azure.com/v1${path}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", prefer: permissions ? "wait=10, include-permissions=true" : "wait=10" },
    body: JSON.stringify({ query: kql, timespan }), redirect: "error", signal: AbortSignal.timeout(15_000),
  });
}

function countRow(body) {
  const [table] = body.tables ?? [];
  verify(!body.error && body.tables?.length === 1 && table.rows?.length === 1 &&
    table.columns?.length === 3 && table.rows[0]?.length === 3,
    "The allowed span query returned an invalid or partial result.");
  const record = Object.fromEntries(table.columns.map((column, index) => [column.name, table.rows[0][index]]));
  verify(Number.isInteger(record.Spans) && record.Spans > 0 && record.Anchors === 1,
    "The expected synthetic invocation and its W3C parent were not visible.");
  verify(record.InlineMarkers === 0, "Synthetic content was visible in ordinary dependency fields.");
}

async function accessDenied(response) {
  const denied = response.status === 403;
  await response.body?.cancel();
  return denied;
}

async function protectedContentDenied(response, proof) {
  if (!response.ok) return accessDenied(response);
  const body = await response.json().catch(() => null);
  if (!body) return false;
  const [table] = body.tables ?? [];
  const empty = !body.error && body.tables?.length === 1 &&
    table.columns?.length === 1 && table.columns[0]?.name === "Count" &&
    table.rows?.length === 1 && table.rows[0]?.[0] === 0;
  const deniedAt = (entries, scope) => Array.isArray(entries) && entries.some(entry =>
    typeof entry?.resourceId === "string" && entry.resourceId.toLowerCase() === scope.toLowerCase() &&
    Array.isArray(entry.denyTables) && entry.denyTables.some(name =>
      typeof name === "string" && ["appgenaicontent", "genaicontent"].includes(name.toLowerCase())));
  return empty && (deniedAt(body.permissions?.resources, proof.applicationInsightsResourceId) ||
    deniedAt(body.permissions?.workspaces, proof.workspaceResourceId) ||
    deniedAt(body.permissions?.dataSources, proof.workspaceResourceId));
}

export async function qualify(input, tokenFor = managedIdentityToken, transport = fetch, now = Date.now) {
  const { sampleStartedAt, parentSpanId, sentinel, ...binding } = input;
  const time = now();
  const checkedAt = new Date(time).toISOString();
  const expiresAt = new Date(time + 14 * 86_400_000).toISOString();
  // Parse the binding before any token acquisition or query. The literals below are emitted
  // only after all checks pass. The private deployment executor rechecks ARM state.
  const proof = foundryTraceQualificationSchema.parse({
    ...binding, apiVersion: PROOF_VERSION, checkedAt, expiresAt,
    contentProbePassed: true, protectedContentDenied: true, unrelatedComponentDenied: true,
  });
  const unrelated = proof.unrelatedApplicationInsightsResourceId;
  verify(unrelated.toLowerCase() !== proof.applicationInsightsResourceId.toLowerCase(), "Use a separate existing component for the negative access check.");
  verify(typeof parentSpanId === "string" && /^(?!0{16}$)[a-f0-9]{16}$/.test(parentSpanId), "A valid outbound parent span ID is required.");
  verify(typeof sentinel === "string" && /^ehf-synthetic-[a-f0-9]{24,64}$/.test(sentinel), "Use a random synthetic content marker.");
  const sample = Date.parse(sampleStartedAt);
  verify(Number.isFinite(sample) && time > sample && time - sample <= 15 * 60_000, "The synthetic trace must be from the last fifteen minutes.");
  const timespan = `${new Date(sample - 60_000).toISOString()}/${checkedAt}`;
  const token = tokenFor(proof);
  const result = await query(proof.applicationInsightsResourceId, token, timespan, `
    dependencies
    | where operation_Id == "${proof.traceId}"
    | summarize Spans=count(),
      Anchors=countif(operation_ParentId == "${parentSpanId}" and name == "invoke_agent ${proof.agentName}:${proof.agentVersion}"
        and tostring(customDimensions["gen_ai.response.id"]) == "${proof.responseId}"),
      InlineMarkers=countif(tostring(pack_all()) contains "${sentinel}")`, transport);
  verify(result.ok, "The reader managed identity could not query native Foundry spans.");
  countRow(await result.json());
  const [protectedContent, unrelatedComponent] = await Promise.all([
    query(proof.applicationInsightsResourceId, token, timespan, "genAIContent | take 1 | count", transport, true),
    query(unrelated, token, timespan, "dependencies | take 0", transport),
  ]);
  const [contentDenied, unrelatedDenied] = await Promise.all([protectedContentDenied(protectedContent, proof), accessDenied(unrelatedComponent)]);
  verify(contentDenied, "The protected-content query was not explicitly denied.");
  verify(unrelatedDenied, "The unrelated-component query was not explicitly denied.");
  return proof;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node --import tsx scripts/qualify-foundry-traces.mjs <private-test-input.json>");
    const proof = await qualify(JSON.parse(readFileSync(process.argv[2], "utf8")));
    process.stdout.write(JSON.stringify(proof, null, 2) + "\n");
  } catch (error) {
    const message = error instanceof Error && error.name === "Error" ? error.message : "Invalid qualification inputs.";
    console.error(message.startsWith("Command failed") ? "Could not obtain the query identity token." : message);
    process.exitCode = 1;
  }
}
