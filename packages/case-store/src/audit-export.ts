import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { stableDigest } from "@ehf/contracts";
import { artifactBytes, bindCaseTenant, CaseStoreError, withCaseTenant, type CaseStore } from "./index.js";
import { qualify } from "./config.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export type AuditPackage = {
  schema: "kyc.audit-package.v1"; tenantId: string; caseId: string; caseSequence: number;
  sections: Record<string, unknown[]>; sectionDigests: Record<string, string>;
  ledger: { valid: true; eventCount: number; headDigest: string | null };
};
export function verifyAuditEvents(events: Record<string, unknown>[], sequence: number) {
  let previous: unknown = null;
  for (const [index, event] of events.entries()) {
    const envelope = { eventId: event.event_id, tenantId: event.tenant_id, caseId: event.case_id,
      caseSequence: Number(event.case_sequence), eventType: event.event_type, eventSchema: event.event_schema,
      occurredAt: event.occurred_at instanceof Date ? event.occurred_at.toISOString() : event.occurred_at,
      recordedAt: event.recorded_at instanceof Date ? event.recorded_at.toISOString() : event.recorded_at,
      actor: event.actor, commandRef: event.command_id, authority: event.authority, payload: event.payload,
      evidenceRefs: event.evidence_refs, previousEventDigest: event.previous_event_digest };
    if (Number(event.case_sequence) !== index + 1 || event.previous_event_digest !== previous || stableDigest(envelope) !== event.event_digest) {
      throw new CaseStoreError("audit.ledger_integrity_failed", 409);
    }
    previous = event.event_digest;
  }
  if (events.length !== sequence) throw new CaseStoreError("audit.ledger_incomplete", 409);
  return { valid: true as const, eventCount: events.length, headDigest: previous as string | null };
}

/** One repeatable-read transaction freezes all rows and verifies evidence bytes before persistence. */
export async function createAuditExport(store: CaseStore, tenantId: string, caseId: string) {
  const client = await store.db.connect();
  try {
    await client.query("begin isolation level repeatable read");
    await bindCaseTenant(client, tenantId);
    const root = await client.query(`select * from ${qualify(store.schemas.core, "cases")} where tenant_id=$1 and case_id=$2`, [tenantId, caseId]);
    if (!root.rows[0]) throw new CaseStoreError("case.not_found", 404);
    const sections: Record<string, unknown[]> = { case: root.rows };
    const tables = ["case_subjects", "case_subject_identifiers", "case_risk", "case_evidence_refs", "case_claims", "case_facts", "case_findings", "case_assumptions", "case_contradictions", "case_work_items", "case_decision_recommendations", "case_gate_results", "case_reviews", "case_final_dispositions", "case_execution_refs", "policy_evaluations"];
    for (const [schema, table] of [...tables.map((table) => [store.schemas.core, table]), [store.schemas.evidence, "evidence_objects"], [store.schemas.evidence, "lineage_edges"], [store.schemas.ledger, "case_events"]]) {
      const result = await client.query(`select * from ${qualify(schema!, table!)} t where tenant_id=$1 and case_id=$2 order by to_jsonb(t)::text`, [tenantId, caseId]);
      sections[table!] = result.rows;
    }
    const events = sections.case_events as Record<string, unknown>[];
    events.sort((a, b) => Number(a.case_sequence) - Number(b.case_sequence));
    const ledger = verifyAuditEvents(events, Number(root.rows[0].case_sequence));
    const size = await client.query(`select coalesce(sum(a.byte_length),0)::text as bytes
      from ${qualify(store.schemas.evidence, "artifacts")} a where a.tenant_id=$1 and a.artifact_ref in
      (select artifact_ref from ${qualify(store.schemas.evidence, "evidence_objects")} where tenant_id=$1 and case_id=$2)`, [tenantId, caseId]);
    if (Number(size.rows[0]?.bytes ?? 0) > 50 * 1024 * 1024) throw new CaseStoreError("audit.package_too_large", 413);
    const artifacts = await client.query(`select distinct a.artifact_digest,a.artifact_ref,a.media_type,a.byte_length,a.content,
        a.backend,a.storage_account,a.container,a.blob_name
      from ${qualify(store.schemas.evidence, "artifacts")} a join ${qualify(store.schemas.evidence, "evidence_objects")} e
      on a.tenant_id=e.tenant_id and a.artifact_ref=e.artifact_ref where e.tenant_id=$1 and e.case_id=$2 order by a.artifact_digest`, [tenantId, caseId]);
    const expectedRefs = new Set((sections.evidence_objects as Record<string, unknown>[]).map((item) => item.artifact_ref));
    if (artifacts.rows.length !== expectedRefs.size) throw new CaseStoreError("audit.evidence_artifact_missing", 409);
    let bytes = 0;
    const exported: Record<string, unknown>[] = [];
    for (const artifact of artifacts.rows) {
      // Bytes come from wherever they live (database or evidence container) and are checked
      // against the registered digest and length before they enter the package.
      const content = await artifactBytes(store, { ...artifact, digest: String(artifact.artifact_digest) })
        .catch(() => { throw new CaseStoreError("audit.evidence_integrity_failed", 409); });
      bytes += content.length;
      if (bytes > 50 * 1024 * 1024) throw new CaseStoreError("audit.package_too_large", 413);
      if (content.length !== Number(artifact.byte_length)
        || createHash("sha256").update(content).digest("hex") !== String(artifact.artifact_digest).replace(/^sha256:/, "")) {
        throw new CaseStoreError("audit.evidence_integrity_failed", 409);
      }
      const { backend: _backend, storage_account: _account, container: _container, blob_name: _blob, ...record } = artifact;
      exported.push({ ...record, content: content.toString("base64"), contentEncoding: "base64" });
    }
    sections.artifacts = exported;
    // JSON normalization makes DB timestamps and numeric representations stable on replay.
    const normalized = JSON.parse(canonicalJson(sections)) as typeof sections;
    const document: AuditPackage = { schema: "kyc.audit-package.v1", tenantId, caseId, caseSequence: Number(root.rows[0].case_sequence),
      sections: normalized, sectionDigests: Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, stableDigest(value)])), ledger };
    const digest = stableDigest(document);
    await client.query(`insert into ${qualify(store.schemas.ledger, "audit_exports")}(tenant_id,case_id,export_digest,case_sequence,document)
      values($1,$2,$3,$4,$5::jsonb) on conflict do nothing`, [tenantId, caseId, digest, document.caseSequence, JSON.stringify(document)]);
    await client.query("commit");
    return { digest, document };
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export async function getAuditExport(store: CaseStore, tenantId: string, caseId: string, digest: string): Promise<AuditPackage> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new CaseStoreError("audit.digest_invalid", 400);
  const result = await withCaseTenant(store, tenantId, (client) => client.query(`select document from ${qualify(store.schemas.ledger, "audit_exports")} where tenant_id=$1 and case_id=$2 and export_digest=$3`, [tenantId, caseId, digest]), { readOnly: true });
  const document = result.rows[0]?.document;
  if (!document) throw new CaseStoreError("audit.export_not_found", 404);
  if (stableDigest(document) !== digest) throw new CaseStoreError("audit.export_corrupt", 409);
  return document;
}

