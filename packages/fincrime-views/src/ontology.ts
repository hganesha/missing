import type { Schemas } from "@ehf/ui-contracts";
import { contextCatalogViews, type ContextCatalogSource } from "./context.js";

export type OntologyView = Schemas["ContextOntologyView"];
export type OntologyObject = Schemas["ContextOntologyNode"];
export type OntologyField = Schemas["ContextOntologyField"];
export type OntologyRelation = Schemas["ContextOntologyRelation"];
export type RelationshipCatalog = Schemas["ContextRelationshipCatalog"];
export type JsonSchema = {
  $ref?: string; type?: string | string[]; enum?: unknown[]; const?: unknown;
  properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema;
  anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; allOf?: JsonSchema[];
  description?: string; format?: string; pattern?: string;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  additionalProperties?: boolean | JsonSchema;
};
export type OntologyMetadata = {
  schemaVersion: string; objectTypes: readonly string[];
  definitions: Record<string, JsonSchema>;
  lock: { files: Record<string, { sha256: string }> };
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
function resolve(s: JsonSchema, defs: Record<string, JsonSchema>): JsonSchema {
  return s.$ref?.startsWith("#/$defs/") ? defs[s.$ref.slice(8)] ?? s : s;
}
function describe(raw: JsonSchema, defs: Record<string, JsonSchema>, seen = new Set<string>()): string {
  if (raw.$ref && seen.has(raw.$ref)) return raw.$ref.slice(8);
  const next = new Set(seen); if (raw.$ref) next.add(raw.$ref);
  const s = resolve(raw, defs);
  const union = s.anyOf ?? s.oneOf;
  if (union) return [...new Set(union.map(v => describe(v, defs, next)))].join(" | ");
  if (s.enum) return "enum";
  if (Array.isArray(s.type)) return s.type.join(" | ");
  if (s.type === "array") return `${describe(s.items ?? {}, defs, next)}[]`;
  if (s.type === "object" && typeof s.additionalProperties === "object") return `map<${describe(s.additionalProperties, defs, next)}>`;
  return s.format ?? s.type ?? raw.$ref?.slice(8) ?? "value";
}
/** Fields are generated from contracts, including nested structure; recursive maps stay bounded. */
export function ontologyFields(schema: JsonSchema, defs: Record<string, JsonSchema>): OntologyField[] {
  const fields: OntologyField[] = [];
  const walk = (raw: JsonSchema, prefix: string, depth: number, ancestors: Set<string>) => {
    const model = resolve(raw, defs);
    for (const [name, value] of Object.entries(model.properties ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}.${name}` : name;
      const s = resolve(value, defs);
      const branches = s.anyOf ?? s.oneOf ?? [s];
      const nonNull = branches.filter(v => resolve(v, defs).type !== "null");
      const shape = nonNull.length === 1 ? resolve(nonNull[0]!, defs) : s;
      const constraints = Object.entries(shape).filter(([k]) => ["pattern", "minimum", "maximum", "minLength", "maxLength", "format"].includes(k)).map(([k, v]) => `${k}: ${v}`);
      fields.push({ path, root: path.split(".")[0]!, type: describe(value, defs), required: model.required?.includes(name) ?? false,
        nullable: branches.some(v => { const t = resolve(v, defs).type; return t === "null" || (Array.isArray(t) && t.includes("null")); }), values: (shape.enum ?? (shape.const !== undefined ? [shape.const] : [])).map(String),
        description: s.description ?? "", constraints, depth });
      const nested = shape.type === "array" ? shape.items : shape;
      if (!nested || depth >= 4 || fields.length >= 1800 || (value.$ref && ancestors.has(value.$ref))) continue;
      const next = new Set(ancestors); if (value.$ref) next.add(value.$ref);
      walk(nested, shape.type === "array" ? `${path}[]` : path, depth + 1, next);
    }
  };
  walk(schema, "", 0, new Set());
  return fields;
}

/** Compose only mutually compatible, integrity-checked schema and catalog artifacts. */
export async function contextOntologyView(source: ContextCatalogSource, metadata: OntologyMetadata, relations: RelationshipCatalog): Promise<OntologyView> {
  const ontologyDigest = metadata.lock.files["ontology.schema.json"]?.sha256;
  if (!ontologyDigest || metadata.schemaVersion !== source.contextSchemaVersion || relations.schemaVersion !== metadata.schemaVersion || relations.ontologyDigest !== ontologyDigest)
    throw new Error("context.ontology_version_mismatch");
  const { digest: claimed, ...payload } = relations;
  if (await digest(payload) !== claimed) throw new Error("context.relationship_digest_mismatch");
  const types = new Set(metadata.objectTypes);
  const ids = new Set<string>();
  for (const edge of relations.relationships) {
    const s = metadata.definitions[edge.source];
    const f = s?.properties?.[edge.field];
    const value = edge.multiple ? f?.items : f;
    if (ids.has(edge.id) || !types.has(edge.source) || !types.has(edge.target) || !f
      || (f.type === "array") !== edge.multiple
      || edge.optional === (s?.required?.includes(edge.field) ?? false)
      || value?.$ref !== `#/$defs/${edge.representation === "exact_ref" ? "Ref" : "Id"}`)
      throw new Error("context.relationship_invalid");
    ids.add(edge.id);
  }
  const views = contextCatalogViews(source);
  for (const p of views.products) for (const [type, fields] of Object.entries(p.objects))
    if (!types.has(type) || fields.some(f => !Object.hasOwn(metadata.definitions[type]?.properties ?? {}, f))) throw new Error("context.ontology_catalog_mismatch");
  const requirements = new Map<string, Schemas["FieldRequirement"]>();
  for (const p of views.products) for (const r of views.productView(p.id)?.fieldRequirements ?? [])
    requirements.set(`${r.skill_id}:${r.object_type}:${r.field}:${r.required}`, r);
  const pins = { ontologyDigest, catalogDigest: source.catalogDigest, relationshipDigest: relations.digest };
  return {
    ...pins, projectionDigest: await digest(pins), schemaVersion: metadata.schemaVersion, relationshipVersion: relations.version,
    nodes: [...types].sort().map(id => ({ id, productIds: views.products.filter(p => Object.hasOwn(p.objects, id)).map(p => p.id), fields: ontologyFields(metadata.definitions[id]!, metadata.definitions) })),
    edges: relations.relationships, products: views.products, requirements: [...requirements.values()],
    agents: views.catalog.agents.map(a => ({ id: a.id, productIds: a.context_products, skills: Object.keys(a.execution.allowed_skills),
      ceilings: { ...a.execution.context_fields, Policy: [...new Set([...(a.execution.context_fields?.Policy ?? []), ...(a.execution.policy_fields ?? [])])] } })),
  };
}

/** A product focus retains one-hop boundary nodes; search can inspect the entire ontology. */
export function ontologyNeighborhood(view: OntologyView, product: string | undefined, query = "", focus?: string) {
  const q = query.trim().toLowerCase();
  const seeds = new Set(view.nodes.filter(n => (!product || n.productIds.includes(product)) && (!q || `${n.id} ${n.fields.map(f => f.path).join(" ")}`.toLowerCase().includes(q))).map(n => n.id));
  if (focus && view.nodes.some(n => n.id === focus)) seeds.add(focus);
  if (q) for (const e of view.edges) if (`${e.label} ${e.source} ${e.field} ${e.target}`.toLowerCase().includes(q) && (!product || seeds.has(e.source) || seeds.has(e.target))) { seeds.add(e.source); seeds.add(e.target); }
  const visible = new Set(seeds);
  for (const e of view.edges) if (seeds.has(e.source) || seeds.has(e.target)) { visible.add(e.source); visible.add(e.target); }
  return { nodes: view.nodes.filter(n => visible.has(n.id)), edges: view.edges.filter(e => visible.has(e.source) && visible.has(e.target)), seeds };
}
