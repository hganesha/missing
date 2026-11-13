import { INTELLIGENCE_ADAPTER_CATALOG, intelligenceAdapterImplemented, intelligenceConfigurationChecks, intelligenceSaveSchema, intelligenceCheckRequestSchema } from "@ehf/contracts/intelligence";
import type { Schemas } from "@ehf/ui-contracts";
import { clone } from "../fixtures.js";
import { fail, ok, stableJson, type Ctx, type Impl } from "../http.js";
import { ensureAdminSeeds } from "./platform.js";

function store(ctx: Ctx) {
  const key = `${ctx.session.tenant.tenantId}:${ctx.session.environment.name}`;
  if (!ctx.state.intelligence.has(key)) ctx.state.intelligence.set(key, { candidates: [], history: [], reports: [], activity: [] });
  return ctx.state.intelligence.get(key)!;
}
export const intelligence: Record<string, Impl> = {
  getIntelligence: ctx => {
    ensureAdminSeeds(ctx);
    const runtime = (ctx.state.platform.settings as Array<{ section: string; value: Record<string, any>; source: string; deploymentManaged: boolean }>).find(section => section.section === "runtime");
    const bindings = Object.entries(runtime?.value.bindings ?? {}).map(([id, value]) => {
      const binding = value as Record<string, string>;
      return { id, target: `${binding.adapter}:${id}`, adapterId: binding.adapter!, endpoint: binding.endpoint ?? null, auth: binding.auth ?? "environment", source: runtime?.source ?? "default", deploymentManaged: Boolean(runtime?.deploymentManaged) };
    });
    const target = String(runtime?.value.provider ?? "local_http");
    const adapterId = target.split(":")[0]!;
    if (!bindings.some(binding => binding.target === target)) bindings.unshift({ id: "environment-default", target, adapterId, endpoint: adapterId === "local_http" ? runtime?.value.localEndpoint ?? null : null, auth: adapterId === "databricks" ? "databricks_oauth_m2m" : "platform_token", source: runtime?.source ?? "default", deploymentManaged: Boolean(runtime?.deploymentManaged) });
    const body: Schemas["IntelligenceIndex"] = { ...clone(store(ctx)), environment: String(ctx.session.environment.name), generatedAt: ctx.state.clock,
      profiles: clone(ctx.state.platform.modelProfiles), providers: clone(ctx.state.platform.providers), runtimes: bindings,
      adapters: INTELLIGENCE_ADAPTER_CATALOG.map(adapter => ({ ...adapter })), gatewayAvailable: !ctx.state.faults.upstreamDown.includes("capability-gateway"),
      gatewayAdapters: ["openrouter", "simulator"], consumerInventoryAvailable: false,
    };
    return ok(ctx, body);
  },
  postIntelligenceCandidates: async ctx => {
    const parsed = intelligenceSaveSchema.safeParse(ctx.body);
    if (!parsed.success) return fail(ctx, 400, "intelligence.invalid_configuration", "Check the configuration, credential references and numeric limits.");
    ensureAdminSeeds(ctx);
    const { definition, expectedRevision, reason } = parsed.data;
    if (definition.serviceClass === "reasoning" && definition.configuration.profileId && !(ctx.state.platform.modelProfiles as Schemas["AdminModelProfileView"][]).some(profile => profile.profile.id === definition.configuration.profileId)) return fail(ctx, 400, "intelligence.profile_not_found", "Choose a profile from this environment.");
    const state = store(ctx);
    const previous = state.candidates.find(candidate => candidate.definition.id === definition.id);
    if (expectedRevision === null ? Boolean(previous) : previous?.revision !== expectedRevision) return fail(ctx, 409, "intelligence.revision_conflict", "This proposal changed. Close the editor and reopen its latest revision; your edits have not been saved.");
    const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(definition)));
    // Re-check after async hashing so competing creates cannot both succeed.
    if (state.candidates.find(row => row.definition.id === definition.id)?.revision !== previous?.revision) return fail(ctx, 409, "intelligence.revision_conflict", "This proposal changed while saving.");
    const record: Schemas["IntelligenceRecord"] = { definition: clone(definition), revision: (expectedRevision ?? 0) + 1, digest: Array.from(new Uint8Array(digestBytes), byte => byte.toString(16).padStart(2, "0")).join(""), createdAt: ctx.state.clock, createdBy: ctx.subject, reason };
    state.candidates = [...state.candidates.filter(candidate => candidate.definition.id !== definition.id), record];
    state.history.unshift(record);
    state.activity.unshift({ bindingId: definition.id, revision: record.revision, action: previous ? "candidate.revised" : "candidate.created", actor: ctx.subject, at: ctx.state.clock, reason });
    return ok(ctx, record);
  },
  postIntelligenceBindingsBindingIdChecks: ctx => {
    const parsed = intelligenceCheckRequestSchema.safeParse(ctx.body);
    if (!parsed.success) return fail(ctx, 400, "intelligence.invalid_configuration", "An expected revision is required.");
    const state = store(ctx);
    const candidate = state.candidates.find(row => row.definition.id === ctx.params.bindingId);
    if (!candidate) return fail(ctx, 404, "intelligence.not_found", "This binding proposal was not found.");
    if (candidate.revision !== parsed.data.expectedRevision) return fail(ctx, 409, "intelligence.revision_conflict", "Reload the current proposal before checking it.");
    const definition = intelligenceSaveSchema.shape.definition.parse(candidate.definition);
    const report: Schemas["IntelligenceCheckReport"] = { bindingId: definition.id, revision: candidate.revision, digest: candidate.digest, checkedAt: ctx.state.clock, checkedBy: ctx.subject,
      checks: intelligenceConfigurationChecks(definition, intelligenceAdapterImplemented(definition)), executionVerified: false };
    state.reports = [...state.reports.filter(row => row.bindingId !== definition.id), report];
    state.activity.unshift({ bindingId: definition.id, revision: candidate.revision, action: "configuration.checked", actor: ctx.subject, at: ctx.state.clock, reason: "Offline configuration checks; execution remains unverified" });
    return ok(ctx, report);
  },
};
