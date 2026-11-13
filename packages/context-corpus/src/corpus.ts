import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalRecordInputSchema, type CanonicalRecordInput } from "@ehf/contracts";
import { validateRecordData } from "@ehf/library-contracts";

export const MANIFEST_SCHEMA = "harness.factory/context-corpus-v1";
export const GENERATOR_NORMALIZER = "context-corpus@0.1.0";

/** A record as written to `records.jsonl`: the library `Record` envelope. */
export type CorpusRecord = {
  id: string; tenant_id: string; object_type: string; schema_version: string; version_id: string;
  supersedes: string | null; observed_at: string; recorded_at: string; valid_from: string | null; valid_to: string | null;
  classification: string; purposes: string[]; synthetic: boolean; subject_ids: string[];
  source_refs: { tenant_id: string; object_type: string; object_id: string; version_id: string }[];
  data: Record<string, unknown>;
};

export type CaseSubject = {
  ref: string; entity_id: string; name: string; subject_type: "individual" | "legal_entity"; role: string | null;
  identifiers: { identifier_type: string; value: string; source: string }[];
};
export type CaseBootstrap = {
  party_id: string; external_ref: string; tenant_id: string; case_type: string; as_of: string;
  customer_entity_id: string; subjects: CaseSubject[]; relationship_record_id: string; record_count: number;
};
export type ManifestParty = {
  id: string; seed: number; spec_digest: string; record_count: number; record_types: Record<string, number>;
  records_digest: string; expectations_digest: string; split: "dev" | "held_out";
  source_files?: Record<string, string>;
};
export type Manifest = { schema: string; generator: string; parties: ManifestParty[]; corpus_digest: string };
export type PartyDossier = { id: string; case: CaseBootstrap; records: CorpusRecord[]; manifest: ManifestParty;
  /** The party's synthetic customer documents, if any (DocumentVersion and DocumentPage records). */
  documents?: CorpusRecord[] };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function readManifest(root: string): Manifest {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;
  if (manifest.schema !== MANIFEST_SCHEMA) throw new Error(`corpus.manifest_schema_unsupported: ${manifest.schema}`);
  return manifest;
}

/** Load one party and verify that the files on disk still match the manifest digest. */
export function readParty(root: string, partyId: string): PartyDossier {
  const manifest = readManifest(root);
  const entry = manifest.parties.find((p) => p.id === partyId);
  if (!entry) throw new Error(`corpus.party_unknown: ${partyId}`);
  const base = join(root, "parties", partyId);
  const text = readFileSync(join(base, "records.jsonl"), "utf8");
  if (sha256(text) !== entry.records_digest) throw new Error(`corpus.digest_mismatch: ${partyId} records.jsonl`);
  const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CorpusRecord);
  if (records.length !== entry.record_count) throw new Error(`corpus.count_mismatch: ${partyId}`);
  const caseBootstrap = JSON.parse(readFileSync(join(base, "case.json"), "utf8")) as CaseBootstrap;
  const documents = readDocuments(root, partyId);
  return { id: partyId, case: caseBootstrap, records, manifest: entry, ...(documents.length ? { documents } : {}) };
}

/**
 * A party's synthetic customer documents (DocumentVersion and full-text DocumentPage records), when
 * it has any, verified against the manifest digest. Seeded with its other records (delivery plan W3).
 */
export function readDocuments(root: string, partyId: string): CorpusRecord[] {
  const entry = readManifest(root).parties.find((p) => p.id === partyId);
  if (!entry?.source_files?.["documents.jsonl"]) return [];
  return readSourceFile(root, partyId, "documents.jsonl").split("\n").filter(Boolean).map((line) => JSON.parse(line) as CorpusRecord);
}

/** A provider-form source file of one party (`iso20022/camt.053.xml`, `provider/...`), verified against the manifest digest. */
export function readSourceFile(root: string, partyId: string, relativePath: string): string {
  const entry = readManifest(root).parties.find((p) => p.id === partyId);
  const want = entry?.source_files?.[relativePath];
  if (!entry || !want) throw new Error(`corpus.source_file_unknown: ${partyId}/${relativePath}`);
  const text = readFileSync(join(root, "parties", partyId, relativePath), "utf8");
  if (sha256(text) !== want) throw new Error(`corpus.digest_mismatch: ${partyId}/${relativePath}`);
  return text;
}

/** The `RecordCanonicalRecords` input for a corpus record (tenant and case default to the command's). */
export function toCanonicalInput(record: CorpusRecord): CanonicalRecordInput {
  return canonicalRecordInputSchema.parse({
    schema_version: record.schema_version,
    object_type: record.object_type,
    object_id: record.id,
    version_id: record.version_id,
    data: record.data,
    subject_ids: record.subject_ids,
    valid_from: record.valid_from,
    valid_to: record.valid_to,
    observed_at: record.observed_at,
    source_refs: record.source_refs,
    provenance: { method: "manual_entry", normalizer: GENERATOR_NORMALIZER },
    classification: record.classification,
    purposes: record.purposes,
    synthetic: record.synthetic,
    supersedes: record.supersedes,
  });
}

/** Contract-check every record against the library ontology / platform schemas the platform enforces. */
export function validateParty(dossier: PartyDossier): string[] {
  const errors: string[] = [];
  for (const record of dossier.records) {
    const result = validateRecordData(record.object_type, record.data);
    if (!result.valid) errors.push(`${record.id} (${record.object_type}): ${result.errors.join("; ")}`);
    try { toCanonicalInput(record); } catch (error) { errors.push(`${record.id}: ${(error as Error).message.slice(0, 200)}`); }
    if (!record.synthetic) errors.push(`${record.id}: not marked synthetic`);
  }
  return errors;
}
