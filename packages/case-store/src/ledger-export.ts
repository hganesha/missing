import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stableDigest } from "@ehf/contracts";
import { blobContainerFromEnv, type BlobContainer } from "@ehf/blob-store";
import { createPrivateKeyJwtSignerFromEnv, isProductionProfile } from "@ehf/identity";
import { createCaseStore, withCaseTenant, CaseStoreError, type CaseStore } from "./index.js";
import { qualify } from "./config.js";
import {
  manifestBytes, merkleRoot, renderSegmentEvents, sha256Hex, SEGMENT_SCHEMA,
  type CaseRange, type SegmentEvent, type SegmentManifest, type SignedManifest,
} from "./ledger-segment.js";

/**
 * The ledger exporter: writes a tenant's new ledger events as a signed segment
 * (ledger-segment.ts) to an export store outside the database, and records the segment.
 *
 * Segments follow per-case sequences, not time: each run takes, for every case, the
 * events after that case's export cursor. Sequences are gapless and assigned under the
 * case row lock, so an event that commits late is exported by the next run rather than
 * skipped. Runs for one tenant are serialized by an advisory lock.
 */

/** RS256 over arbitrary bytes. Same shape as the private-key signer in @ehf/identity. */
export type SegmentSigner = { algorithm: "RS256"; keyId: string; sign(bytes: Uint8Array): Promise<Uint8Array> };

/** Where segment bytes go. Production points this at immutable storage (data-stores-plan §3.6). */
export type SegmentStore = { write(name: string, bytes: Uint8Array): Promise<string> };

export function createPemSegmentSigner(privateKeyPem: string, keyId: string): SegmentSigner {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "rsa") throw new Error("ledger_export.rsa_key_required");
  if (!keyId) throw new Error("ledger_export.key_id_required");
  return { algorithm: "RS256", keyId, sign: async (bytes) => sign("sha256", bytes, key) };
}

/** A directory store that never overwrites: an existing file is an error, not a replacement. */
export function createFileSegmentStore(directory: string): SegmentStore {
  return {
    async write(name, bytes) {
      const path = join(directory, name);
      // Owner-only: segments are signed audit records, not shared files.
      await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      return pathToFileURL(path).href;
    },
  };
}

/**
 * Segments in the audit account's ledger export container (data-stores-plan.md §3.6), which is
 * locked container-level WORM: names are unique per segment and a write never replaces bytes.
 */
export function createBlobSegmentStore(blobs: BlobContainer): SegmentStore {
  return {
    async write(name, bytes) {
      const stored = await blobs.putImmutable(name, bytes, {
        contentType: name.endsWith(".json") ? "application/json" : "application/x-ndjson",
        sha256: sha256Hex(bytes),
      });
      return `artifact://object-store/${stored.account}/${stored.container}/${stored.name}`;
    },
  };
}

/** The ledger export container (LEDGER_EXPORT_BLOB_*), else LEDGER_EXPORT_DIR outside production. */
export function segmentStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SegmentStore {
  const blobs = blobContainerFromEnv("LEDGER_EXPORT", env);
  if (blobs) return createBlobSegmentStore(blobs);
  if (isProductionProfile(env)) throw new Error("ledger_export.blob_required_in_production");
  const directory = env.LEDGER_EXPORT_DIR;
  if (!directory) throw new Error("ledger_export.directory_missing");
  return createFileSegmentStore(directory);
}

type EventRow = {
  tenant_id: string; case_id: string; case_sequence: string | number; event_id: string; event_type: string;
  event_schema: string; occurred_at: Date | null; recorded_at: Date | null; actor: unknown; command_id: string;
  authority: unknown; payload: unknown; evidence_refs: string[]; previous_event_digest: string | null; event_digest: string;
  cursor_sequence: string | number | null; cursor_digest: string | null;
};

export type ExportedSegment = SignedManifest & { eventsRef: string; manifestRef: string };

