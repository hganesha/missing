import { clone, type Rec } from "../fixtures.js";
import { type Ctx, fail, type Impl, notFound, ok, page, rolesGranting } from "../http.js";
import { nextId } from "../state.js";
import { hex64 } from "./cases.js";

// ---- Releases ---------------------------------------------------------------------------

const TRANSITION_ACTION: Record<string, string> = {
  approved: "release.approve",
  active: "release.activate",
  deprecated: "release.activate",
  revoked: "release.revoke",
};

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  candidate: ["approved", "revoked"],
  approved: ["active", "revoked"],
  active: ["deprecated", "revoked"],
  deprecated: ["active", "revoked"],
  revoked: [],
};

export const releases: Record<string, Impl> = {
  getReleases: (ctx) => ok(ctx, { releases: clone(ctx.state.store.releases), generatedAt: ctx.state.clock }),
  postReleases: (ctx) => {
    const manifest = (ctx.body?.manifest ?? {}) as Rec;
    // Mock signature check (PLT-11 AC3): a signature verifies only when its value is
    // `mock-sig:<manifestDigest>`; anything else is what upstream reports for a bad signature.
    const signature = (manifest.signature ?? {}) as Rec;
    if (signature.value !== `mock-sig:${String(manifest.manifestDigest ?? "")}`) {
      return fail(ctx, 422, "release.signature_invalid", `The manifest signature does not verify against key ${String(signature.keyId ?? "unknown")} (version ${String(signature.keyVersion ?? "unknown")}).`);
    }
    const release = {
      releaseId: String(manifest.releaseId ?? nextId(ctx.state, "rel")),
      manifestDigest: hex64(JSON.stringify(manifest)),
      status: "candidate",
      revision: 1,
      activatedAt: null,
      deprecatedAt: null,
      revokedAt: null,
      reasonCode: null,
      updatedAt: ctx.state.clock,
    };
    ctx.state.store.releases.push(release);
    return ok(ctx, release, 201);
  },
  getReleasesActivations: (ctx) => {
    const now = Date.parse(ctx.state.clock);
    const releases = ctx.state.store.releases as Rec[];
    const statusOf = (id: unknown) => releases.find((entry) => entry.releaseId === id)?.status;
    // In effect: the active release whose activation started most recently.
    const started = activations(ctx).filter((entry) => Date.parse(String(entry.effectiveFrom)) <= now && statusOf(entry.releaseId) === "active");
    const current = [...started].sort((a, b) => Date.parse(String(b.effectiveFrom)) - Date.parse(String(a.effectiveFrom)))[0];
    const inEffect = current ? [String(current.releaseId)] : releases.filter((entry) => entry.status === "active" && !activations(ctx).some((item) => item.releaseId === entry.releaseId)).map((entry) => String(entry.releaseId));
    return ok(ctx, { activations: clone(activations(ctx)), inEffect,
      scheduled: clone(activations(ctx).filter((entry) => Date.parse(String(entry.effectiveFrom)) > now && statusOf(entry.releaseId) === "active")), generatedAt: ctx.state.clock });
  },
  postReleasesReleaseIdRollback: (ctx) => {
    const release = (ctx.state.store.releases as Rec[]).find((entry) => entry.releaseId === ctx.params.releaseId);
    if (!release) return notFound(ctx, "Release");
    if (!ctx.session.actions.includes("release.activate")) return fail(ctx, 403, "authorization.role_missing", `Your role does not permit this. Requires ${rolesGranting("release.activate").join(" or ")}.`, { actor: ctx.subject });
    const reason = typeof ctx.body?.reason === "string" ? ctx.body.reason.trim() : "";
    if (reason.length < 3) return fail(ctx, 400, "release.rollback_reason_required", "Say why you are rolling back.");
    if (release.status !== "active" && release.status !== "deprecated") return fail(ctx, 409, "release.rollback_target_invalid", "Only a release that was active can be put back in effect.");
    for (const other of ctx.state.store.releases as Rec[]) {
      if (other !== release && other.status === "active") Object.assign(other, { status: "deprecated", activatedAt: null, deprecatedAt: ctx.state.clock, revision: other.revision + 1, reasonCode: "release.rolled_back", updatedAt: ctx.state.clock });
    }
    Object.assign(release, { status: "active", revision: release.revision + 1, reasonCode: "release.rollback", activatedAt: ctx.state.clock, deprecatedAt: null, updatedAt: ctx.state.clock });
    activations(ctx).unshift({ activationId: `ract_mock_${activations(ctx).length + 1}`, releaseId: release.releaseId, environment: "development", line: "process",
      kind: "ROLLBACK", effectiveFrom: ctx.state.clock, actor: ctx.subject, reason, createdAt: ctx.state.clock });
    return ok(ctx, clone(release));
  },
  postReleasesReleaseIdTransition: (ctx) => {
    const release = (ctx.state.store.releases as Rec[]).find((entry) => entry.releaseId === ctx.params.releaseId);
    if (!release) return notFound(ctx, "Release");
    const to = String(ctx.body?.to ?? "");
    const action = TRANSITION_ACTION[to];
    if (action && !ctx.session.actions.includes(action)) {
      return fail(ctx, 403, "authorization.role_missing", `Your role does not permit this. Requires ${rolesGranting(action).join(" or ")}.`, { actor: ctx.subject });
    }
    if (ctx.body?.expectedRevision !== release.revision || !action || !ALLOWED_TRANSITIONS[release.status]?.includes(to)) {
      return fail(ctx, 409, "release.transition_failed", ctx.body?.expectedRevision !== release.revision
        ? `The release changed (rev ${String(ctx.body?.expectedRevision)} → ${release.revision}).`
        : `A ${release.status} release cannot become ${to}.`);
    }
    const effectiveFrom = typeof ctx.body?.effectiveFrom === "string" ? String(ctx.body.effectiveFrom) : null;
    if (effectiveFrom !== null && (to !== "active" || Number.isNaN(Date.parse(effectiveFrom)) || Date.parse(effectiveFrom) < Date.parse(ctx.state.clock) - 60_000)) {
      return fail(ctx, 400, "release.effective_from_invalid", "A release takes effect now or on a future date.");
    }
    if (to === "active") {
      // Like the server's history: a release scheduled for later supersedes nothing until its date.
      const scheduled = effectiveFrom !== null && Date.parse(effectiveFrom) > Date.parse(ctx.state.clock);
      activations(ctx).unshift({ activationId: `ract_mock_${activations(ctx).length + 1}`, releaseId: release.releaseId, environment: "development", line: "process",
        kind: release.status === "deprecated" ? "ROLLBACK" : scheduled ? "SCHEDULE" : "ACTIVATE", effectiveFrom: effectiveFrom ?? ctx.state.clock,
        actor: ctx.subject, reason: String(ctx.body?.reasonCode ?? "release.operator_decision"), createdAt: ctx.state.clock });
    }
    Object.assign(release, {
      status: to,
      revision: release.revision + 1,
      reasonCode: String(ctx.body?.reasonCode ?? "release.operator_decision"),
      updatedAt: ctx.state.clock,
      ...(to === "active" ? { activatedAt: ctx.state.clock } : {}),
      ...(to === "deprecated" ? { deprecatedAt: ctx.state.clock } : {}),
      ...(to === "revoked" ? { revokedAt: ctx.state.clock } : {}),
    });
    return ok(ctx, clone(release));
  },
  postRegistryArtifactsKindDigestRevoke: (ctx) => ok(ctx, { status: "revoked", kind: ctx.params.kind, digest: ctx.params.digest, reasonCode: ctx.body?.reasonCode, revokedAt: ctx.state.clock }),
};

