import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  stableDigest,
  type ContextSampleReport,
  type ContextDefinition,
} from "@ehf/contracts";
import { createDatabase } from "./index.js";
import {
  activateContextMapping,
  getContextDefinition,
  getContextEnablement,
  pauseContextMapping,
  saveContextDefinition,
  saveContextSample,
} from "./context-setup.js";
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)(
  "context qualification transaction",
  () => {
    it("preserves enablement history, serializes activation and refuses qualification for a changed draft", async () => {
      const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
      const scope = {
        tenantId: `context-activation-${randomUUID()}`,
        environment: "test",
      };
      const save = (definition: ContextDefinition, expectedRevision = 0) =>
        saveContextDefinition(db, scope, {
          definition,
          expectedRevision,
          actor: "author",
          reason: "Test source setup",
        });
      try {
        const connection = await save({
          kind: "connection",
          id: "crm",
          name: "CRM",
          connectorId: "context-postgres:customers",
          credentialRef: "CONTEXT_SOURCE_TEST",
          credentialGeneration: "v1",
          identityMode: "service",
          resources: [
            { schema: "public", table: "customers", columns: ["key"] },
          ],
        });
        const resource = await save({
          kind: "resource",
          id: "customers",
          connectionId: "crm",
          connectionDigest: connection.digest,
          schema: "public",
          table: "customers",
          columns: ["key"],
          subjectColumn: "key",
          observedAtColumn: "key",
          schemaFingerprint: null,
          maxRows: 100,
        });
        const mapping = await save({
          kind: "mapping",
          id: "customers",
          name: "Customers",
          resourceId: "customers",
          resourceDigest: resource.digest,
          productId: "party360",
          schemaVersion: "2.0.0",
          catalogDigest: "a".repeat(64),
          subject: { op: "field", path: "key" },
          outputs: [],
        });
        const report: ContextSampleReport = {
          id: randomUUID(),
          mappingId: "customers",
          mappingDigest: mapping.digest,
          resourceDigest: resource.digest,
          connectionDigest: connection.digest,
          compilationDigest: "b".repeat(64),
          schemaVersion: "2.0.0",
          catalogDigest: "a".repeat(64),
          origin: "live",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          actor: "author",
          inputDigest: "c".repeat(64),
          schemaFingerprint: null,
          counts: {
            rows: 1,
            acceptedRows: 1,
            rejectedRows: 0,
            duplicateRecords: 0,
            candidates: 1,
            subjects: 1,
          },
          stages: [],
          issues: [],
          candidates: [
            {
              object_type: "Entity",
              object_id: "entity:1",
              version_id: "v1",
              schema_version: "2.0.0",
              data: {
                name: "Test",
                identifiers: ["1"],
                entity_type: "individual",
              },
              subject_ids: ["1"],
              observed_at: "2026-11-09T12:00:00Z",
              row: 1,
            },
          ],
          lineage: [],
          limitations: [
            "Test authorization seam; not live qualification evidence",
          ],
          authority: {
            planDigest: "d".repeat(64),
            contextDigest: "e".repeat(64),
            connectorId: "context-postgres:customers",
            capabilityId: "context.records.fetch.v1",
          },
          sourceDecision: null,
        };
        await saveContextSample(db, scope, report);
        // This test supplies the service authorization seam; production performs policy/release checks there.
        const activate = (expectedRevision: number) =>
          activateContextMapping(db, scope, {
            mappingId: "customers",
            mappingDigest: mapping.digest,
            report,
            expectedRevision,
            actor: "operator",
            artifactDigests: [],
            authorize: async () => {},
          });
        const race = await Promise.allSettled([activate(0), activate(0)]);
        expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(race.filter((r) => r.status === "rejected")).toHaveLength(1);
        expect(
          (await getContextEnablement(db, scope, "customers"))?.mappingDigest,
        ).toBe(mapping.digest);
        await save(
          { ...mapping.definition, name: "Changed" } as ContextDefinition,
          1,
        );
        await expect(activate(1)).rejects.toThrow(
          "context.qualification_changed",
        );
        expect(
          (await getContextDefinition(db, scope, "mapping", "customers"))
            ?.revision,
        ).toBe(2);
        await pauseContextMapping(db, scope, "customers", 1, "operator");
        expect(
          (await getContextEnablement(db, scope, "customers"))?.paused,
        ).toBe(true);
        const audit = await db.query(
          "select paused_by,paused_at from harness_control.context_enablements where tenant_id=$1",
          [scope.tenantId],
        );
        expect(audit.rows[0].paused_by).toBe("operator");
        expect(audit.rows[0].paused_at).toBeTruthy();
        await expect(
          db.query(
            "update harness_control.context_enablements set mapping_digest=$2 where tenant_id=$1",
            [scope.tenantId, stableDigest("changed")],
          ),
        ).rejects.toThrow("context.enablement_history_immutable");
      } finally {
        await db.end();
      }
    });
  },
);