/** Export the tenant's next segment, or return null when every case is already exported. */
export async function exportLedgerSegment(
  store: CaseStore,
  input: { tenantId: string; signer: SegmentSigner; sink: SegmentStore; maxEvents?: number },
): Promise<ExportedSegment | null> {
  const maxEvents = Math.max(1, Math.min(input.maxEvents ?? 10_000, 100_000));
  const ledger = (table: string) => qualify(store.schemas.ledger, table);
  return withCaseTenant(store, input.tenantId, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`ledger-export:${input.tenantId}`]);
    const previous = await client.query<{ segment_id: string; segment_number: string | number; manifest_digest: string }>(`
      select segment_id, segment_number, manifest_digest from ${ledger("ledger_segments")}
      where tenant_id = $1 order by segment_number desc limit 1
    `, [input.tenantId]);
    const rows = (await client.query<EventRow>(`
      select e.*, c.exported_sequence as cursor_sequence, c.head_digest as cursor_digest
      from ${ledger("case_events")} e
      left join ${ledger("export_cursors")} c on c.tenant_id = e.tenant_id and c.case_id = e.case_id
      where e.tenant_id = $1 and e.case_sequence > coalesce(c.exported_sequence, 0)
      order by e.case_id, e.case_sequence
      limit $2
    `, [input.tenantId, maxEvents])).rows;
    if (!rows.length) return null;

    const events: SegmentEvent[] = [];
    const ranges = new Map<string, CaseRange>();
    for (const row of rows) {
      const event: SegmentEvent = {
        eventId: row.event_id, tenantId: row.tenant_id, caseId: row.case_id, caseSequence: Number(row.case_sequence),
        eventType: row.event_type, eventSchema: row.event_schema,
        occurredAt: row.occurred_at ? row.occurred_at.toISOString() : null,
        recordedAt: row.recorded_at ? row.recorded_at.toISOString() : null,
        actor: row.actor, commandRef: row.command_id, authority: row.authority, payload: row.payload,
        evidenceRefs: row.evidence_refs, previousEventDigest: row.previous_event_digest, eventDigest: row.event_digest,
      };
      // The links are stored verbatim, so a break here is a break in the database itself.
      // Content digests are recomputed by the verifier, which reports rather than refuses.
      const range = ranges.get(event.caseId);
      const expected = range
        ? { sequence: range.toSequence + 1, digest: range.headDigest }
        : { sequence: Number(row.cursor_sequence ?? 0) + 1, digest: row.cursor_digest };
      if (event.caseSequence !== expected.sequence || event.previousEventDigest !== expected.digest) {
        throw new CaseStoreError("ledger_export.chain_broken", 500, { caseId: event.caseId, caseSequence: event.caseSequence });
      }
      if (range) { range.toSequence = event.caseSequence; range.headDigest = event.eventDigest; }
      else ranges.set(event.caseId, { caseId: event.caseId, fromSequence: event.caseSequence, toSequence: event.caseSequence, anchorDigest: event.previousEventDigest, headDigest: event.eventDigest });
      events.push(event);
    }

    const segmentId = `seg_${randomUUID()}`;
    const segmentNumber = Number(previous.rows[0]?.segment_number ?? 0) + 1;
    const eventsText = renderSegmentEvents(events);
    const manifest: SegmentManifest = {
      schema: SEGMENT_SCHEMA,
      tenantId: input.tenantId,
      segmentId,
      segmentNumber,
      previousSegmentId: previous.rows[0]?.segment_id ?? null,
      previousManifestDigest: previous.rows[0]?.manifest_digest ?? null,
      eventCount: events.length,
      caseRanges: [...ranges.values()],
      merkleRoot: merkleRoot(events.map((event) => event.eventDigest)),
      eventsDigest: sha256Hex(eventsText),
      algorithm: "RS256",
      signingKeyId: input.signer.keyId,
      createdAt: new Date().toISOString(),
    };
    const manifestDigest = stableDigest(manifest);
    const signature = Buffer.from(await input.signer.sign(manifestBytes(manifest))).toString("base64url");
    const signed: SignedManifest = { manifest, manifestDigest, signature };

    // Bytes first, record second: a crash in between leaves an unreferenced file under a
    // fresh segment id, never a recorded segment without its bytes.
    const base = `${encodeURIComponent(input.tenantId)}/${String(segmentNumber).padStart(8, "0")}-${segmentId}`;
    const eventsRef = await input.sink.write(`${base}.ndjson`, Buffer.from(eventsText, "utf8"));
    const manifestRef = await input.sink.write(`${base}.manifest.json`, Buffer.from(JSON.stringify(signed, null, 2) + "\n", "utf8"));

    await client.query(`
      insert into ${ledger("ledger_segments")}(
        tenant_id, segment_id, segment_number, previous_segment_id, event_count, case_ranges, merkle_root,
        events_digest, manifest_digest, signature, signing_key_id, algorithm, export_ref)
      values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, 'RS256', $12)
    `, [input.tenantId, segmentId, segmentNumber, manifest.previousSegmentId, events.length, JSON.stringify(manifest.caseRanges),
      manifest.merkleRoot, manifest.eventsDigest, manifestDigest, signature, input.signer.keyId, manifestRef]);
    for (const range of ranges.values()) {
      await client.query(`
        insert into ${ledger("export_cursors")}(tenant_id, case_id, exported_sequence, head_digest, segment_id, updated_at)
        values ($1, $2, $3, $4, $5, clock_timestamp())
        on conflict (tenant_id, case_id) do update
        set exported_sequence = excluded.exported_sequence, head_digest = excluded.head_digest,
            segment_id = excluded.segment_id, updated_at = excluded.updated_at
      `, [input.tenantId, range.caseId, range.toSequence, range.headDigest, segmentId]);
    }
    return { ...signed, eventsRef, manifestRef };
  }, { repeatableRead: true });
}