// ---- Integrations -----------------------------------------------------------------------

function bindingStatus(ctx: Ctx, status: string): Response {
  const binding = (ctx.state.platform.bindings as Rec[]).find((entry) => entry.id === ctx.params.bindingId);
  if (!binding) return notFound(ctx, "Binding");
  binding.status = status;
  return ok(ctx, { binding: clone(binding) });
}

export const integrations: Record<string, Impl> = {
  getIntegrationsConnectors: (ctx) => ok(ctx, { items: clone(ctx.state.platform.connectors) }),
  postIntegrationsConnectors: (ctx) => {
    const connector = clone(ctx.body ?? {});
    ctx.state.platform.connectors.push(connector);
    return ok(ctx, connector, 201);
  },
  getIntegrationsBindings: (ctx) => ok(ctx, { items: clone(ctx.state.platform.bindings) }),
  postIntegrationsBindings: (ctx) => {
    const binding = clone(ctx.body ?? {});
    ctx.state.platform.bindings.push(binding);
    return ok(ctx, binding, 201);
  },
  postIntegrationsBindingsBindingIdTest: (ctx) => {
    const binding = (ctx.state.platform.bindings as Rec[]).find((entry) => entry.id === ctx.params.bindingId);
    return binding ? ok(ctx, { ok: true, bindingId: binding.id, testedAt: ctx.state.clock, synthetic: true }) : notFound(ctx, "Binding");
  },
  postIntegrationsBindingsBindingIdActivate: (ctx) => bindingStatus(ctx, "ACTIVE"),
  postIntegrationsBindingsBindingIdPause: (ctx) => bindingStatus(ctx, "PAUSED"),
  getIntegrationsDeliveries: (ctx) => {
    const status = ctx.url.searchParams.get("status");
    return ok(ctx, { items: clone((ctx.state.platform.deliveries as Rec[]).filter((entry) => !status || entry.status === status)) });
  },
  postIntegrationsDeliveriesDeliveryIdReplay: (ctx) => {
    const delivery = (ctx.state.platform.deliveries as Rec[]).find((entry) => entry.deliveryId === ctx.params.deliveryId);
    if (!delivery) return notFound(ctx, "Delivery");
    delivery.attempts += 1;
    return ok(ctx, { replayed: true, delivery: clone(delivery) });
  },
  getIntegrationsHumanCasesCaseIdActions: (ctx) => ok(ctx, { items: clone(ctx.state.platform.humanActions) }),
  postIntegrationsHumanCasesCaseIdActionsActionIdExecute: (ctx) => {
    const action = (ctx.state.platform.humanActions as Rec[]).find((entry) => entry.id === ctx.params.actionId);
    return action ? ok(ctx, { executed: true, actionId: action.id, caseId: ctx.params.caseId }) : notFound(ctx, "Human action");
  },
};

