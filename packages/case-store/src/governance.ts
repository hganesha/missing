import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { stableDigest } from "@ehf/contracts";
import type { BlobContainer, ListedBlob, PolicyResult } from "@ehf/blob-store";
import { appendLockedCaseEvent, CaseStoreError, createCaseStore, tenantEvidencePrefix, withCaseTenant, type CaseStore, type LockedCase } from "./index.js";
import { qualify } from "./config.js";

/**
 * Evidence retention and legal holds (docs/implementation/data-stores-plan.md §3.6, phase 5).
 *
 * Retention: registration assigns every evidence object its class's rule (migration 016). This
 * module's job sets closure-based dates once a case closes and tells storage the longest date
 * any assignment of an artifact asks for, never shortening it; until a case closes, storage
 * keeps the bytes at least `registration + keep`, a floor the final date can only exceed.
 *
 * Legal holds: a person with Legal.HoldOfficer places a hold over cases through case-api, and a
 * different person releases it. Every artifact of those cases, and any evidence registered into
 * them while the hold is active, is a hold target; the job sets and clears the blob's legal hold.
 * The case ledger records the hold and its release without the matter reference.
 */

export type LegalHold = {
  holdId: string;
  matterRef: string;
  caseIds: string[];
  authority: Record<string, unknown>;
  placedBy: string;
  placedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  targets: { pending: number; applied: number; notEnforced: number; failed: number; released: number };
};

type HoldRow = {
  hold_id: string; matter_ref: string; case_ids: string[]; authority: Record<string, unknown>;
  placed_by: string; placed_at: Date; released_by: string | null; released_at: Date | null;
  pending?: string; applied?: string; not_enforced?: string; failed?: string; released?: string;
};

function holdView(row: HoldRow): LegalHold {
  return {
    holdId: row.hold_id, matterRef: row.matter_ref, caseIds: row.case_ids, authority: row.authority,
    placedBy: row.placed_by, placedAt: row.placed_at.toISOString(),
    releasedBy: row.released_by, releasedAt: row.released_at?.toISOString() ?? null,
    targets: {
      pending: Number(row.pending ?? 0), applied: Number(row.applied ?? 0), notEnforced: Number(row.not_enforced ?? 0),
      failed: Number(row.failed ?? 0), released: Number(row.released ?? 0),
    },
  };
}

async function readHold(client: Pick<PoolClient, "query">, store: CaseStore, tenantId: string, holdId: string): Promise<LegalHold | null> {
  const row = (await client.query<HoldRow>(`
    select h.*,
      count(*) filter (where t.storage_state = 'PENDING') as pending,
      count(*) filter (where t.storage_state = 'APPLIED') as applied,
      count(*) filter (where t.storage_state = 'NOT_ENFORCED') as not_enforced,
      count(*) filter (where t.storage_state = 'FAILED') as failed,
      count(*) filter (where t.storage_state = 'RELEASED') as released
    from ${qualify(store.schemas.evidence, "legal_holds")} h
    left join ${qualify(store.schemas.evidence, "legal_hold_targets")} t on t.tenant_id = h.tenant_id and t.hold_id = h.hold_id
    where h.tenant_id = $1 and h.hold_id = $2
    group by h.tenant_id, h.hold_id
  `, [tenantId, holdId])).rows[0];
  return row ? holdView(row) : null;
}

/** Lock the cases in a stable order (no deadlock between two holds over overlapping cases). */
async function lockCases(client: PoolClient, store: CaseStore, tenantId: string, caseIds: string[]): Promise<LockedCase[]> {
  const rows = (await client.query<LockedCase>(`
    select * from ${qualify(store.schemas.core, "cases")} where tenant_id = $1 and case_id = any($2::text[])
    order by case_id for update
  `, [tenantId, caseIds])).rows;
  if (rows.length !== caseIds.length) throw new CaseStoreError("case.not_found", 404);
  return rows;
}

