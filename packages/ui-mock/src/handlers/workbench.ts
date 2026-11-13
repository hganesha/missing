import { FINCRIME, clone, type Rec } from "../fixtures.js";
import { fail, ok, type Ctx, type Impl } from "../http.js";

const stores = new WeakMap<object, Map<string, Rec>>();
function seed(ctx: Ctx, id = "WS-MOCK"): Rec {
  const config = {
    kind: "skill",
    name: "Example skill",
    description: "Source preview in mock mode",
    version: "0.1.0",
    engine: "python",
    entrypoint: "main:run",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    modelProfileId: null,
    skillRefs: [],
  };
  const source = {
    workspaceId: id,
    revision: 1,
    digest: "a".repeat(64),
    files: {
      "workbench.json": JSON.stringify(config, null, 2),
      "SKILL.md": "# Example skill\n\nDocument the expected behavior here.",
      "main.py": "def run(data):\n    return data\n",
    },
    config,
    message: "Created example",
    actor: ctx.subject,
    createdAt: ctx.state.clock,
  };
  return {
    workspace: {
      workspaceId: id,
      kind: "skill",
      name: config.name,
      revision: 1,
      publishedRevision: null,
      createdBy: ctx.subject,
      updatedAt: ctx.state.clock,
    },
    source,
    history: [
      {
        revision: 1,
        digest: source.digest,
        message: source.message,
        actor: ctx.subject,
        createdAt: ctx.state.clock,
      },
    ],
    evaluations: [],
    promotions: [],
  };
}
function store(ctx: Ctx) {
  let items = stores.get(ctx.state);
  if (!items) {
    items = new Map([["WS-MOCK", seed(ctx)]]);
    stores.set(ctx.state, items);
  }
  return items;
}
function view(ctx: Ctx) {
  return (
    store(ctx).get(ctx.params.workspaceId) || seed(ctx, ctx.params.workspaceId)
  );
}
export const workbench: Record<string, Impl> = {
  getWorkbenchSource: (ctx) => {
    const source = seed(ctx).source;
    return ok(ctx, {
      sourceId: ctx.params.sourceId ?? "screening.name.normalize",
      kind: "skill",
      name: source.config.name,
      files: source.files,
      config: source.config,
      digest: source.digest,
    });
  },
  getWorkbenchSources: (ctx) =>
    ok(ctx, {
      items: (FINCRIME.skills as Rec[]).map(skill => ({ id: skill.skill_id, name: skill.skill_id, kind: "skill", description: skill.business_outcome, version: skill.version, category: skill.domain })),
    }),
  getWorkbenchWorkspaces: (ctx) =>
    ok(ctx, { items: [...store(ctx).values()].map((item) => item.workspace) }),
  getWorkbenchWorkspace: (ctx) => ok(ctx, clone(view(ctx))),
  getWorkbenchExport: (ctx) =>
    ok(ctx, {
      format: "ehf.source-bundle.v1",
      source: clone(view(ctx).source),
    }),
  postWorkbenchWorkspaces: (ctx) => {
    const id = "WS-" + crypto.randomUUID();
    const item = seed(ctx, id);
    const files = ctx.body?.files as Record<string, string> | undefined;
    if (files) {
      try {
        item.source.config = JSON.parse(files["workbench.json"]!);
        item.source.files = files;
      } catch {
        return fail(
          ctx,
          400,
          "workbench.source_invalid",
          "Invalid source bundle.",
        );
      }
    }
    item.workspace.name = ctx.body?.name ?? item.workspace.name;
    item.workspace.kind = ctx.body?.kind ?? "skill";
    if (!files) {
      item.source.config = {
        ...item.source.config,
        kind: item.workspace.kind,
        name: item.workspace.name,
      };
      item.source.files["workbench.json"] = JSON.stringify(
        item.source.config,
        null,
        2,
      );
    }
    store(ctx).set(id, item);
    return ok(ctx, clone(item), 201);
  },
  putWorkbenchWorkspace: (ctx) => {
    const item = view(ctx);
    if (ctx.body?.expectedRevision !== item.workspace.revision)
      return fail(
        ctx,
        409,
        "workbench.revision_conflict",
        "Reload the current revision.",
      );
    const files = ctx.body?.files;
    try {
      const config = JSON.parse(files["workbench.json"]);
      const revision = item.workspace.revision + 1;
      item.source = {
        ...item.source,
        revision,
        config,
        files,
        message: ctx.body?.message,
        actor: ctx.subject,
        createdAt: ctx.state.clock,
      };
      item.workspace = { ...item.workspace, name: config.name, revision };
      item.history.unshift({
        revision,
        digest: item.source.digest,
        message: item.source.message,
        actor: ctx.subject,
        createdAt: ctx.state.clock,
      });
      store(ctx).set(item.workspace.workspaceId, item);
      return ok(ctx, clone(item));
    } catch {
      return fail(
        ctx,
        400,
        "workbench.source_invalid",
        "Invalid source bundle.",
      );
    }
  },
  // A mock UI must never claim that edited code or a model actually ran.
  postWorkbenchEvaluation: (ctx) =>
    fail(
      ctx,
      503,
      "workbench.http_execution_required",
      "Open HTTP mode to execute source code and persist evaluation evidence.",
    ),
  postWorkbenchPromotion: (ctx) =>
    fail(
      ctx,
      409,
      "workbench.passing_evaluation_required",
      "A passing HTTP evaluation is required.",
    ),
  postWorkbenchCancel: (ctx) => ok(ctx, { cancelled: true }),
};