// ---- Gateway ----------------------------------------------------------------------------

export const gateway: Record<string, Impl> = {
  getGatewayRegistry: (ctx) => ok(ctx, page(ctx, clone(ctx.state.platform.capabilityRegistry as Rec[]))),
  postGatewayRegistry: (ctx) => {
    // x-action: capability.register, or admin.write when authoring is disabled.
    const action = ctx.session.authoringEnabled ? "capability.register" : "admin.write";
    if (!ctx.session.actions.includes(action)) return fail(ctx, 403, "authorization.role_missing", `Your role does not permit registering capabilities. Requires ${rolesGranting(action).join(" or ")}.`, { actor: ctx.subject });
    const item = { capability: clone(ctx.body ?? {}), createdAt: ctx.state.clock, digest: hex64(JSON.stringify(ctx.body ?? {})), updatedAt: ctx.state.clock };
    ctx.state.platform.capabilityRegistry.push(item);
    return ok(ctx, item, 201);
  },
  getGatewayAdapters: (ctx) => ok(ctx, page(ctx, clone(ctx.state.platform.adapters as Rec[]))),
  getGatewayProfiles: (ctx) => ok(ctx, page(ctx, clone(ctx.state.platform.modelTiers as Rec[]))),
  getGatewayStatus: (ctx) => ok(ctx, { ...clone(ctx.state.platform.gatewayStatus), generatedAt: ctx.state.clock, telemetryFreshThrough: ctx.state.clock }),
  getGatewayCapabilities: (ctx) => ok(ctx, page(ctx, clone(ctx.state.platform.toolCapabilities as Rec[]))),
  getGatewayDecisions: (ctx) => {
    const runId = ctx.url.searchParams.get("runId");
    const decision = ctx.url.searchParams.get("decision");
    return ok(ctx, page(ctx, clone((ctx.state.platform.gatewayDecisions as Rec[]).filter((entry) => (!runId || entry.runId === runId) && (!decision || entry.decision === decision)))));
  },
  postGatewayOpenrouterTest: (ctx) => ok(ctx, { status: "Configured", latencyMs: 120, testedAt: ctx.state.clock, message: "Recorded mode: the connection test is simulated.", credentialState: "Configured" }),
};

// ---- Admin ------------------------------------------------------------------------------

const ADMIN_T0 = "2026-11-06T08:00:00Z";

