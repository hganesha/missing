import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabase } from "./index.js";
import {
  getContextDefinition,
  saveContextDefinition,
} from "./context-setup.js";
import type { ContextCaseBinding } from "@ehf/contracts";

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)(
  "reviewed case source binding persistence",
  () => {
    it("keeps immutable revisions and tenant isolation using the migrated source registry", async () => {
      const db = createDatabase(process.env.EHF_TEST_DATABASE_URL),
        scope = { tenantId: `pull-${randomUUID()}`, environment: "test" };
      const binding: ContextCaseBinding = {
        kind: "case-binding",
        id: "customer-source",
        caseId: "case",
        mappingId: "mapping",
        mappingDigest: "a".repeat(64),
        enablementRevision: 1,
        planDigest: "b".repeat(64),
        nodeId: "fetch",
        sourceContextDigest: "c".repeat(64),
        subjects: [{ subjectId: "entity:one", sourceKey: "crm-one" }],
        enabled: true,
      };
      try {
        const first = await saveContextDefinition(db, scope, {
          definition: binding,
          expectedRevision: 0,
          actor: "reviewer",
          reason: "Approve exact case subjects",
        });
        expect(
          (await getContextDefinition(db, scope, "case-binding", binding.id))
            ?.digest,
        ).toBe(first.digest);
        expect(
          await getContextDefinition(
            db,
            { ...scope, tenantId: "other-tenant" },
            "case-binding",
            binding.id,
          ),
        ).toBeNull();
        const paused = await saveContextDefinition(db, scope, {
          definition: { ...binding, enabled: false },
          expectedRevision: 1,
          actor: "reviewer",
          reason: "Pause case pulls",
        });
        expect(paused.revision).toBe(2);
        expect(paused.digest).not.toBe(first.digest);
        await expect(
          saveContextDefinition(db, scope, {
            definition: binding,
            expectedRevision: 1,
            actor: "reviewer",
            reason: "Stale update",
          }),
        ).rejects.toThrow("context.revision_conflict");
        const rows = await db.query(
          "select revision from harness_control.context_revisions where tenant_id=$1 and kind='case-binding' order by revision",
          [scope.tenantId],
        );
        expect(rows.rows.map((r) => r.revision)).toEqual([1, 2]);
        await expect(
          db.query(
            "update harness_control.context_revisions set reason='changed' where tenant_id=$1",
            [scope.tenantId],
          ),
        ).rejects.toThrow("context.history_immutable");
      } finally {
        await db.end();
      }
    });
  },
);