/**
 * Place a hold over cases. `idempotencyKey` names the hold: the same request again returns it,
 * a different request under the same key is refused.
 */
export async function placeLegalHold(store: CaseStore, tenantId: string, idempotencyKey: string, input: {
  matterRef: string; caseIds: string[]; authority: Record<string, unknown>; placedBy: string;
}): Promise<{ hold: LegalHold; created: boolean }> {
  if (!idempotencyKey) throw new CaseStoreError("legal_hold.idempotency_key_required", 400);
  const caseIds = [...new Set(input.caseIds)].sort();
  if (!caseIds.length || caseIds.length > 500) throw new CaseStoreError("legal_hold.scope_invalid", 400);
  const holdId = `hold_${stableDigest({ tenantId, idempotencyKey }).slice(0, 32)}`;
  return withCaseTenant(store, tenantId, async (client) => {
    const holds = qualify(store.schemas.evidence, "legal_holds");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${tenantId}:${holdId}`]);
    const prior = (await client.query<HoldRow>(`select * from ${holds} where tenant_id = $1 and hold_id = $2`, [tenantId, holdId])).rows[0];
    if (prior) {
      if (prior.matter_ref !== input.matterRef || stableDigest([...prior.case_ids].sort()) !== stableDigest(caseIds) || prior.placed_by !== input.placedBy) {
        throw new CaseStoreError("legal_hold.idempotency_conflict", 409);
      }
      return { hold: (await readHold(client, store, tenantId, holdId))!, created: false };
    }
    const cases = await lockCases(client, store, tenantId, caseIds);
    await client.query(`
      insert into ${holds}(tenant_id, hold_id, matter_ref, case_ids, authority, placed_by)
      values ($1, $2, $3, $4::text[], $5::jsonb, $6)
    `, [tenantId, holdId, input.matterRef, caseIds, JSON.stringify(input.authority), input.placedBy]);
    await client.query(`
      insert into ${qualify(store.schemas.evidence, "legal_hold_targets")}(tenant_id, hold_id, artifact_digest)
      select distinct a.tenant_id, $2, a.artifact_digest
      from ${qualify(store.schemas.evidence, "evidence_objects")} e
      join ${qualify(store.schemas.evidence, "artifacts")} a on a.tenant_id = e.tenant_id and a.artifact_ref = e.artifact_ref
      where e.tenant_id = $1 and e.case_id = any($3::text[])
      on conflict do nothing
    `, [tenantId, holdId, caseIds]);
    for (const current of cases) {
      // The ledger says a hold exists and who placed it; the matter stays with legal.
      await appendLockedCaseEvent(client, store, current, {
        eventType: "legal_hold.placed",
        eventSchema: "harness.legal_hold.placed.v1",
        payload: { holdId, caseCount: caseIds.length },
        evidenceRefs: [],
        actor: { type: "HUMAN", principalId: input.placedBy, roles: ["Legal.HoldOfficer"] },
        commandId: `lhold_${stableDigest({ holdId, caseId: current.case_id, action: "placed" }).slice(0, 32)}`,
        authority: { process: "legal_hold.place", holdId },
      });
    }
    return { hold: (await readHold(client, store, tenantId, holdId))!, created: true };
  });
}

/** Release a hold. Whoever placed it cannot; releasing it twice returns the first release. */
export async function releaseLegalHold(store: CaseStore, tenantId: string, holdId: string, input: {
  releasedBy: string; authority: Record<string, unknown>;
}): Promise<{ hold: LegalHold; released: boolean }> {
  return withCaseTenant(store, tenantId, async (client) => {
    const holds = qualify(store.schemas.evidence, "legal_holds");
    const current = (await client.query<HoldRow>(`select * from ${holds} where tenant_id = $1 and hold_id = $2 for update`, [tenantId, holdId])).rows[0];
    if (!current) throw new CaseStoreError("legal_hold.not_found", 404);
    if (current.released_by) {
      if (current.released_by !== input.releasedBy) throw new CaseStoreError("legal_hold.already_released", 409);
      return { hold: (await readHold(client, store, tenantId, holdId))!, released: false };
    }
    if (current.placed_by === input.releasedBy) throw new CaseStoreError("legal_hold.release_requires_second_person", 403);
    const cases = await lockCases(client, store, tenantId, [...current.case_ids].sort());
    await client.query(`
      update ${holds} set released_by = $3, released_at = clock_timestamp(), release_authority = $4::jsonb
      where tenant_id = $1 and hold_id = $2
    `, [tenantId, holdId, input.releasedBy, JSON.stringify(input.authority)]);
    for (const locked of cases) {
      await appendLockedCaseEvent(client, store, locked, {
        eventType: "legal_hold.released",
        eventSchema: "harness.legal_hold.released.v1",
        payload: { holdId },
        evidenceRefs: [],
        actor: { type: "HUMAN", principalId: input.releasedBy, roles: ["Legal.HoldOfficer"] },
        commandId: `lhold_${stableDigest({ holdId, caseId: locked.case_id, action: "released" }).slice(0, 32)}`,
        authority: { process: "legal_hold.release", holdId },
      });
    }
    return { hold: (await readHold(client, store, tenantId, holdId))!, released: true };
  });
}

export async function getLegalHold(store: CaseStore, tenantId: string, holdId: string): Promise<LegalHold | null> {
  return withCaseTenant(store, tenantId, (client) => readHold(client, store, tenantId, holdId), { readOnly: true });
}

export async function listLegalHolds(store: CaseStore, tenantId: string, options: { active?: boolean; caseId?: string } = {}): Promise<LegalHold[]> {
  return withCaseTenant(store, tenantId, async (client) => {
    const ids = (await client.query<{ hold_id: string }>(`
      select hold_id from ${qualify(store.schemas.evidence, "legal_holds")}
      where tenant_id = $1 and ($2::boolean is null or (released_at is null) = $2) and ($3::text is null or case_ids @> array[$3::text])
      order by placed_at desc limit 500
    `, [tenantId, options.active ?? null, options.caseId ?? null])).rows;
    const result: LegalHold[] = [];
    for (const { hold_id } of ids) result.push((await readHold(client, store, tenantId, hold_id))!);
    return result;
  }, { readOnly: true });
}

/** Whether any active hold covers the case (the context release job refuses while one does). */
export async function caseUnderLegalHold(client: Pick<PoolClient, "query">, store: CaseStore, tenantId: string, caseId: string): Promise<boolean> {
  return (await client.query(`
    select 1 from ${qualify(store.schemas.evidence, "legal_holds")}
    where tenant_id = $1 and released_at is null and case_ids @> array[$2::text] limit 1
  `, [tenantId, caseId])).rowCount! > 0;
}

export type GovernanceOutcome = {
  tenantId: string;
  skipped?: "already_running";
  datesSet: number;
  retention: { applied: number; locked: number; notEnforced: number; failed: number };
  holds: { applied: number; notEnforced: number; released: number; failed: number };
};

type ArtifactRow = {
  artifact_digest: string; backend: string; storage_account: string | null; container: string | null; blob_name: string | null;
};

/** Where an artifact's blob is, when it is in the configured container; otherwise why not. */
function blobOf(row: ArtifactRow, blobs: BlobContainer | undefined): string | null {
  if (row.backend !== "object_store") return null;
  if (!blobs || row.storage_account !== blobs.account || row.container !== blobs.container || !row.blob_name) {
    throw new CaseStoreError("evidence.blob_container_mismatch", 500);
  }
  return row.blob_name;
}

/**
 * One governance pass over a tenant's evidence: closure dates, storage retention, legal holds.
 * Runs under the tenant's advisory lock (a second concurrent run returns `skipped`). A storage
 * failure marks that artifact FAILED and is retried by the next run; it does not stop the pass.
 */
export async function governTenantEvidence(store: CaseStore, tenantId: string, options: { blobs?: BlobContainer; limit?: number } = {}): Promise<GovernanceOutcome> {
  const blobs = options.blobs ?? store.evidenceBlobs;
  const limit = options.limit ?? 1000;
  const e = (name: string) => qualify(store.schemas.evidence, name);
  const outcome: GovernanceOutcome = {
    tenantId, datesSet: 0,
    retention: { applied: 0, locked: 0, notEnforced: 0, failed: 0 },
    holds: { applied: 0, notEnforced: 0, released: 0, failed: 0 },
  };
  return withCaseTenant(store, tenantId, async (client) => {
    const locked = (await client.query<{ ok: boolean }>("select pg_try_advisory_xact_lock(hashtext($1)) as ok", [`evidence-governance:${tenantId}`])).rows[0]!.ok;
    if (!locked) return { ...outcome, skipped: "already_running" };

    // 1. Closure-based dates, from the case's latest close. Only ever later (the guard trigger agrees).
    outcome.datesSet = (await client.query(`
      with closed as (
        select c.case_id, max(ev.recorded_at) as closed_at
        from ${qualify(store.schemas.core, "cases")} c
        join ${qualify(store.schemas.ledger, "case_events")} ev on ev.tenant_id = c.tenant_id and ev.case_id = c.case_id
        where c.tenant_id = $1 and c.status = 'CLOSED'
          and ev.event_type = 'case.status_transitioned' and ev.payload->>'to' = 'CLOSED'
        group by c.case_id
      )
      update ${e("retention_assignments")} a set basis_at = closed.closed_at, retain_until = closed.closed_at + r.keep
      from closed, ${e("retention_rules")} r
      where a.tenant_id = $1 and a.case_id = closed.case_id and a.basis = 'CASE_CLOSED' and r.retention_class = a.retention_class
        and (a.retain_until is null or a.retain_until < closed.closed_at + r.keep)
    `, [tenantId])).rowCount ?? 0;

    // 2. Storage retention: the longest date any assignment asks for (the registration floor for
    //    one whose case is still open), locked when any of its classes locks.
    const due = (await client.query<ArtifactRow & { until: Date; lock: boolean }>(`
      with wanted as (
        select a.tenant_id, a.artifact_digest,
               max(coalesce(a.retain_until, a.assigned_at + r.keep)) as exact, bool_or(r.lock_policy) as lock
        from ${e("retention_assignments")} a join ${e("retention_rules")} r on r.retention_class = a.retention_class
        where a.tenant_id = $1
        group by a.tenant_id, a.artifact_digest
      ), wanted_ms as (
        -- Storage and JavaScript dates hold milliseconds: round up, never down.
        select tenant_id, artifact_digest, lock,
               date_trunc('milliseconds', exact) + case when exact > date_trunc('milliseconds', exact) then interval '1 millisecond' else interval '0' end as until
        from wanted
      )
      select ar.artifact_digest, ar.backend, ar.storage_account, ar.container, ar.blob_name, w.until, w.lock
      from wanted_ms w join ${e("artifacts")} ar on ar.tenant_id = w.tenant_id and ar.artifact_digest = w.artifact_digest
      where ar.retention_state in ('PENDING', 'FAILED')
         or ar.retain_until is null or ar.retain_until < w.until
         or (w.lock and ar.retention_state = 'APPLIED')
      order by ar.artifact_digest limit $2
    `, [tenantId, limit])).rows;
    for (const row of due) {
      let state: "APPLIED" | "LOCKED" | "NOT_ENFORCED" | "FAILED";
      try {
        const name = blobOf(row, blobs);
        const result: PolicyResult = name ? await blobs!.setRetention(name, row.until, row.lock) : { applied: false, state: "NOT_ENFORCED" };
        state = !result.applied ? "NOT_ENFORCED" : row.lock ? "LOCKED" : "APPLIED";
      } catch {
        state = "FAILED";
      }
      outcome.retention[state === "APPLIED" ? "applied" : state === "LOCKED" ? "locked" : state === "NOT_ENFORCED" ? "notEnforced" : "failed"] += 1;
      await client.query(`
        update ${e("artifacts")} set retention_state = $3, governed_at = clock_timestamp(),
          retain_until = case when $3 = 'FAILED' then retain_until else greatest(coalesce(retain_until, $4), $4) end
        where tenant_id = $1 and artifact_digest = $2
      `, [tenantId, row.artifact_digest, state, row.until]);
    }

    // 3a. Holds to set: targets of active holds not yet applied.
    const toHold = (await client.query<ArtifactRow>(`
      select distinct ar.artifact_digest, ar.backend, ar.storage_account, ar.container, ar.blob_name
      from ${e("legal_hold_targets")} t
      join ${e("legal_holds")} h on h.tenant_id = t.tenant_id and h.hold_id = t.hold_id and h.released_at is null
      join ${e("artifacts")} ar on ar.tenant_id = t.tenant_id and ar.artifact_digest = t.artifact_digest
      where t.tenant_id = $1 and t.storage_state in ('PENDING', 'FAILED')
      order by ar.artifact_digest limit $2
    `, [tenantId, limit])).rows;
    for (const row of toHold) {
      let state: "APPLIED" | "NOT_ENFORCED" | "FAILED";
      try {
        const name = blobOf(row, blobs);
        const result: PolicyResult = name ? await blobs!.setLegalHold(name, true) : { applied: false, state: "NOT_ENFORCED" };
        state = result.applied ? "APPLIED" : "NOT_ENFORCED";
      } catch {
        state = "FAILED";
      }
      outcome.holds[state === "APPLIED" ? "applied" : state === "NOT_ENFORCED" ? "notEnforced" : "failed"] += 1;
      await client.query(`
        update ${e("legal_hold_targets")} t set storage_state = $3, applied_at = case when $3 = 'FAILED' then null else clock_timestamp() end
        from ${e("legal_holds")} h
        where t.tenant_id = $1 and t.artifact_digest = $2 and t.storage_state in ('PENDING', 'FAILED')
          and h.tenant_id = t.tenant_id and h.hold_id = t.hold_id and h.released_at is null
      `, [tenantId, row.artifact_digest, state]);
      await client.query(`update ${e("artifacts")} set legal_hold_state = $3, governed_at = clock_timestamp() where tenant_id = $1 and artifact_digest = $2`,
        [tenantId, row.artifact_digest, state === "APPLIED" ? "HELD" : state]);
    }

    // 3b. Holds to clear: targets of released holds. Storage keeps the blob's hold while any
    //     other active hold still targets it.
    const toRelease = (await client.query<ArtifactRow & { still_held: boolean }>(`
      select distinct ar.artifact_digest, ar.backend, ar.storage_account, ar.container, ar.blob_name,
        exists (select 1 from ${e("legal_hold_targets")} o join ${e("legal_holds")} oh on oh.tenant_id = o.tenant_id and oh.hold_id = o.hold_id
                where o.tenant_id = t.tenant_id and o.artifact_digest = t.artifact_digest and oh.released_at is null) as still_held
      from ${e("legal_hold_targets")} t
      join ${e("legal_holds")} h on h.tenant_id = t.tenant_id and h.hold_id = t.hold_id and h.released_at is not null
      join ${e("artifacts")} ar on ar.tenant_id = t.tenant_id and ar.artifact_digest = t.artifact_digest
      where t.tenant_id = $1 and t.storage_state <> 'RELEASED'
      order by ar.artifact_digest limit $2
    `, [tenantId, limit])).rows;
    for (const row of toRelease) {
      if (!row.still_held) {
        try {
          const name = blobOf(row, blobs);
          if (name) await blobs!.setLegalHold(name, false);
        } catch {
          outcome.holds.failed += 1;
          continue;
        }
        await client.query(`update ${e("artifacts")} set legal_hold_state = 'NONE', governed_at = clock_timestamp() where tenant_id = $1 and artifact_digest = $2`,
          [tenantId, row.artifact_digest]);
      }
      await client.query(`
        update ${e("legal_hold_targets")} t set storage_state = 'RELEASED'
        from ${e("legal_holds")} h
        where t.tenant_id = $1 and t.artifact_digest = $2 and t.storage_state <> 'RELEASED'
          and h.tenant_id = t.tenant_id and h.hold_id = t.hold_id and h.released_at is not null
      `, [tenantId, row.artifact_digest]);
      outcome.holds.released += 1;
    }
    return outcome;
  });
}

export type ReconciliationFinding = {
  kind: "missing_blob" | "orphan_blob" | "length_mismatch" | "digest_mismatch" | "policy_mismatch";
  name: string;
  artifactDigest?: string;
  detail?: string;
};

export type ReconciliationReport = {
  runId: string;
  tenantId: string;
  checked: number;
  verified: number;
  missingBlob: number;
  orphanBlob: number;
  lengthMismatch: number;
  digestMismatch: number;
  policyMismatch: number;
  findings: ReconciliationFinding[];
};

const FINDINGS_KEPT = 200;

/**
 * Compare a tenant's blobs with its artifact rows and record the run. Every artifact is checked
 * against the listing (present, length, recorded digest, and, with object lock,
 * that storage carries the retention and hold the row says it was given); `verifySample`
 * artifacts, least recently verified first, are downloaded and hashed. Reports only.
 */
export async function reconcileTenantEvidence(store: CaseStore, tenantId: string, options: { blobs?: BlobContainer; verifySample?: number } = {}): Promise<ReconciliationReport> {
  const blobs = options.blobs ?? store.evidenceBlobs;
  if (!blobs) throw new CaseStoreError("evidence.blob_container_missing", 500);
  const e = (name: string) => qualify(store.schemas.evidence, name);
  const runId = `recon_${randomUUID()}`;
  await withCaseTenant(store, tenantId, (client) => client.query(`insert into ${e("reconciliation_runs")}(tenant_id, run_id, container) values ($1, $2, $3)`,
    [tenantId, runId, `${blobs.account}/${blobs.container}`]));
  const rows = await withCaseTenant(store, tenantId, async (client) => (await client.query<{
    artifact_digest: string; byte_length: string; blob_name: string; retain_until: Date | null; retention_state: string; legal_hold_state: string;
  }>(`
    select artifact_digest, byte_length, blob_name, retain_until, retention_state, legal_hold_state
    from ${e("artifacts")}
    where tenant_id = $1 and backend = 'object_store' and storage_account = $2 and container = $3
    order by verified_at nulls first, artifact_digest
  `, [tenantId, blobs.account, blobs.container])).rows, { readOnly: true });

  const listed = new Map<string, ListedBlob>();
  for await (const item of blobs.list(tenantEvidencePrefix(tenantId))) listed.set(item.name, item);

  const report: ReconciliationReport = {
    runId, tenantId, checked: rows.length, verified: 0, missingBlob: 0, orphanBlob: 0, lengthMismatch: 0, digestMismatch: 0, policyMismatch: 0, findings: [],
  };
  const counter = { missing_blob: "missingBlob", orphan_blob: "orphanBlob", length_mismatch: "lengthMismatch", digest_mismatch: "digestMismatch", policy_mismatch: "policyMismatch" } as const;
  const found = (finding: ReconciliationFinding) => {
    report[counter[finding.kind]] += 1;
    if (report.findings.length < FINDINGS_KEPT) report.findings.push(finding);
  };
  const policies = blobs.immutability === "object_lock";
  const intact: typeof rows = [];
  for (const row of rows) {
    const blob = listed.get(row.blob_name);
    listed.delete(row.blob_name);
    const where = { name: row.blob_name, artifactDigest: row.artifact_digest };
    if (!blob) { found({ kind: "missing_blob", ...where }); continue; }
    let ok = true;
    if (blob.length !== Number(row.byte_length)) { found({ kind: "length_mismatch", ...where, detail: `${blob.length} != ${row.byte_length}` }); ok = false; }
    if (blob.sha256 !== row.artifact_digest) { found({ kind: "digest_mismatch", ...where, detail: "recorded digest" }); ok = false; }
    if (policies) {
      const retained = row.retention_state === "APPLIED" || row.retention_state === "LOCKED";
      if (retained && (!blob.retainUntil || (row.retain_until && blob.retainUntil < row.retain_until))) {
        found({ kind: "policy_mismatch", ...where, detail: "retention shorter than recorded" });
      } else if (row.retention_state === "LOCKED" && String(blob.retentionMode ?? "").toLowerCase() !== "locked") {
        found({ kind: "policy_mismatch", ...where, detail: "retention not locked" });
      }
      if (row.legal_hold_state === "HELD" && !blob.legalHold) found({ kind: "policy_mismatch", ...where, detail: "legal hold missing" });
      if (row.legal_hold_state === "NONE" && blob.legalHold) found({ kind: "policy_mismatch", ...where, detail: "legal hold not recorded" });
    }
    if (ok) intact.push(row);
  }
  for (const name of listed.keys()) found({ kind: "orphan_blob", name });

  const verifiedDigests: string[] = [];
  for (const row of intact.slice(0, options.verifySample ?? 50)) {
    const bytes = await blobs.get(row.blob_name).catch(() => null);
    if (!bytes) { found({ kind: "missing_blob", name: row.blob_name, artifactDigest: row.artifact_digest }); continue; }
    if (createHash("sha256").update(bytes).digest("hex") !== row.artifact_digest) {
      found({ kind: "digest_mismatch", name: row.blob_name, artifactDigest: row.artifact_digest, detail: "content" });
      continue;
    }
    verifiedDigests.push(row.artifact_digest);
  }
  report.verified = verifiedDigests.length;

  await withCaseTenant(store, tenantId, async (client) => {
    if (verifiedDigests.length) {
      await client.query(`update ${e("artifacts")} set verified_at = clock_timestamp() where tenant_id = $1 and artifact_digest = any($2::text[])`, [tenantId, verifiedDigests]);
    }
    await client.query(`
      update ${e("reconciliation_runs")} set finished_at = clock_timestamp(), checked = $3, verified = $4, missing_blob = $5,
        orphan_blob = $6, length_mismatch = $7, digest_mismatch = $8, policy_mismatch = $9, findings = $10::jsonb
      where tenant_id = $1 and run_id = $2
    `, [tenantId, runId, report.checked, report.verified, report.missingBlob, report.orphanBlob, report.lengthMismatch,
      report.digestMismatch, report.policyMismatch, JSON.stringify(report.findings)]);
  });
  return report;
}

/** Govern, then reconcile, every listed tenant (EVIDENCE_RETENTION_TENANTS) once. */
export async function main(): Promise<void> {
  const tenants = (process.env.EVIDENCE_RETENTION_TENANTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!tenants.length) throw new Error("evidence_retention.tenants_missing");
  const store = createCaseStore();
  try {
    for (const tenantId of tenants) {
      const governed = await governTenantEvidence(store, tenantId);
      process.stdout.write(`${JSON.stringify(governed)}\n`);
      if (store.evidenceBlobs) {
        const { findings, ...counts } = await reconcileTenantEvidence(store, tenantId, { verifySample: Number(process.env.EVIDENCE_VERIFY_SAMPLE ?? 50) });
        process.stdout.write(`${JSON.stringify({ ...counts, firstFindings: findings.slice(0, 5) })}\n`);
      }
    }
  } finally {
    await store.db.end();
  }
}

if (import.meta.main ?? (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) await main();