type FieldSeed = [path: string, label: string, kind: string, envName: string | null, appliesAt: "live" | "restart", help: string, extra?: Rec];

function sectionSeed(section: string, service: string, appliesAt: string, summary: string, source: string, value: Rec, fields: FieldSeed[]): Rec {
  return {
    section, service, appliesAt, summary, source, value, updatedAt: source === "store" ? ADMIN_T0 : null, updatedBy: source === "store" ? "n.osei" : null,
    fields: fields.map(([path, label, kind, envName, fieldAppliesAt, help, extra]) => ({
      path, label, kind, appliesAt: fieldAppliesAt, help, service, envPresent: envName === "WORKER_CONCURRENCY",
      ...(envName ? { envName } : {}), ...(extra ?? {}),
    })),
  };
}

function profileRevision(id: string, revision: number, status: string, profile: Rec, note: string | null): Rec {
  const document = { id, ...profile };
  return { createdAt: ADMIN_T0, createdBy: "n.osei", digest: hex64(JSON.stringify(document)), note, profile: document, revision, status };
}

/**
 * The contract fixture carries placeholder admin rows (`id`, `credentialRef`, empty settings).
 * Replace them once per state with synthetic rows shaped like ui-specs §5.8 so the
 * Administration surface has realistic data. Contract-valid; idempotent.
 */
