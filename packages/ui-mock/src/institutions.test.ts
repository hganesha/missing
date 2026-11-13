import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Rec } from "./fixtures.js";
import { setup } from "./test-support.js";

const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());

describe("institution catalogs", () => {
  it("serves the taxonomy, the seeded institutions and how today's product types resolve", async () => {
    env.as("agent_architect");
    const before = env.state.violations.length;
    expect(((await env.call("getAuthoringProductsTaxonomy")).body.nodes as Rec[]).length).toBe(270);
    const packs = (await env.call("getAuthoringPoliciesPacks")).body.layers as Rec[];
    expect(packs.length).toBe(15);
    expect(packs.map((layer) => layer.metadata.id)).toContain("pack.product.family.pay");
    const list = await env.call("getAuthoringInstitutions");
    expect((list.body.items as Rec[]).map((item) => [item.institutionId, item.offerings, item.latest])).toEqual([["bank.synthetic", 8, null], ["securities.synthetic", 6, null]]);
    const view = await env.call("getAuthoringInstitutionsInstitutionIdCatalog");
    expect(view.body).toMatchObject({ institutionId: "bank.synthetic", latest: null, published: null, revisions: [], problems: [] });
    expect((view.body.legacyResolution as Rec[]).find((entry) => entry.productType === "card")!.resolved).toMatchObject({ canonicalProductId: "PAY.CARDS.DEBIT", offeringId: "debit-card" });
    expect((await env.call("getAuthoringInstitutionsInstitutionIdCatalog", { path: { institutionId: "nowhere" } })).status).toBe(404);
    expect(env.state.violations.slice(before)).toEqual([]);
  });

  it("saves a draft, refuses a stale save and self approval, then approves and publishes as a second person", async () => {
    env.as("agent_architect");
    const before = env.state.violations.length;
    const seed = (await env.call("getAuthoringInstitutionsInstitutionIdCatalog")).body.seed as Rec;
    const broken = structuredClone(seed); broken.offerings[0].canonicalProductId = "DEP.NOPE";
    const draft = await env.call("postAuthoringInstitutionsInstitutionIdCatalogRevisions", { body: { catalog: broken, expectedRevision: 0, reason: "First draft" } });
    expect(draft.status).toBe(201);
    expect(draft.body.problems).toContain("institution.offering_product_unknown:everyday-checking:DEP.NOPE");
    expect((await env.call("postAuthoringInstitutionsInstitutionIdCatalogRevisions", { body: { catalog: seed, expectedRevision: 0, reason: "Stale" } })).status).toBe(409);
    const fixed = await env.call("postAuthoringInstitutionsInstitutionIdCatalogRevisions", { body: { catalog: seed, expectedRevision: 1, reason: "Fix checking" } });
    expect(fixed.body).toMatchObject({ revision: 2, status: "DRAFT", problems: [] });
    env.as("harness_approver");
    expect((await env.call("postAuthoringInstitutionsInstitutionIdCatalogRevisionsRevisionApprove", { path: { revision: "1" }, body: { reason: "Old" } })).body.error).toBe("institution.revision_not_draft");
    expect((await env.call("postAuthoringInstitutionsInstitutionIdCatalogRevisionsRevisionPublish", { path: { revision: "2" }, body: { reason: "Too early" } })).status).toBe(409);
    expect((await env.call("postAuthoringInstitutionsInstitutionIdCatalogRevisionsRevisionApprove", { path: { revision: "2" }, body: { reason: "Reviewed" } })).body.status).toBe("APPROVED");
    expect((await env.call("postAuthoringInstitutionsInstitutionIdCatalogRevisionsRevisionPublish", { path: { revision: "2" }, body: { reason: "Go live" } })).body.status).toBe("PUBLISHED");
    const view = await env.call("getAuthoringInstitutionsInstitutionIdCatalog");
    expect((view.body.revisions as Rec[]).map((entry) => entry.status)).toEqual(["PUBLISHED", "SUPERSEDED"]);
    expect(env.state.violations.slice(before)).toEqual([]);
  });

  it("refuses the author's own approval and an author without approval rights", async () => {
    env.as("agent_architect");
    const view = (await env.call("getAuthoringInstitutionsInstitutionIdCatalog", { path: { institutionId: "securities.synthetic" } })).body;
    await env.call("postAuthoringInstitutionsInstitutionIdCatalogRevisions", { path: { institutionId: "securities.synthetic" }, body: { catalog: view.seed, expectedRevision: 0, reason: "Seed" } });
    const self = await env.call("postAuthoringInstitutionsInstitutionIdCatalogRevisionsRevisionApprove", { path: { institutionId: "securities.synthetic", revision: "1" }, body: { reason: "Self" } });
    expect(self.status).toBe(403);
  });
});
