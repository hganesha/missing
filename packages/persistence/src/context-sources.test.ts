import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  contextConnectionSchema,
  contextBindingSchema,
  type ContextCheck,
} from "@ehf/contracts";
import fixture from "../../contracts/test-fixtures/context-source.json" with { type: "json" };
import { createDatabase } from "./index.js";
import {
  saveContextSource,
  contextSourceIndex,
  loadContextBinding,
  activateContextBinding,
  recordContextCheck,
  registerQualifiedContextConnector,
  contextSourceQualification,
} from "./context-sources.js";
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)(
  "revisioned context sources",
  () => {
    it("isolates tenants, rejects stale writes and retains active revisions across edits", async () => {
      const db = createDatabase(process.env.EHF_TEST_DATABASE_URL),
        tenantId = `context_test_${randomUUID()}`;
      const connection = contextConnectionSchema.parse(fixture.connection),
        binding = contextBindingSchema.parse(fixture.binding);
      const save = (
        kind: "connection" | "binding",
        definition: unknown,
        expectedRevision: number | null,
      ) =>
        saveContextSource(db, {
          tenantId,
          actor: "author",
          kind,
          body: { definition, expectedRevision },
        });
      try {
        const conn = await save("connection", connection, null),
          first = await save("binding", binding, null);
        await expect(save("binding", binding, null)).rejects.toThrow(
          "revision_conflict",
        );
        const transition = {
          tenantId,
          actor: "operator",
          bindingId: binding.id,
          body: {
            expectedRevision: 1,
            revision: 1,
            action: "activate",
            reason: "Verified source",
          },
        };
        await expect(activateContextBinding(db, transition)).rejects.toThrow(
          "connector_unavailable",
        );
        const report: ContextCheck = {
          id: randomUUID(),
          bindingId: binding.id,
          revision: 1,
          bindingDigest: first.digest,
          connectionDigest: conn.digest,
          kind: "qualify",
          status: "passed",
          schemaFingerprint: "a".repeat(64),
          fields: [],
          rowCount: 1,
          truncated: false,
          error: null,
          checkedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          actor: "tester",
        };
        await recordContextCheck(db, tenantId, report);
        await registerQualifiedContextConnector(
          db,
          tenantId,
          binding.id,
          1,
          connection.provider,
        );
        expect(await activateContextBinding(db, transition)).toEqual({
          activeRevision: 1,
          disabled: false,
        });
        await recordContextCheck(db, tenantId, {
          ...report,
          id: randomUUID(),
          status: "failed",
          error: "context_source.schema_drift",
        });
        expect(
          (await contextSourceQualification(db, tenantId, binding.id, 1))?.id,
        ).toBe(report.id);
        await save("binding", { ...binding, name: "Changed draft" }, 1);
        const index = await contextSourceIndex(db, tenantId);
        expect(index.bindings[0]).toMatchObject({
          revision: 2,
          activeRevision: 1,
          disabled: false,
        });
        expect(
          (
            await loadContextBinding(db, {
              tenantId,
              bindingId: binding.id,
              revision: 1,
              executable: true,
            })
          ).binding.digest,
        ).toBe(first.digest);
        await expect(
          loadContextBinding(db, {
            tenantId: `${tenantId}_foreign`,
            bindingId: binding.id,
            revision: 1,
          }),
        ).rejects.toThrow("not_found");
        expect(
          (await contextSourceIndex(db, `${tenantId}_foreign`)).connections,
        ).toEqual([]);
        await expect(
          recordContextCheck(db, tenantId, { ...report, id: randomUUID() }),
        ).rejects.toThrow("revision_conflict");
        await activateContextBinding(db, {
          ...transition,
          body: { ...transition.body, expectedRevision: 2, action: "disable" },
        });
        await expect(
          loadContextBinding(db, {
            tenantId,
            bindingId: binding.id,
            revision: 1,
            executable: true,
          }),
        ).rejects.toThrow("inactive");
      } finally {
        await db.end();
      }
    });
  },
);