export function ensureAdminSeeds(ctx: Ctx): void {
  const platform = ctx.state.platform;
  if (platform.adminSeeded) return;
  platform.adminSeeded = true;
  const openrouter = { appName: "EHF", baseUrl: "https://openrouter.ai/api/v1", credentialRef: "OPENROUTER_API_KEY", displayName: "OpenRouter", id: "openrouter", kind: "openrouter", siteUrl: null, status: "active" };
  const recorded = { appName: null, baseUrl: null, credentialRef: null, displayName: "Recorded adapter", id: "recorded", kind: "recorded", siteUrl: null, status: "active" };
  platform.providers = [
    { createdAt: ADMIN_T0, credentialPresent: true, digest: hex64(JSON.stringify(openrouter)), provider: openrouter, updatedAt: ADMIN_T0, updatedBy: "n.osei" },
    { createdAt: ADMIN_T0, credentialPresent: null, digest: hex64(JSON.stringify(recorded)), provider: recorded, updatedAt: ADMIN_T0, updatedBy: "n.osei" },
  ];
  const analysisV1 = profileRevision("analysis", 1, "superseded", { maxConcurrency: 2, maxOutputTokens: 2400, model: "vendor/analysis-model-2026-06", provider: "openrouter", timeoutMs: 45000 }, "initial");
  const analysisV2 = profileRevision("analysis", 2, "active", { maxConcurrency: 4, maxOutputTokens: 4000, model: "vendor/analysis-model-2026-09", provider: "openrouter", timeoutMs: 60000 }, "raise output budget");
  const triage = profileRevision("triage", 1, "active", { maxConcurrency: 8, maxOutputTokens: 1200, model: "vendor/triage-model-2026-09", provider: "openrouter", timeoutMs: 20000 }, "initial");
  platform.modelProfiles = [
    { ...clone(analysisV2), revisions: [clone(analysisV1), clone(analysisV2)] },
    { ...clone(triage), revisions: [clone(triage)] },
  ];
  platform.settings = [
    sectionSeed("dispatcher", "runtime-dispatcher", "restart", "Lease duration, poll cadence, worker concurrency, and bounded retry backoff.", "store",
      { pollIntervalMs: 750, leaseSeconds: 60, concurrency: 2, retryBaseMs: 2000, retryMaxMs: 60000 }, [
        ["pollIntervalMs", "Poll interval (ms)", "number", "WORKER_POLL_MS", "restart", "How often an idle worker slot looks for a claimable run."],
        ["leaseSeconds", "Lease duration (s)", "number", "WORKER_LEASE_SECONDS", "restart", "How long a claimed run stays owned before another worker may take it."],
        ["concurrency", "Worker concurrency", "number", "WORKER_CONCURRENCY", "restart", "Runs this dispatcher process executes at once."],
        ["retryBaseMs", "Retry base (ms)", "number", "WORKER_RETRY_BASE_MS", "restart", "First backoff step. Each further attempt doubles it."],
        ["retryMaxMs", "Retry ceiling (ms)", "number", "WORKER_RETRY_MAX_MS", "restart", "Upper bound on the doubling backoff."],
      ]),
    sectionSeed("gateway", "capability-gateway", "live", "Whether an absent provider credential may be answered by the recorded adapter.", "default",
      { recordedFallback: "platform_default" }, [
        ["recordedFallback", "Recorded adapter fallback", "enum", "MODEL_RECORDED_FALLBACK", "live", "platform_default allows under SECURITY_PROFILE=development and denies under production; deny fails closed.", { options: ["platform_default", "allow", "deny"] }],
      ]),
    sectionSeed("envelope", "control-api", "live", "Lifetime of a minted execution envelope.", "default", { ttlSeconds: 60 }, [
      ["ttlSeconds", "Envelope TTL (s)", "number", "EXECUTION_ENVELOPE_TTL_SECONDS", "live", "Seconds a minted execution envelope stays valid (30–3,600)."],
    ]),
    sectionSeed("authoring", "control-api", "live", "Budgets stamped into a newly created authoring draft.", "default",
      { defaultBudgets: { maxDurationMs: 120000, maxCostUsd: 0.25, maxModelCalls: 2, maxCapabilityCalls: 4 } }, [
        ["defaultBudgets.maxDurationMs", "Default max duration (ms)", "number", null, "live", "Greater than 0, at most 86,400,000."],
        ["defaultBudgets.maxCostUsd", "Default max cost (USD)", "number", null, "live", "0 to 1,000."],
        ["defaultBudgets.maxModelCalls", "Default max model calls", "number", null, "live", "Whole number 0 to 1,000."],
        ["defaultBudgets.maxCapabilityCalls", "Default max capability calls", "number", null, "live", "Whole number 0 to 1,000."],
      ]),
    sectionSeed("runtime", "runtime-dispatcher", "mixed", "Which agent runtime a run is dispatched to, its local endpoint, and how the runtime checkpoints.", "default",
      { provider: "local_http", localEndpoint: "http://runtime-host-local:8088/invocations", checkpointBackend: "postgres" }, [
        ["provider", "Default agent runtime", "string", "RUNTIME_PROVIDER", "live", "An adapter (local_http, hosted_http, databricks) or <adapter>:<binding>. A node's own runtimeTarget overrides this."],
        ["localEndpoint", "Local runtime endpoint", "url", "RUNTIME_LOCAL_ENDPOINT", "live", "URL of the local runtime host."],
        ["checkpointBackend", "Checkpoint backend", "enum", "RUNTIME_CHECKPOINT_BACKEND", "restart", "Where the runtime checkpoints.", { options: ["postgres", "memory"] }],
      ]),
    sectionSeed("observability", "all services", "mixed", "Trace export, sampling and the trace viewer links.", "default",
      { otlpTracesEndpoint: null, samplerRatio: 1, deploymentEnvironment: "local", cloudRegion: "local", traceViewerBaseUrl: null, traceViewerPublicUrl: null }, [
        ["otlpTracesEndpoint", "OTLP traces endpoint", "url", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "restart", "Where spans are exported.", { nullable: true }],
        ["samplerRatio", "Trace sampler ratio", "number", "OTEL_TRACES_SAMPLER_ARG", "restart", "0 to 1."],
        ["deploymentEnvironment", "Deployment environment", "string", "DEPLOYMENT_ENVIRONMENT", "restart", "Resource attribute on every span."],
        ["cloudRegion", "Cloud region", "string", "CLOUD_REGION", "restart", "Resource attribute on every span."],
        ["traceViewerBaseUrl", "Trace viewer base URL", "url", "TRACE_VIEWER_BASE_URL", "live", "Read by the control API.", { nullable: true }],
        ["traceViewerPublicUrl", "Trace viewer public URL", "url", "TRACE_VIEWER_PUBLIC_URL", "restart", "Link target shown to users.", { nullable: true }],
      ]),
    sectionSeed("caseStore", "case-api", "restart", "Where evidence artifacts are stored.", "default", { artifactBackend: "postgres" }, [
      ["artifactBackend", "Evidence artifact backend", "enum", "CASE_ARTIFACT_BACKEND", "restart", "Only postgres is supported.", { options: ["postgres"] }],
    ]),
    sectionSeed("database", "all services", "restart", "Connection pool limits.", "default", { poolMax: 12, connectTimeoutMs: 5000, idleTimeoutMs: 30000 }, [
      ["poolMax", "Max pool connections", "number", "DB_POOL_MAX", "restart", "1 to 100."],
      ["connectTimeoutMs", "Connect timeout (ms)", "number", "DB_CONNECT_TIMEOUT_MS", "restart", "250 to 120,000."],
      ["idleTimeoutMs", "Idle timeout (ms)", "number", "DB_IDLE_TIMEOUT_MS", "restart", "1,000 to 600,000."],
    ]),
    sectionSeed("outbox", "case-api", "restart", "Outbox drain cadence and retention.", "default", { intervalMs: 5000, retentionDays: 7 }, [
      ["intervalMs", "Drain interval (ms)", "number", "OUTBOX_INTERVAL_MS", "restart", "500 to 600,000."],
      ["retentionDays", "Delivered retention (days)", "number", "OUTBOX_RETENTION_DAYS", "restart", "1 to 365."],
    ]),
    sectionSeed("evidence", "case-api", "restart", "Evidence upload limits and scanning.", "default", { maxBytes: 1048576, requireScan: false }, [
      ["maxBytes", "Max evidence bytes", "number", "CASE_EVIDENCE_MAX_BYTES", "restart", "1,024 to 104,857,600."],
      ["requireScan", "Require malware scan", "boolean", "CASE_EVIDENCE_REQUIRE_SCAN", "restart", "Refuse evidence until it has been scanned."],
    ]),
  ];
  platform.changeLog = [{
    action: "update", actorId: "n.osei", actorRoles: ["Platform.Admin"], after: clone(analysisV2.profile), afterDigest: analysisV2.digest,
    before: clone(analysisV1.profile), beforeDigest: analysisV1.digest, changeId: "chg_0001", occurredAt: ADMIN_T0, reason: "raise output budget",
    resourceId: "analysis", resourceKind: "model-profile",
  }];
}

