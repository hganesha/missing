import taxonomyArtifact from "../../../../artifacts/products/taxonomy.json" with { type: "json" };
import seedArtifact from "../../../../artifacts/products/institutions.json" with { type: "json" };
import {
  institutionCatalogProblems, institutionCatalogSchema, resolveCaseProduct, saveInstitutionCatalogSchema,
  type InstitutionCatalog, type InstitutionCatalogRevision, type ProductTaxonomy,
} from "@ehf/contracts/products";
import { packCompositionProblems, policyPackLayerSchema, policyPackSelectionSchema, productLineageOf, withLayerRevisions, type PolicyPackLayer } from "@ehf/policy-engine/effective";
import { parse } from "yaml";
import { clone } from "../fixtures.js";
import { type Ctx, fail, type Impl, notFound, ok } from "../http.js";

// Institution catalogs (Product Policy Studio phase B), mirroring the control API: seeds from the
// repository, revisions held in session state, a second person to approve and publish.
const TAXONOMY = taxonomyArtifact as unknown as ProductTaxonomy;
/** The repository's pack layers, as the control API serves them (domains/policy/packs). */
const PACK_FILES = import.meta.glob("../../../../domains/policy/packs/**/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const PACK_LAYERS = Object.keys(PACK_FILES).sort().map((path) => parse(PACK_FILES[path]!) as unknown);
const SELECTION_FILES = import.meta.glob("../../../../domains/policy/selection.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const SELECTION = policyPackSelectionSchema.parse(parse(Object.values(SELECTION_FILES)[0]!));
const SEEDS = new Map((seedArtifact.catalogs as unknown[]).map((raw) => institutionCatalogSchema.parse(raw)).map((catalog) => [catalog.institution.id, catalog]));

/** Deterministic, digest-shaped (not cryptographic): the mock only needs equality. */
export function digestOf(value: unknown): string {
  const text = JSON.stringify(value);
  let out = "";
  for (let seed = 0; out.length < 64; seed++) {
    let hash = 0x811c9dc5 ^ seed;
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

function revisionsOf(ctx: Ctx, institutionId = ctx.params.institutionId!): InstitutionCatalogRevision[] {
  if (!ctx.state.institutionCatalogs.has(institutionId)) ctx.state.institutionCatalogs.set(institutionId, []);
  return ctx.state.institutionCatalogs.get(institutionId) as InstitutionCatalogRevision[];
}
const summary = ({ catalog: _catalog, ...rest }: InstitutionCatalogRevision) => rest;
const legacyResolution = (catalog: InstitutionCatalog | null) =>
  Object.keys(TAXONOMY.legacy).map((productType) => ({ productType, resolved: resolveCaseProduct({ productType }, catalog, TAXONOMY) }));

function decide(ctx: Ctx, act: "approve" | "publish"): Response {
  const reason = String(ctx.body?.reason ?? "").trim();
  if (reason.length < 3) return fail(ctx, 400, "institution.decision_invalid", "A reason of at least three characters is required.");
  const revision = revisionsOf(ctx).find((entry) => entry.revision === Number(ctx.params.revision));
  if (!revision) return notFound(ctx, "Revision");
  const expected = act === "approve" ? "DRAFT" : "APPROVED";
  if (revision.status !== expected) return fail(ctx, 409, act === "approve" ? "institution.revision_not_draft" : "institution.revision_not_approved", `Only a ${expected.toLowerCase()} revision can be ${act}d.`);
  if (revision.authoredBy === ctx.subject) return fail(ctx, 403, act === "approve" ? "institution.approver_is_author" : "institution.publisher_is_author", "Someone other than the author must decide.");
  const now = new Date().toISOString();
  if (act === "approve") {
    const problems = institutionCatalogProblems(revision.catalog, TAXONOMY);
    if (problems.length) return fail(ctx, 409, "institution.problems_unresolved", "Resolve every problem before approval.", { problems });
    Object.assign(revision, { status: "APPROVED", problems: [], approvedBy: ctx.subject, approvedAt: now });
  } else {
    for (const entry of revisionsOf(ctx)) if (entry.status === "PUBLISHED") entry.status = "SUPERSEDED";
    Object.assign(revision, { status: "PUBLISHED", publishedBy: ctx.subject, publishedAt: now });
  }
  return ok(ctx, clone(revision));
}

export const institutions: Record<string, Impl> = {
  getAuthoringProductsTaxonomy: (ctx) => ok(ctx, clone(TAXONOMY)),
  // Pack layers as the control API serves them: the repository's, with the session's published
  // revisions in their place (phase H), and the revision state of each edited layer.
  getAuthoringPoliciesPacks: (ctx) => {
    const heads = [...packRevisions(ctx)].filter(([, revisions]) => revisions.length).map(([layerId, revisions]) => {
      const latest = revisions.at(-1)!; const published = revisions.find((entry) => entry.status === "PUBLISHED") ?? null;
      const summary = ({ layer: _layer, ...rest }: Rec) => rest;
      return { layerId, latest: summary(latest), published: published ? summary(published) : null };
    }).sort((a, b) => a.layerId.localeCompare(b.layerId));
    return ok(ctx, { layers: clone(tenantLayers(ctx)), revisions: clone(heads), selection: clone(SELECTION), generatedAt: new Date().toISOString() });
  },
  getAuthoringPoliciesPacksLayerIdRevisions: (ctx) => ok(ctx, { layerId: ctx.params.layerId, revisions: clone([...(packRevisions(ctx).get(ctx.params.layerId!) ?? [])].reverse()) }),
  postAuthoringPoliciesPacksLayerIdRevisions: (ctx) => {
    const parsed = policyPackLayerSchema.safeParse(ctx.body?.layer);
    if (!parsed.success) return fail(ctx, 400, "pack_layer.invalid", "The layer does not match the pack layer contract.", { issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    if (parsed.data.metadata.id !== ctx.params.layerId) return fail(ctx, 400, "pack_layer.id_mismatch", "The layer id does not match the path.");
    const reason = typeof ctx.body?.reason === "string" ? ctx.body.reason.trim() : "";
    if (reason.length < 3) return fail(ctx, 400, "pack_layer.reason_required", "Give a reason of at least three characters.");
    if (!packRevisions(ctx).has(ctx.params.layerId!)) packRevisions(ctx).set(ctx.params.layerId!, []);
    const revisions = packRevisions(ctx).get(ctx.params.layerId!)!;
    if (ctx.body?.expectedRevision !== revisions.length) return fail(ctx, 409, "pack_layer.revision_conflict", "Someone saved a newer revision of this layer.");
    for (const entry of revisions) if (entry.status === "DRAFT" || entry.status === "APPROVED") entry.status = "SUPERSEDED";
    const revision: Rec = { layerId: ctx.params.layerId, revision: revisions.length + 1, status: "DRAFT", digest: digestOf(parsed.data), problems: layerProblems(ctx, parsed.data),
      reason, authoredBy: ctx.subject, authoredAt: ctx.state.clock, approvedBy: null, approvedAt: null, publishedBy: null, publishedAt: null, layer: parsed.data };
    revisions.push(revision);
    return ok(ctx, clone(revision), 201);
  },
  postAuthoringPoliciesPacksLayerIdRevisionsRevisionApprove: (ctx) => decideLayer(ctx, "approve"),
  postAuthoringPoliciesPacksLayerIdRevisionsRevisionPublish: (ctx) => decideLayer(ctx, "publish"),
  getAuthoringInstitutions: (ctx) => {
    const ids = [...new Set([...SEEDS.keys(), ...[...ctx.state.institutionCatalogs].filter(([, revisions]) => revisions.length).map(([id]) => id)])].sort();
    return ok(ctx, { generatedAt: new Date().toISOString(), items: ids.map((institutionId) => {
      const revisions = revisionsOf(ctx, institutionId);
      const latest = revisions.at(-1) ?? null;
      const published = revisions.find((entry) => entry.status === "PUBLISHED") ?? null;
      const catalog = latest?.catalog ?? SEEDS.get(institutionId)!;
      return { institutionId, name: catalog.institution.name, synthetic: catalog.institution.synthetic, seeded: SEEDS.has(institutionId), offerings: catalog.offerings.length,
        latest: latest && summary(latest), published: published && summary(published) };
    }) });
  },
  getAuthoringInstitutionsInstitutionIdCatalog: (ctx) => {
    const revisions = revisionsOf(ctx);
    const seed = SEEDS.get(ctx.params.institutionId!) ?? null;
    const latest = revisions.at(-1) ?? null;
    const published = revisions.find((entry) => entry.status === "PUBLISHED") ?? null;
    const working = latest?.catalog ?? seed;
    if (!working) return notFound(ctx, "Institution");
    return ok(ctx, clone({
      institutionId: ctx.params.institutionId, taxonomy: { version: TAXONOMY.version, digest: TAXONOMY.digest }, seed, latest, published,
      revisions: [...revisions].reverse().map(summary), problems: institutionCatalogProblems(working, TAXONOMY), legacyResolution: legacyResolution(published?.catalog ?? working),
    }));
  },
  postAuthoringInstitutionsInstitutionIdCatalogRevisions: (ctx) => {
    const parsed = saveInstitutionCatalogSchema.safeParse(ctx.body);
    if (!parsed.success) return fail(ctx, 400, "institution.catalog_invalid", "The catalog does not match the institution catalog contract.",
      { issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    if (parsed.data.catalog.institution.id !== ctx.params.institutionId) return fail(ctx, 400, "institution.id_mismatch", "The catalog names another institution.");
    const revisions = revisionsOf(ctx);
    const latest = revisions.at(-1)?.revision ?? 0;
    if (latest !== parsed.data.expectedRevision) return fail(ctx, 409, "institution.revision_conflict", `Revision ${latest} was saved since you started; reload and reapply.`);
    for (const entry of revisions) if (entry.status === "DRAFT" || entry.status === "APPROVED") entry.status = "SUPERSEDED";
    const catalog = parsed.data.catalog;
    const revision: InstitutionCatalogRevision = {
      institutionId: catalog.institution.id, revision: latest + 1, status: "DRAFT", digest: digestOf(catalog), taxonomyDigest: catalog.taxonomy.digest,
      problems: institutionCatalogProblems(catalog, TAXONOMY), reason: parsed.data.reason, authoredBy: ctx.subject, authoredAt: new Date().toISOString(),
      approvedBy: null, approvedAt: null, publishedBy: null, publishedAt: null, catalog,
    };
    revisions.push(revision);
    return ok(ctx, clone(revision), 201);
  },
  postAuthoringInstitutionsInstitutionIdCatalogRevisionsRevisionApprove: (ctx) => decide(ctx, "approve"),
  postAuthoringInstitutionsInstitutionIdCatalogRevisionsRevisionPublish: (ctx) => decide(ctx, "publish"),
};

type Rec = Record<string, unknown>;
function packRevisions(ctx: Ctx): Map<string, Rec[]> {
  const state = ctx.state as unknown as { packLayerRevisions?: Map<string, Rec[]> };
  return (state.packLayerRevisions ??= new Map());
}
/** The repository's layers with the session's published revisions in their place. */
function tenantLayers(ctx: Ctx): PolicyPackLayer[] {
  const published = [...packRevisions(ctx).values()].flatMap((revisions) => revisions.filter((entry) => entry.status === "PUBLISHED").map((entry) => entry.layer as PolicyPackLayer));
  return withLayerRevisions(PACK_LAYERS.map((raw) => policyPackLayerSchema.parse(raw)), published);
}
const layerProblems = (ctx: Ctx, candidate: PolicyPackLayer) =>
  packCompositionProblems(withLayerRevisions(tenantLayers(ctx), [candidate]), SELECTION, { lineage: (product) => productLineageOf(product, TAXONOMY.legacy) });
function decideLayer(ctx: Ctx, act: "approve" | "publish"): Response {
  const reason = typeof ctx.body?.reason === "string" ? ctx.body.reason.trim() : "";
  if (reason.length < 3) return fail(ctx, 400, "pack_layer.reason_required", "Give a reason of at least three characters.");
  const revisions = packRevisions(ctx).get(ctx.params.layerId!) ?? [];
  const revision = revisions.find((entry) => entry.revision === Number(ctx.params.revision));
  if (!revision) return notFound(ctx, "Pack layer revision");
  if (revision.authoredBy === ctx.subject) return fail(ctx, 403, act === "approve" ? "pack_layer.approver_is_author" : "pack_layer.publisher_is_author", "Someone other than the author must do this.");
  if (act === "approve") {
    if (revision.status !== "DRAFT") return fail(ctx, 409, "pack_layer.revision_not_draft", "Only a draft can be approved.");
    const problems = layerProblems(ctx, revision.layer as PolicyPackLayer);
    if (problems.length) { revision.problems = problems; return fail(ctx, 409, "pack_layer.problems_unresolved", "Composing a pack with this layer fails."); }
    Object.assign(revision, { status: "APPROVED", problems: [], approvedBy: ctx.subject, approvedAt: ctx.state.clock });
  } else {
    if (revision.status !== "APPROVED") return fail(ctx, 409, "pack_layer.revision_not_approved", "Only an approved revision can be published.");
    for (const entry of revisions) if (entry.status === "PUBLISHED") entry.status = "SUPERSEDED";
    Object.assign(revision, { status: "PUBLISHED", publishedBy: ctx.subject, publishedAt: ctx.state.clock });
  }
  return ok(ctx, clone(revision));
}
