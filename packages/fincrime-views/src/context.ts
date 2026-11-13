import type { Schemas } from "@ehf/ui-contracts";
export type ContextCatalogSource = {
  catalogDigest: string;
  apiVersion: string;
  sourceRelease: string;
  contextSchemaVersion: string;
  bundleCodeHash: string;
  agents: Array<{ value: Record<string, unknown> }>;
  tasks: Array<{ value: Record<string, unknown> }>;
  contextProducts: Array<Record<string, unknown>>;
  skills: Array<{ value: Record<string, unknown> }>;
};
/** Derived only from verified canonical catalog artifacts, never live-data qualification. */
export function contextCatalogViews(source: ContextCatalogSource) {
  const agents = source.agents.map(
    (a) => a.value as unknown as Schemas["BusinessAgent.schema"],
  );
  const tasks = source.tasks.map(
    (t) => t.value as unknown as Schemas["TaskSpec.schema"],
  );
  const products =
    source.contextProducts as unknown as Schemas["ContextProduct.schema"][];
  const requirements: Schemas["FieldRequirement"][] = [];
  for (const skill of source.skills)
    for (const optional of [false, true]) {
      const reqs = skill.value[
        optional ? "optional_context" : "required_context"
      ] as Array<{
        object_type: string;
        fields: string[];
        min_count: number;
        max_age_seconds: number | null;
      }>;
      for (const req of reqs ?? [])
        for (const field of req.fields)
          requirements.push({
            object_type: req.object_type,
            field,
            required: !optional,
            min_count: req.min_count,
            on_missing: optional ? "CONTINUE" : "NEEDS_EVIDENCE",
            freshness_policy:
              req.max_age_seconds == null
                ? null
                : `max_age_seconds:${req.max_age_seconds}`,
            temporal: "valid_at_as_of_and_recorded_by_cutoff",
            skill_id: String(skill.value.id),
          });
    }
  const cells: Schemas["ContextReadinessMatrix"]["cells"] = [];
  for (const agent of agents)
    for (const product of products) {
      const subscribed = agent.context_products.includes(product.id);
      const required = requirements.filter(
        (r) =>
          r.required &&
          Object.hasOwn(agent.execution.allowed_skills, r.skill_id) &&
          Object.hasOwn(product.objects, r.object_type),
      );
      const ceiling = new Set(
        Object.entries(agent.execution.context_fields ?? {})
          .filter(([o]) => Object.hasOwn(product.objects, o))
          .flatMap(([o, fields]) => fields.map((f) => `${o}.${f}`)),
      );
      if (Object.hasOwn(product.objects, "Policy"))
        for (const field of agent.execution.policy_fields ?? [])
          ceiling.add(`Policy.${field}`);
      const gaps = [
        ...new Set(
          required
            .filter((r) => !ceiling.has(`${r.object_type}.${r.field}`))
            .map((r) => `${r.object_type}.${r.field}`),
        ),
      ].sort();
      cells.push({
        agentId: agent.id,
        productId: product.id,
        subscribed,
        requiredFields: new Set(
          required.map((r) => `${r.object_type}.${r.field}`),
        ).size,
        ceilingFields: ceiling.size,
        status:
          !subscribed && !required.length
            ? "not_subscribed"
            : gaps.length || !subscribed
              ? "gaps"
              : "ready",
        gaps,
      });
    }
  const readiness: Schemas["ContextReadinessMatrix"] = {
    products: products.map((p) => p.id),
    agents: agents.map((a) => a.id),
    cells,
  };
  const catalog: Schemas["CatalogView"] = {
    catalogDigest: source.catalogDigest,
    apiVersion: source.apiVersion,
    sourceRelease: source.sourceRelease,
    contextSchemaVersion: source.contextSchemaVersion,
    bundleCodeHash: source.bundleCodeHash,
    agents,
    tasks,
    contextProducts: products,
    skillCount: source.skills.length,
  };
  const productView = (id: string): Schemas["ContextProductView"] | null => {
    const product = products.find((p) => p.id === id);
    if (!product) return null;
    const rows = requirements.filter((r) =>
      Object.hasOwn(product.objects, r.object_type),
    );
    return {
      product,
      consumers: {
        agents: agents
          .filter((a) => a.context_products.includes(id))
          .map((a) => a.id)
          .sort(),
        skills: [...new Set(rows.map((r) => r.skill_id))].sort(),
      },
      fieldRequirements: rows,
      ceilings: agents
        .filter((a) => a.context_products.includes(id))
        .map((a) => ({
          agentId: a.id,
          fields: Object.fromEntries(
            Object.entries(a.execution.context_fields ?? {}).filter(([o]) =>
              Object.hasOwn(product.objects, o),
            ),
          ),
        })),
      capabilityReadiness: {
        status: "pending_upstream",
        note: "Source connection, mapping qualification, and task assessment are separate from field access coverage.",
      },
    };
  };
  return { catalog, products, requirements, readiness, productView };
}