function change(ctx: Ctx, resourceKind: string, resourceId: string, action: string, before: Rec | null, after: Rec | null): void {
  ctx.state.platform.changeLog.unshift({
    action, actorId: ctx.subject, actorRoles: [...ctx.session.roles], after: after ?? null, afterDigest: after ? hex64(JSON.stringify(after)) : null,
    before: before ?? null, beforeDigest: before ? hex64(JSON.stringify(before)) : null, changeId: nextId(ctx.state, "chg"), occurredAt: ctx.state.clock,
    reason: (ctx.body?.reason as string | undefined) ?? null, resourceId, resourceKind,
  });
}

/** Wrap admin handlers so the synthetic admin rows exist before any read or write. */
function seeded(implementation: Impl): Impl {
  return (ctx) => {
    ensureAdminSeeds(ctx);
    return implementation(ctx);
  };
}

export const admin: Record<string, Impl> = {
  getAdminProviders: seeded((ctx) => ok(ctx, page(ctx, clone(ctx.state.platform.providers as Rec[])))),
  putAdminProvidersProviderId: seeded((ctx) => {
    const providers = ctx.state.platform.providers as Rec[];
    const existing = providers.find((entry) => entry.provider.id === ctx.params.providerId);
    const provider = { ...(ctx.body?.provider as Rec), id: ctx.params.providerId };
    const before = existing ? clone(existing.provider) : null;
    if (existing) Object.assign(existing, { provider, updatedAt: ctx.state.clock, updatedBy: ctx.subject, digest: hex64(JSON.stringify(provider)) });
    else providers.push({ createdAt: ctx.state.clock, credentialPresent: null, digest: hex64(JSON.stringify(provider)), provider, updatedAt: ctx.state.clock, updatedBy: ctx.subject });
    change(ctx, "provider", ctx.params.providerId!, existing ? "update" : "create", before, provider);
    return ok(ctx, { provider, updatedAt: ctx.state.clock });
  }),
  getAdminModelProfiles: seeded((ctx) => ok(ctx, page(ctx, clone(ctx.state.platform.modelProfiles as Rec[])))),
  putAdminModelProfilesProfileId: seeded((ctx) => {
    // ui-specs §5.2: a save mints max+1 as the active revision and supersedes the old one; an
    // identical document is a no-op that returns the active revision without a change entry.
    const profiles = ctx.state.platform.modelProfiles as Rec[];
    const entry = profiles.find((item) => item.profile.id === ctx.params.profileId);
    const profile = { ...(ctx.body?.profile as Rec), id: ctx.params.profileId };
    const digest = hex64(JSON.stringify(profile));
    if (entry && entry.digest === digest) {
      const { revisions: _revisions, ...active } = clone(entry);
      return ok(ctx, active);
    }
    const revisions = (entry?.revisions ?? []) as Rec[];
    const revision = {
      createdAt: ctx.state.clock, createdBy: ctx.subject, digest, note: (ctx.body?.note as string | undefined) ?? null,
      profile, revision: revisions.reduce((max, item) => Math.max(max, Number(item.revision)), 0) + 1, status: "active",
    };
    for (const item of revisions) if (item.status === "active") item.status = "superseded";
    const before = entry ? clone(entry.profile) : null;
    if (entry) Object.assign(entry, { ...clone(revision), revisions: [...revisions, clone(revision)] });
    else profiles.push({ ...clone(revision), revisions: [clone(revision)] });
    change(ctx, "model-profile", ctx.params.profileId!, entry ? "update" : "create", before, profile);
    return ok(ctx, revision, entry ? 200 : 201);
  }),
  postAdminModelProfilesProfileIdActivate: seeded((ctx) => {
    const entry = (ctx.state.platform.modelProfiles as Rec[]).find((item) => item.profile.id === ctx.params.profileId);
    if (!entry) return notFound(ctx, "Model profile");
    const target = (entry.revisions as Rec[]).find((revision) => revision.revision === ctx.body?.revision);
    if (!target) return fail(ctx, 404, "admin.model_profile_revision_not_found", `Revision ${String(ctx.body?.revision)} does not exist.`);
    const before = clone(entry.profile);
    for (const revision of entry.revisions as Rec[]) revision.status = revision === target ? "active" : "superseded";
    Object.assign(entry, { ...clone(target), revisions: entry.revisions, status: "active" });
    change(ctx, "model-profile", ctx.params.profileId!, "activate", before, target.profile);
    return ok(ctx, clone(target));
  }),
  getAdminObservability: seeded((ctx) => ok(ctx, {
    backend: "jaeger", revision: null, collectorEndpoint: null, applicationInsightsResourceId: null,
    lookupDays: null, samplerRatio: null, foundry: null, editUrl: null, checks: [],
  })),
  postAdminObservabilityVerify: seeded((ctx) => fail(ctx, 409, "observability.collector_not_configured", "A deployed Collector is required.")),
  getAdminSettings: seeded((ctx) => ok(ctx, page(ctx, clone(ctx.state.platform.settings as Rec[])))),
  putAdminSettingsSection: seeded((ctx) => {
    const section = (ctx.state.platform.settings as Rec[]).find((entry) => entry.section === ctx.params.section);
    if (!section) return notFound(ctx, "Settings section");
    const before = clone(section.value);
    Object.assign(section, { value: clone(ctx.body?.value ?? {}), source: "store", updatedAt: ctx.state.clock, updatedBy: ctx.subject });
    change(ctx, "platform-setting", section.section, "update", before, section.value);
    return ok(ctx, { section: section.section, value: section.value, updatedAt: ctx.state.clock, service: section.service, appliesAt: section.appliesAt, summary: section.summary });
  }),
  getAdminChangeLog: seeded((ctx) => ok(ctx, page(ctx, clone(ctx.state.platform.changeLog as Rec[])))),
  getAdminRuntime: (ctx) => ok(ctx, clone(ctx.state.runtimeAdmission)),
  postAdminRuntime: (ctx) => {
    const operation = ctx.body?.operation;
    ctx.state.runtimeAdmission = {
      state: operation === "stop" ? "stopped" : "running",
      revision:Number(ctx.state.runtimeAdmission.revision??0)+1,
      activeRunPolicy: operation === "stop" ? ((ctx.body?.activeRunPolicy as "drain" | "cancel" | undefined) ?? "drain") : null,
      changedAt: ctx.state.clock,
    };
    return ok(ctx, clone(ctx.state.runtimeAdmission));
  },
};

/** The mock's release activation history (session state), newest first. */
function activations(ctx: { state: unknown }): Rec[] {
  const state = ctx.state as { releaseActivations?: Rec[] };
  return (state.releaseActivations ??= []);
}
