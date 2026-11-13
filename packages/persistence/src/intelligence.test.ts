import { randomUUID } from "node:crypto";
import { expect, it, describe } from "vitest";
import { intelligenceConfigurationChecks } from "@ehf/contracts";
import fixture from "../../contracts/test-fixtures/intelligence-binding.json" with { type: "json" };
import { createDatabase } from "./index.js";
import { checkIntelligenceCandidate, intelligenceCandidates, saveIntelligenceCandidate } from "./intelligence.js";

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("intelligence PostgreSQL proposals", () => {
  it("isolates scopes, preserves history, rejects races, invalidates reports and leaves execution untouched", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const scope = { tenantId: `intelligence-${randomUUID()}`, environment: "sandbox" };
    const body = { definition: fixture, expectedRevision: null, reason: "Synthetic fixture" };
    try {
      const before = (await db.query("select count(*) from harness_admin.providers")).rows;
      const first = await saveIntelligenceCandidate(db, { ...scope, actor: "author", body });
      expect(first.revision).toBe(1);
      await expect(saveIntelligenceCandidate(db, { ...scope, actor: "author", body })).rejects.toThrow("revision_conflict");
      const race = await Promise.allSettled(["first", "second"].map(name => saveIntelligenceCandidate(db, { ...scope, actor: name, body: { ...body, expectedRevision: 1, definition: { ...fixture, description: name } } })));
      expect(race.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(race.filter(result => result.status === "rejected")).toHaveLength(1);
      const checked = await checkIntelligenceCandidate(db, { ...scope, bindingId: fixture.id, expectedRevision: 2, actor: "checker", evaluate: definition => intelligenceConfigurationChecks(definition, true) });
      expect(checked.executionVerified).toBe(false);
      expect(checked.checks.some(check => check.status === "unknown")).toBe(true);
      await saveIntelligenceCandidate(db, { ...scope, actor: "author", body: { ...body, expectedRevision: 2 } });
      const index = await intelligenceCandidates(db, scope);
      expect(index.candidates[0]?.revision).toBe(3);
      expect(index.history).toHaveLength(3);
      expect(index.activity).toHaveLength(4);
      expect(index.reports[0]?.digest).toBe(checked.digest);
      expect(index.reports[0]?.revision).toBe(2);
      expect(index.candidates[0]?.revision).not.toBe(index.reports[0]?.revision);
      await expect(checkIntelligenceCandidate(db, { ...scope, bindingId: fixture.id, expectedRevision: 2, actor: "checker", evaluate: () => [] })).rejects.toThrow("revision_conflict");
      expect((await intelligenceCandidates(db, { ...scope, tenantId: `${scope.tenantId}-other` })).candidates).toEqual([]);
      expect((await intelligenceCandidates(db, { ...scope, environment: "production" })).candidates).toEqual([]);
      await expect(saveIntelligenceCandidate(db, { ...scope, actor: "author", body: { ...body, definition: { ...fixture, configuration: { ...fixture.configuration, profileId: "other-tenant-profile" } }, expectedRevision: 3 } })).rejects.toThrow("profile_not_found");
      await expect(db.query("update harness_admin.intelligence_binding_revisions set reason=reason where tenant_id=$1", [scope.tenantId])).rejects.toThrow("history_immutable");
      expect((await db.query("select count(*) from harness_admin.providers")).rows).toEqual(before);
      expect((await intelligenceCandidates(db, scope)).candidates[0]?.revision).toBe(3);
    } finally { await db.end(); }
  });
});
