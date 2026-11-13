import canonicalTypes from "../../../ui-contracts/vendor/docs/ui/contracts/fixtures/context-canonical-types.json" with { type: "json" };
import {
  contextConnectionSaveSchema,
  contextBindingSaveSchema,
  contextCheckRequestSchema,
  contextActivationSchema,
  contextRefreshSaveSchema,
} from "@ehf/contracts/context-sources";
import type { Schemas } from "@ehf/ui-contracts";
import { clone } from "../fixtures.js";
import { can, fail, ok, stableJson, type Ctx, type Impl } from "../http.js";
const store = (ctx: Ctx) => {
  const tenant = String(ctx.session.tenant.tenantId);
  if (!ctx.state.contextSources.has(tenant))
    ctx.state.contextSources.set(tenant, {
      index: {
        connections: [],
        bindings: [],
        checks: [],
        canonicalTypes,
        refreshes: [],
      },
      history: [],
    });
  return ctx.state.contextSources.get(tenant)!;
};
async function digest(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(stableJson(value)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
export const contextSources: Record<string, Impl> = {
  postContextSourceRefresh: (ctx) => {
    if (!can(ctx, "integration.activate") || !can(ctx, "run.start"))
      return fail(
        ctx,
        403,
        "authorization.role_missing",
        "Requires process-flow operating authority.",
      );
    const parsed = contextRefreshSaveSchema.safeParse(ctx.body);
    if (!parsed.success)
      return fail(
        ctx,
        400,
        "context_source.refresh_invalid",
        "Check the schedule configuration.",
      );
    const state = store(ctx),
      binding = state.index.bindings.find(
        (b) => b.definition.id === ctx.params.bindingId,
      );
    if (!binding || binding.revision !== parsed.data.expectedRevision)
      return fail(
        ctx,
        409,
        "context_source.revision_conflict",
        "Reload the source.",
      );
    if (binding.disabled || binding.activeRevision !== parsed.data.revision)
      return fail(
        ctx,
        409,
        "context_source.inactive",
        "Activate a qualified source first.",
      );
    if (parsed.data.configuration.enabled)
      return fail(
        ctx,
        409,
        "release.executable_authority_missing",
        "A published process flow is required.",
      );
    const refresh = state.index.refreshes.find(
      (r) => r.bindingId === binding.definition.id,
    );
    if (refresh) refresh.enabled = false;
    return ok(ctx, { activeRevision: binding.activeRevision, disabled: true });
  },
  getContextSources: (ctx) => ok(ctx, store(ctx).index),
  postContextSourceConnections: async (ctx) => {
    const parsed = contextConnectionSaveSchema.safeParse(ctx.body);
    if (!parsed.success)
      return fail(
        ctx,
        400,
        "context_source.configuration_invalid",
        "Check the connection fields.",
      );
    const { definition, expectedRevision } = parsed.data;
    const state = store(ctx);
    const before = state.index.connections.find(
      (c) => c.definition.id === definition.id,
    );
    if (
      expectedRevision === null
        ? Boolean(before)
        : before?.revision !== expectedRevision
    )
      return fail(
        ctx,
        409,
        "context_source.revision_conflict",
        "Reload the latest revision.",
      );
    const hash = await digest(definition);
    if (
      state.index.connections.find((c) => c.definition.id === definition.id)
        ?.revision !== before?.revision
    )
      return fail(
        ctx,
        409,
        "context_source.revision_conflict",
        "Reload the latest revision.",
      );
    const { sqlServerAuth, ...connection } = clone(definition);
    const record = {
      definition: {
        ...connection,
        ...(sqlServerAuth === undefined ? {} : { sqlServerAuth }),
      },
      revision: (expectedRevision ?? 0) + 1,
      digest: hash,
      actor: ctx.subject,
      createdAt: ctx.state.clock,
    };
    state.index.connections.unshift(record);
    return ok(ctx, record, 201);
  },
  postContextSourceBindings: async (ctx) => {
    const parsed = contextBindingSaveSchema.safeParse(ctx.body);
    if (!parsed.success)
      return fail(
        ctx,
        400,
        "context_source.configuration_invalid",
        "Check the binding fields.",
      );
    const { definition, expectedRevision } = parsed.data;
    const state = store(ctx);
    const connection = state.index.connections.find(
      (c) =>
        c.definition.id === definition.connectionId &&
        c.revision === definition.connectionRevision,
    );
    if (!connection)
      return fail(
        ctx,
        400,
        "context_source.connection_not_found",
        "Choose a connection revision.",
      );
    if (
      definition.refresh.enabled &&
      connection.definition.identityMode !== "service"
    )
      return fail(
        ctx,
        400,
        "context_source.schedule_requires_service",
        "Refresh requires a service identity.",
      );
    const before = state.index.bindings.find(
      (b) => b.definition.id === definition.id,
    );
    if (
      expectedRevision === null
        ? Boolean(before)
        : before?.revision !== expectedRevision
    )
      return fail(
        ctx,
        409,
        "context_source.revision_conflict",
        "Reload the latest revision.",
      );
    const hash = await digest(definition);
    const tenantHash = (
      await digest({ tenantId: String(ctx.session.tenant.tenantId) })
    ).slice(0, 16);
    if (
      state.index.bindings.find((b) => b.definition.id === definition.id)
        ?.revision !== before?.revision
    )
      return fail(
        ctx,
        409,
        "context_source.revision_conflict",
        "Reload the latest revision.",
      );
    const record = {
      // The parsed definition's optional fields read `T | undefined`; the API type omits them instead.
      definition: clone(
        definition,
      ) as Schemas["ContextBindingHead"]["definition"],
      revision: (expectedRevision ?? 0) + 1,
      digest: hash,
      actor: ctx.subject,
      createdAt: ctx.state.clock,
    };
    const head = {
      ...record,
      activeRevision: before?.activeRevision ?? null,
      disabled: before?.disabled ?? false,
      connectorId: `context-source:${tenantHash}:${definition.id}.r${record.revision}`,
    };
    state.index.bindings = [
      ...state.index.bindings.filter((b) => b.definition.id !== definition.id),
      head,
    ];
    state.history.unshift(head);
    return ok(ctx, record, 201);
  },
  postContextSourceChecks: (ctx) => {
    const parsed = contextCheckRequestSchema.safeParse(ctx.body);
    if (!parsed.success)
      return fail(
        ctx,
        400,
        "context_source.check_invalid",
        "Check expected revision and parameters.",
      );
    const state = store(ctx),
      binding = state.index.bindings.find(
        (b) => b.definition.id === ctx.params.bindingId,
      );
    if (!binding)
      return fail(
        ctx,
        404,
        "context_source.not_found",
        "Binding was not found.",
      );
    if (binding.revision !== parsed.data.expectedRevision)
      return fail(
        ctx,
        409,
        "context_source.revision_conflict",
        "Reload the latest revision.",
      );
    const connection = state.index.connections.find(
      (c) =>
        c.definition.id === binding.definition.connectionId &&
        c.revision === binding.definition.connectionRevision,
    )!;
    const descriptor = state.index.canonicalTypes.find(
      (type) => type.name === binding.definition.objectType,
    );
    const canonicalInvalid =
      !descriptor ||
      descriptor.required.some(
        (name) =>
          !binding.definition.mapping.some(
            (mapping) => mapping.target === name,
          ),
      ) ||
      binding.definition.mapping.some(
        (mapping) =>
          !descriptor.fields.some((field) => field.name === mapping.target),
      );
    const error = canonicalInvalid
      ? "context_source.canonical_data_invalid"
      : connection.definition.identityMode === "delegated"
        ? "context_source.delegation_unavailable"
        : binding.definition.parameters.some(
              (p) => typeof parsed.data.parameters[p.name] !== p.type,
            )
          ? "context_source.parameter_invalid"
          : null;
    const fields = [
      ...new Set([
        binding.definition.keyField,
        binding.definition.observedAtField,
        ...binding.definition.mapping.map((m) => m.source),
      ]),
    ].map((name) => ({ name, type: "string", nullable: false }));
    const report: Schemas["ContextSourceCheck"] = {
      id: `synthetic-check-${++ctx.state.counter}`,
      bindingId: binding.definition.id,
      revision: binding.revision,
      bindingDigest: binding.digest,
      connectionDigest: connection.digest,
      kind: parsed.data.kind,
      status: error ? "failed" : "passed",
      error,
      schemaFingerprint: error ? null : "b".repeat(64),
      fields: error ? [] : fields,
      rowCount: parsed.data.kind === "discover" || error ? 0 : 1,
      truncated: false,
      checkedAt: ctx.state.clock,
      expiresAt: new Date(
        Math.max(Date.parse(ctx.state.clock), Date.now()) + 86400000,
      ).toISOString(),
      actor: ctx.subject,
    };
    state.index.checks.unshift(report);
    return ok(ctx, report);
  },
  postContextSourceActivation: (ctx) => {
    const parsed = contextActivationSchema.safeParse(ctx.body);
    if (!parsed.success)
      return fail(
        ctx,
        400,
        "context_source.activation_invalid",
        "A revision and reason are required.",
      );
    const state = store(ctx),
      binding = state.index.bindings.find(
        (b) => b.definition.id === ctx.params.bindingId,
      );
    if (!binding || binding.revision !== parsed.data.expectedRevision)
      return fail(
        ctx,
        409,
        "context_source.revision_conflict",
        "Reload the latest revision.",
      );
    const report = state.index.checks.find(
      (c) =>
        c.bindingId === binding.definition.id &&
        c.revision === parsed.data.revision &&
        c.kind === "qualify",
    );
    if (
      parsed.data.action === "activate" &&
      (!report ||
        report.status !== "passed" ||
        Date.parse(report.expiresAt) <= Date.parse(ctx.state.clock))
    )
      return fail(
        ctx,
        409,
        "context_source.qualification_required",
        "Qualify this exact revision before activation.",
      );
    binding.disabled = parsed.data.action === "disable";
    if (!binding.disabled) binding.activeRevision = parsed.data.revision;
    return ok(ctx, {
      activeRevision: binding.activeRevision,
      disabled: binding.disabled,
    });
  },
};