/**
 * The signer named by LEDGER_EXPORT_SIGNER: an inline PEM key in development, or (production)
 * a private key mounted as a file -- LEDGER_EXPORT_PRIVATE_KEY_FILE and LEDGER_EXPORT_KEY_ID,
 * from any secret manager or KMS export, like every other platform signer.
 */
export function ledgerExportSignerFromEnv(env: NodeJS.ProcessEnv = process.env): SegmentSigner {
  const mechanism = env.LEDGER_EXPORT_SIGNER ?? (isProductionProfile(env) ? "private_key" : "pem");
  if (mechanism === "pem") {
    if (isProductionProfile(env)) throw new Error("ledger_export.pem_signer_forbidden_in_production");
    const pem = env.LEDGER_EXPORT_PRIVATE_KEY_PEM;
    if (!pem) throw new Error("ledger_export.private_key_missing");
    return createPemSegmentSigner(pem, env.LEDGER_EXPORT_KEY_ID ?? "local-ledger-export");
  }
  if (mechanism === "private_key") return createPrivateKeyJwtSignerFromEnv("LEDGER_EXPORT", env);
  throw new Error(`ledger_export.signer_unsupported:${mechanism}`);
}

/** Export every listed tenant until each is fully exported. */
export async function main(): Promise<void> {
  const tenants = (process.env.LEDGER_EXPORT_TENANTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!tenants.length) throw new Error("ledger_export.tenants_missing");
  const signer = ledgerExportSignerFromEnv();
  const sink = segmentStoreFromEnv();
  const store = createCaseStore();
  try {
    for (const tenantId of tenants) {
      let exported = 0;
      for (let segment = await exportLedgerSegment(store, { tenantId, signer, sink }); segment;
        segment = await exportLedgerSegment(store, { tenantId, signer, sink })) {
        exported += 1;
        process.stdout.write(`${tenantId}: segment ${segment.manifest.segmentNumber} (${segment.manifest.eventCount} events) -> ${segment.manifestRef}\n`);
      }
      if (!exported) process.stdout.write(`${tenantId}: nothing to export\n`);
    }
  } finally {
    await store.db.end();
  }
}

if (import.meta.main ?? (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) await main();
