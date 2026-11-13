import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabase } from "./index.js";
import {
  claimContextRefresh,
  finishContextRefresh,
} from "./context-refresh.js";
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)(
  "durable context refresh",
  () => {
    it("claims once, retains the dispatch identity across retry and rejects an expired claim", async () => {
      const db = createDatabase(process.env.EHF_TEST_DATABASE_URL),
        tenant = `refresh_${randomUUID()}`;
      try {
        await db.query(
          "insert into integration.context_refresh_jobs(tenant_id,binding_id,revision,enabled,plan_digest,source_context_digest,run_input,interval_minutes) values ($1,'customers',1,true,$2,$3,$4::jsonb,5)",
          [
            tenant,
            "a".repeat(64),
            "b".repeat(64),
            JSON.stringify({ caseId: "case-1" }),
          ],
        );
        const claims = await Promise.all([
          claimContextRefresh(db, tenant),
          claimContextRefresh(db, tenant),
        ]);
        const job = claims.find(Boolean)!;
        expect(claims.filter(Boolean)).toHaveLength(1);
        await finishContextRefresh(db, job, {
          error: "context_source.refresh_dispatch_failed",
        });
        const row = (
          await db.query(
            "select * from integration.context_refresh_jobs where tenant_id=$1",
            [tenant],
          )
        ).rows[0];
        expect(row.scheduled_for.toISOString()).toBe(
          job.scheduled_for.toISOString(),
        );
        expect(row.failures).toBe(1);
        await db.query(
          "update integration.context_refresh_jobs set due_at=now() where tenant_id=$1",
          [tenant],
        );
        const retry = (await claimContextRefresh(db, tenant))!;
        expect(retry.claim_id).not.toBe(job.claim_id);
        await finishContextRefresh(db, job, { runId: "stale-worker" });
        expect(
          (
            await db.query(
              "select run_id from integration.context_refresh_jobs where tenant_id=$1",
              [tenant],
            )
          ).rows[0].run_id,
        ).toBeNull();
        await finishContextRefresh(db, retry, { runId: "accepted-run" });
        const stored = (
          await db.query(
            "select * from integration.context_refresh_jobs where tenant_id=$1",
            [tenant],
          )
        ).rows[0];
        expect(stored.run_id).toBe("accepted-run");
        expect(stored.lease_until).toBeNull();
        expect(await claimContextRefresh(db, tenant)).toBeNull();
      } finally {
        await db.end();
      }
    });
  },
);