export async function renderAuditExport(document: AuditPackage, format: "json" | "html" | "pdf"): Promise<Buffer> {
  const json = canonicalJson(document);
  if (format === "json") return Buffer.from(json);
  const digest = stableDigest(document);
  if (format === "html") {
    const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    return Buffer.from(`<!doctype html><html lang="en"><meta charset="utf-8"><title>KYC audit package</title><style>body{font:14px system-ui;margin:40px}pre{white-space:pre-wrap;overflow-wrap:anywhere}h1{font-size:24px}</style><h1>KYC audit package</h1><p>Case: ${escape(document.caseId)} · Sequence: ${document.caseSequence}</p><p>SHA-256: ${digest}</p><p>Ledger verified: ${document.ledger.eventCount} events</p><pre>${escape(JSON.stringify(document, null, 2))}</pre></html>`);
  }
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const epoch = new Date("2000-01-01T00:00:00.000Z");
  pdf.setTitle("KYC audit package"); pdf.setProducer("EHF audit renderer v1"); pdf.setCreator("EHF"); pdf.setCreationDate(epoch); pdf.setModificationDate(epoch);
  const font = await pdf.embedFont(StandardFonts.Courier);
  const lines = ["KYC AUDIT PACKAGE", "", `Case: ${document.caseId}`, `Tenant: ${document.tenantId}`, `Case sequence: ${document.caseSequence}`,
    `Package SHA-256: ${digest}`, `Ledger verified: ${document.ledger.eventCount} events`, "", "Section SHA-256 digests:",
    ...Object.entries(document.sectionDigests).sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, hash]) => [name, hash]),
    "", "The complete canonical JSON package is embedded as audit.json.", "It preserves original Unicode, ledger events and evidence bytes.",
    "A digest proves integrity, not institutional approval or a digital signature."];
  // Escape non-ASCII in the summary; never lose or substitute data in the attachment.
  const printable = lines.flatMap((line) => (line.replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).match(/.{1,85}/g) ?? [""]));
  for (let offset = 0; offset < printable.length; offset += 48) {
    const page = pdf.addPage([612, 792]);
    printable.slice(offset, offset + 48).forEach((line, index) => page.drawText(line, { x: 40, y: 750 - index * 14, size: 10, font }));
  }
  await pdf.attach(Buffer.from(json), "audit.json", { mimeType: "application/json", description: "Canonical audit package", creationDate: epoch, modificationDate: epoch });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
