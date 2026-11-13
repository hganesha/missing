import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson, stableDigest } from "@ehf/contracts";

/**
 * Signed ledger segments: the format, and an offline verifier.
 *
 * A segment is one tenant's ledger events since the previous segment, one canonical JSON
 * record per line (NDJSON), plus a signed manifest. This module needs no database and no
 * platform secret: an auditor holding the segments and the signer's public key can check
 *   - the manifest signature (RS256 over the canonical manifest bytes),
 *   - that the NDJSON bytes are exactly the ones the manifest names (eventsDigest),
 *   - every event's digest, recomputed from its envelope,
 *   - every case's hash chain, within the segment and across consecutive segments,
 *   - the Merkle root over the event digests, and that segments form an unbroken series.
 * See docs/implementation/data-stores-plan.md §3.5.
 */

export const SEGMENT_SCHEMA = "ehf.ledger-segment.v1";

/** One exported event: the envelope the event digest covers, plus the digest. */
export type SegmentEvent = {
  eventId: string;
  tenantId: string;
  caseId: string;
  caseSequence: number;
  eventType: string;
  eventSchema: string;
  occurredAt: string | null;
  recordedAt: string | null;
  actor: unknown;
  commandRef: string;
  authority: unknown;
  payload: unknown;
  evidenceRefs: string[];
  previousEventDigest: string | null;
  eventDigest: string;
};

export type CaseRange = { caseId: string; fromSequence: number; toSequence: number; anchorDigest: string | null; headDigest: string };

export type SegmentManifest = {
  schema: typeof SEGMENT_SCHEMA;
  tenantId: string;
  segmentId: string;
  segmentNumber: number;
  previousSegmentId: string | null;
  previousManifestDigest: string | null;
  eventCount: number;
  caseRanges: CaseRange[];
  merkleRoot: string;
  eventsDigest: string;
  algorithm: "RS256";
  signingKeyId: string;
  createdAt: string;
};

export type SignedManifest = { manifest: SegmentManifest; manifestDigest: string; signature: string };

/** The fields of an event the event digest is computed over (the envelope without the digest). */
export function eventEnvelope(event: SegmentEvent): Omit<SegmentEvent, "eventDigest"> {
  const { eventDigest: _digest, ...envelope } = event;
  return envelope;
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Binary Merkle tree over hex digests: parent = sha256(left || right) of the hex text; an odd node is paired with itself. */
export function merkleRoot(leaves: string[]): string {
  if (!leaves.length) throw new Error("ledger_segment.empty");
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(sha256Hex(`${level[index]}${level[index + 1] ?? level[index]}`));
    }
    level = next;
  }
  return level[0]!;
}

export function renderSegmentEvents(events: SegmentEvent[]): string {
  return events.map((event) => canonicalJson(event)).join("\n") + "\n";
}

export function manifestBytes(manifest: SegmentManifest): Buffer {
  return Buffer.from(canonicalJson(manifest), "utf8");
}

export type SegmentVerification = { valid: boolean; errors: string[]; heads: Map<string, { sequence: number; digest: string }> };

/**
 * Verify one or more consecutive segments of one tenant, oldest first. `heads` carries each
 * case's last verified event across segments; pass the result of an earlier call to resume.
 */
export function verifyLedgerSegments(
  segments: Array<{ events: string | Uint8Array; signed: SignedManifest }>,
  publicKeyPem: string,
  options: { heads?: Map<string, { sequence: number; digest: string }>; previous?: SignedManifest | null } = {},
): SegmentVerification {
  const errors: string[] = [];
  const heads = new Map(options.heads ?? []);
  const key = createPublicKey(publicKeyPem);
  let previous = options.previous ?? null;
  for (const [index, segment] of segments.entries()) {
    const at = (message: string) => errors.push(`segment ${index + 1} (${segment.signed.manifest.segmentId}): ${message}`);
    const { manifest, manifestDigest, signature } = segment.signed;
    if (manifest.schema !== SEGMENT_SCHEMA) at(`unknown schema ${String(manifest.schema)}`);
    if (manifest.algorithm !== "RS256") at(`unsupported algorithm ${String(manifest.algorithm)}`);
    if (!verify("sha256", manifestBytes(manifest), key, Buffer.from(signature, "base64url"))) at("signature does not verify");
    if (stableDigest(manifest) !== manifestDigest) at("manifest digest does not match the manifest");
    // An unbroken series: each segment names the one before it.
    if (previous) {
      if (manifest.tenantId !== previous.manifest.tenantId) at("tenant differs from the previous segment");
      if (manifest.segmentNumber !== previous.manifest.segmentNumber + 1) at(`segment number ${manifest.segmentNumber} does not follow ${previous.manifest.segmentNumber}`);
      if (manifest.previousSegmentId !== previous.manifest.segmentId || manifest.previousManifestDigest !== previous.manifestDigest) {
        at("does not link to the previous segment");
      }
    } else if (!options.heads && (manifest.segmentNumber !== 1 || manifest.previousSegmentId !== null)) {
      at("the first segment verified without a predecessor must be segment 1");
    }
    const bytes = typeof segment.events === "string" ? Buffer.from(segment.events, "utf8") : Buffer.from(segment.events);
    if (sha256Hex(bytes) !== manifest.eventsDigest) at("event bytes do not match the manifest's events digest");
    const lines = bytes.toString("utf8").split("\n").filter((line) => line.length > 0);
    if (lines.length !== manifest.eventCount) at(`manifest names ${manifest.eventCount} events, segment holds ${lines.length}`);
    const digests: string[] = [];
    const seen = new Map<string, CaseRange>();
    for (const [line, text] of lines.entries()) {
      let event: SegmentEvent;
      try { event = JSON.parse(text) as SegmentEvent; } catch { at(`line ${line + 1} is not JSON`); continue; }
      if (canonicalJson(event) !== text) at(`line ${line + 1} is not in canonical form`);
      if (event.tenantId !== manifest.tenantId) at(`line ${line + 1} belongs to another tenant`);
      if (stableDigest(eventEnvelope(event)) !== event.eventDigest) at(`event ${event.caseId}#${event.caseSequence} digest does not match its content`);
      const head = heads.get(event.caseId);
      const expectedSequence = head ? head.sequence + 1 : 1;
      const expectedPrevious = head ? head.digest : null;
      if (event.caseSequence !== expectedSequence || event.previousEventDigest !== expectedPrevious) {
        at(`case ${event.caseId} chain breaks at sequence ${event.caseSequence} (expected ${expectedSequence} after ${expectedPrevious ?? "nothing"})`);
      }
      heads.set(event.caseId, { sequence: event.caseSequence, digest: event.eventDigest });
      const range = seen.get(event.caseId);
      if (range) { range.toSequence = event.caseSequence; range.headDigest = event.eventDigest; }
      else seen.set(event.caseId, { caseId: event.caseId, fromSequence: event.caseSequence, toSequence: event.caseSequence, anchorDigest: event.previousEventDigest, headDigest: event.eventDigest });
      digests.push(event.eventDigest);
    }
    if (digests.length && merkleRoot(digests) !== manifest.merkleRoot) at("Merkle root does not match the events");
    if (canonicalJson([...seen.values()]) !== canonicalJson(manifest.caseRanges)) at("case ranges do not match the events");
    previous = segment.signed;
  }
  return { valid: errors.length === 0, errors, heads };
}
