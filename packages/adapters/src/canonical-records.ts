import { createHash } from "node:crypto";
import { canonicalRecordInputSchema, stableDigest, type CanonicalRecordInput, type CanonicalRecordRef } from "@ehf/contracts";
import { assertRecordData, extensionBlock, LIBRARY_CONTEXT_SCHEMA_VERSION } from "@ehf/library-contracts";

/**
 * Connector results → canonical records (docs/implementation/canonical-records.md).
 *
 * Connectors acquire; these pure functions normalize what a connector returned into the typed
 * records the skill library reasons over (RegistryRecord, Entity, OfficerRole, Party,
 * OwnershipInterest, ControlRight, WatchlistEntry, ScreeningHit, AdverseMediaEvent,
 * VerificationRecord, DocumentPage, Evidence, NegativeSearchEvidence). They run inside the
 * gateway adapters, so a connector node's output carries `records` and its case writes stay
 * declarative (`RecordCanonicalRecords` with `records: "{{ output.records }}"`).
 *
 * Rules:
 * - An outcome that did not establish anything (unknown, not_checked, inconclusive, resubmit,
 *   not_applicable, a transport/result error, an unrecognized result family) yields **no
 *   records** and a `recordGap`; it never yields an empty "clear" record.
 * - A completed screen with no candidates yields `NegativeSearchEvidence` (scope, query,
 *   coverage), not a WatchlistEntry: a provider search is not a list capture.
 * - Every record cites the gateway invocation (the receipt that carried the provider result)
 *   and the provider's own record ids in `source_refs`, and is `synthetic: true` whenever the
 *   connector ran in simulation/fixture mode or warned DEMO_ONLY.
 * - Object ids are stable per provider record; a version id is the digest of the content, so
 *   a replayed invocation re-submits the same version (idempotent) and a re-acquisition with
 *   new data or a new observation time adds a version.
 * - `data` is the library's closed context contract (schema 2.0.0, vendored in
 *   `@ehf/library-contracts`): canonical fields only. Source fields with no canonical field go
 *   under `data.extensions["ehf.connector"]` (versioned), which no library skill consumes.
 *   Every record is validated before it leaves the adapter; NegativeSearchEvidence is a
 *   platform-only type with its own closed schema.
 */

export const CANONICAL_RECORD_NORMALIZER_VERSION = "3";
/** Namespace and version of the source fields kept beside the canonical ones. */
export const CONNECTOR_EXTENSION_NAMESPACE = "ehf.connector";
export const CONNECTOR_EXTENSION_VERSION = "1.0.0";

export type RecordGap = { code: "EVIDENCE_GAP"; reason: string; outcome: string | null };
export type NormalizedRecords = { records: CanonicalRecordInput[]; recordGap: RecordGap | null; subjectEntityId?: string };

export type RecordSourceContext = {
  /** Platform tenant (source refs are tenant-scoped). */
  tenantId?: string;
  /** Gateway invocation id: identifies the receipt that carried this result. */
  invocationId?: string;
  capabilityId?: string;
  connectorId: string;
  subjectId?: string;
  classification?: string;
  /** Overrides the provider's observation time (tests). */
  observedAt?: string;
};

type Json = Record<string, unknown>;
const ESTABLISHED_OUTCOMES = new Set(["passed", "failed", "review"]);

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(text).filter((item): item is string => Boolean(item)))] : [];
}

function slug(value: string): string {
  // Long values are hashed below anyway; trimming "-" by slicing avoids /-+$/ backtracking.
  let cleaned = value.length > 4096 ? "" : value.replace(/[^A-Za-z0-9._:-]+/g, "-");
  let first = 0, last = cleaned.length;
  while (first < last && cleaned[first] === "-") first += 1;
  while (last > first && cleaned[last - 1] === "-") last -= 1;
  cleaned = cleaned.slice(first, last);
  return cleaned.length > 0 && cleaned.length <= 120 ? cleaned : createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function isoTime(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function partialDateTime(value: unknown): string | null {
  const date = text(record(value).value) ?? text(value);
  if (!date) return null;
  const full = /^\d{4}$/.test(date) ? `${date}-01-01` : /^\d{4}-\d{2}$/.test(date) ? `${date}-01` : date;
  const parsed = Date.parse(full.length === 10 ? `${full}T00:00:00Z` : full);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function decimal(value: number): string {
  // Library decimals are strings: `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`.
  const fixed = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return fixed === "-0" ? "0" : fixed;
}

/** `{ extensions }` carrying the given source fields, or nothing when they are all empty. */
function withExtensions(value: Json): Json {
  const block = extensionBlock(CONNECTOR_EXTENSION_NAMESPACE, CONNECTOR_EXTENSION_VERSION, value);
  return block ? { extensions: block } : {};
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function synthetic(warnings: string[], executionMode: string | undefined): boolean {
  return warnings.some((warning) => warning.toUpperCase().startsWith("DEMO_ONLY"))
    || ["simulation", "fixture", "simulated", "demo"].includes((executionMode ?? "").toLowerCase());
}

class Builder {
  readonly records: CanonicalRecordInput[] = [];
  constructor(
    private readonly context: RecordSourceContext,
    private readonly base: { observedAt: string; synthetic: boolean; normalizer: string; providerCheckId?: string; executionMode?: string; receiptRefs: CanonicalRecordRef[] },
  ) {}

  ref(objectType: string, objectId: string, versionId: string): CanonicalRecordRef {
    return { tenant_id: this.context.tenantId ?? "unknown", object_type: objectType, object_id: objectId, version_id: versionId };
  }

  add(objectType: string, objectId: string, data: Json, options: { sourceRefs?: CanonicalRecordRef[]; validFrom?: string | null; validTo?: string | null; subjectIds?: string[] } = {}): string {
    const sourceRefs = [...this.base.receiptRefs, ...(options.sourceRefs ?? [])];
    const validFrom = options.validFrom ?? null;
    const validTo = options.validTo && (!validFrom || Date.parse(validFrom) < Date.parse(options.validTo)) ? options.validTo : null;
    const content = { objectType, objectId, data, validFrom, validTo, observedAt: this.base.observedAt, sourceRefs, synthetic: this.base.synthetic };
    const candidate = {
      object_type: objectType,
      object_id: objectId,
      version_id: `v-${stableDigest(content).slice(0, 32)}`,
      schema_version: LIBRARY_CONTEXT_SCHEMA_VERSION,
      data,
      ...(options.subjectIds?.length ? { subject_ids: options.subjectIds } : {}),
      valid_from: validFrom,
      valid_to: validTo,
      observed_at: this.base.observedAt,
      source_refs: sourceRefs,
      provenance: {
        method: "connector_normalizer" as const,
        normalizer: `${this.base.normalizer}@${CANONICAL_RECORD_NORMALIZER_VERSION}`,
        connector_id: this.context.connectorId,
        ...(this.context.capabilityId ? { capability_id: this.context.capabilityId } : {}),
        ...(this.context.invocationId ? { invocation_id: this.context.invocationId } : {}),
        ...(this.base.providerCheckId ? { provider_check_id: this.base.providerCheckId } : {}),
        ...(this.base.executionMode ? { execution_mode: this.base.executionMode } : {}),
      },
      classification: this.context.classification ?? "CONFIDENTIAL",
      synthetic: this.base.synthetic,
    };
    // The same entity can appear on several edges; record each version once.
    if (this.records.some((existing) => existing.object_type === objectType && existing.object_id === objectId && existing.version_id === candidate.version_id)) {
      return objectId;
    }
    // Fail here, in the adapter, rather than with a case-store 400 (or a library ingestion
    // refusal) after the provider was paid.
    assertRecordData(objectType, data);
    this.records.push(canonicalRecordInputSchema.parse(candidate));
    return objectId;
  }
}

function receiptRefs(context: RecordSourceContext, versionId: string): CanonicalRecordRef[] {
  return context.invocationId
    ? [{ tenant_id: context.tenantId ?? "unknown", object_type: "GatewayInvocation", object_id: context.invocationId, version_id: versionId }]
    : [];
}

function gap(reason: string, outcome: string | null): NormalizedRecords {
  return { records: [], recordGap: { code: "EVIDENCE_GAP", reason, outcome } };
}

// ---------------------------------------------------------------------------
// KYC API wiring (CanonicalHostResult, data-adapters api-wiring vendor/atlas/schemas/host.schema.json)
// ---------------------------------------------------------------------------

export type WiringResultInput = {
  /** `<provider_id>:<capability>`, e.g. `companies-house:business.registry.lookup`. */
  operationId: string;
  /** The adapter's fail-closed outcome (`unknown` whenever the check did not complete). */
  outcome: string;
  error: { code: string } | null;
  providerCheckId: string;
  executionMode?: string;
  warnings: string[];
  /** The raw CanonicalHostResult (entities, relationships, evidence, result, coverage). */
  host: unknown;
};

/** The library's closed `Coverage`; the provider's own coverage status goes to the record's extensions. */
function libraryCoverage(coverage: unknown, observedAt: string, provider: string, limitations: string[] = []): { coverage: Json; sourceStatus: string } {
  const source = record(coverage);
  const status = text(source.status) ?? "unknown";
  return {
    coverage: {
      complete: status === "complete_for_requested_scope",
      jurisdictions: texts(source.checked_scope),
      as_of: observedAt,
      provider,
      limitations: [...new Set([
        ...texts(source.not_checked_scope).map((scope) => `not checked: ${scope}`),
        ...(text(source.reason) ? [text(source.reason)!] : []),
        ...texts(source.missing_fields).map((field) => `missing field: ${field}`),
        ...limitations,
      ])],
    },
    sourceStatus: status,
  };
}

const ENTITY_KINDS = new Set(["individual", "company", "trust", "fund", "partnership", "organization", "unknown"]);

type WiringEntity = { objectId: string; name: string | undefined; entity: Json };

function wiringEntities(host: Json, providerId: string): Map<string, WiringEntity> {
  const entities = new Map<string, WiringEntity>();
  for (const entity of list(host.entities)) {
    const localId = text(entity.entity_id);
    if (!localId) continue;
    const key = texts(entity.source_record_ids)[0]
      ?? list(entity.identifiers).map((identifier) => text(identifier.value)).find(Boolean)
      ?? localId;
    const legal = list(entity.names).find((name) => name.kind === "legal") ?? list(entity.names)[0];
    entities.set(localId, { objectId: `entity:${slug(providerId)}:${slug(key)}`, name: text(legal?.full), entity });
  }
  return entities;
}

/**
 * Identifying attributes on which a screening subject and a list candidate contradict each
 * other, as `scheme:<scheme>` and `birth_date` entries; empty when nothing contradicts.
 *
 * Only like-for-like comparisons count, because a missing or differently-typed value proves
 * nothing: an identifier scheme both entities carry whose values share nothing (a different
 * passport number), or two day-precision birth dates that differ. A generic scheme such as a
 * list's own record number is not comparable, and partial dates (a year only) are skipped. The
 * library turns a conflict into a FALSE_MATCH_CANDIDATE recommendation, which a person must
 * still confirm; it never clears the hit.
 */
const GENERIC_IDENTIFIER_SCHEMES = new Set(["list_document", "list_record", "provider_id", "source_record", "other", "unknown"]);
export function identifierConflict(subject: Json, candidate: Json): string[] {
  const byScheme = (entity: Json) => {
    const out = new Map<string, Set<string>>();
    for (const identifier of list(entity.identifiers)) {
      const scheme = text(identifier.scheme)?.toLowerCase();
      const value = text(identifier.value)?.replace(/[\s-]/g, "").toUpperCase();
      if (!scheme || !value || GENERIC_IDENTIFIER_SCHEMES.has(scheme)) continue;
      const key = `${scheme}:${text(identifier.jurisdiction)?.toUpperCase() ?? ""}`;
      out.set(key, (out.get(key) ?? new Set()).add(value));
    }
    return out;
  };
  const conflicts: string[] = [];
  const left = byScheme(subject);
  const right = byScheme(candidate);
  for (const [key, values] of left) {
    const other = right.get(key);
    if (other && ![...values].some((value) => other.has(value))) conflicts.push(`scheme:${key.replace(/:$/, "")}`);
  }
  const dayDate = (entity: Json) => {
    const date = record(entity.birth_date);
    const value = text(date.value);
    return date.precision === "day" && value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  };
  const born = dayDate(subject);
  const listed = dayDate(candidate);
  if (born && listed && born !== listed) conflicts.push("birth_date");
  return conflicts.sort();
}

function providerRefs(builder: Builder, providerId: string, entity: Json, versionId: string): CanonicalRecordRef[] {
  return texts(entity.source_record_ids).map((id) => builder.ref("ProviderRecord", `${providerId}:${id}`, versionId));
}

function registrationIdentifier(source: Json): Json | undefined {
  return list(source.identifiers).find((identifier) => /registration|company|crn|registry/i.test(text(identifier.scheme) ?? ""));
}

function entityData(entity: WiringEntity): Json {
  const source = entity.entity;
  const names = list(source.names);
  const original = text(source.entity_type) ?? "unknown";
  const mapped = original === "organization" ? "company" : original === "person" ? "individual" : original;
  const entityType = ENTITY_KINDS.has(mapped) ? mapped : "unknown";
  const registrationId = text(registrationIdentifier(source)?.value);
  const address = text(list(source.addresses)[0]?.full);
  return {
    name: entity.name,
    identifiers: list(source.identifiers).map((identifier) => text(identifier.value)).filter(Boolean),
    entity_type: entityType,
    ...(registrationId || address ? { attributes: { ...(registrationId ? { registration_id: registrationId } : {}), ...(address ? { address } : {}) } } : {}),
    ...withExtensions({
      ...(entityType !== original ? { entity_type: original } : {}),
      identifier_details: list(source.identifiers).map((identifier) => ({ scheme: text(identifier.scheme), value: text(identifier.value), ...(text(identifier.jurisdiction) ? { jurisdiction: text(identifier.jurisdiction) } : {}) })),
      aliases: names.filter((name) => name !== names.find((candidate) => candidate.kind === "legal")).map((name) => text(name.full)).filter(Boolean),
      jurisdiction: text(source.jurisdiction),
      legal_form: text(source.legal_form),
      ...(source.birth_date ? { birth_date: record(source.birth_date) } : {}),
      ...(source.incorporation_date ? { incorporation_date: record(source.incorporation_date) } : {}),
      addresses: list(source.addresses),
      nationalities: texts(source.nationalities),
    }),
  };
}

function addEntity(builder: Builder, providerId: string, entity: WiringEntity, versionId: string): string | null {
  if (!entity.name) return null;
  return builder.add("Entity", entity.objectId, entityData(entity), { sourceRefs: providerRefs(builder, providerId, entity.entity, versionId) });
}

/**
 * Normalize a KYC API wiring result. Families: `business` → RegistryRecord, Entity, Party,
 * OfficerRole (from officer/director relationships); `ownership` → OwnershipInterest,
 * ControlRight, Entity; `screening` → WatchlistEntry + ScreeningHit (sanctions, PEP,
 * enforcement), AdverseMediaEvent (adverse media), or NegativeSearchEvidence when the
 * completed screen returned no candidate, and for PEP data PEPRelationship (a relative or close
 * associate of the screened subject); `verification` → VerificationRecord;
 * `reference` → Entity (an identifier record, e.g. an LEI, is not a company registry record).
 */
export function normalizeWiringResult(input: WiringResultInput, context: RecordSourceContext): NormalizedRecords {
  const host = record(input.host);
  const separator = input.operationId.indexOf(":");
  const providerId = input.operationId.slice(0, separator);
  const capability = input.operationId.slice(separator + 1);
  if (input.error) return gap(`The ${capability} check did not complete (${input.error.code}).`, input.outcome);
  if (!ESTABLISHED_OUTCOMES.has(input.outcome)) {
    return gap(`The ${capability} check returned outcome ${input.outcome}; nothing was established.`, input.outcome);
  }
  const result = record(host.result);
  const kind = text(result.kind);
  const execution = record(host.execution);
  const observedAt = context.observedAt ?? isoTime(execution.provider_observed_at) ?? isoTime(execution.received_at) ?? new Date().toISOString();
  const versionId = text(host.result_id) ?? input.providerCheckId;
  const builder = new Builder(context, {
    observedAt,
    synthetic: synthetic(input.warnings, input.executionMode),
    normalizer: `wiring.${kind ?? "unknown"}`,
    providerCheckId: input.providerCheckId,
    ...(input.executionMode ? { executionMode: input.executionMode } : {}),
    receiptRefs: receiptRefs(context, input.providerCheckId),
  });
  const entities = wiringEntities(host, providerId);
  const { coverage, sourceStatus } = libraryCoverage(host.coverage, observedAt, providerId);
  const subject = entities.get(text(host.subject_entity_id) ?? "") ?? entities.get(text(result.organization_entity_id) ?? text(result.root_entity_id) ?? "");
  const evidenceIds = list(host.evidence).map((item) => text(item.evidence_id)).filter((id): id is string => Boolean(id));

  if (kind === "business") {
    const organization = entities.get(text(result.organization_entity_id) ?? "") ?? subject;
    if (organization) {
      const entityId = addEntity(builder, providerId, organization, versionId);
      const source = organization.entity;
      const registration = registrationIdentifier(source) ?? list(source.identifiers)[0];
      const registrationId = text(registration?.value) ?? texts(source.source_record_ids)[0];
      const address = list(source.addresses)[0];
      if (registrationId && organization.name) {
        builder.add("RegistryRecord", `registry:${slug(providerId)}:${slug(registrationId)}`, {
          name: organization.name,
          registration_id: registrationId,
          status: (text(source.status) ?? "unknown").toUpperCase(),
          coverage,
          ...(text(address?.full) ? { address: text(address!.full) } : {}),
          ...(text(source.jurisdiction) ? { attributes: { jurisdiction: text(source.jurisdiction) } } : {}),
          ...withExtensions({
            status_original: text(source.status_original),
            registry: providerId,
            legal_form: text(source.legal_form),
            ...(address && !text(address.full) ? { address } : {}),
            checks: list(result.checks).map((check) => ({ check_id: text(check.check_id), name: text(check.name), outcome: text(check.outcome) })),
            entity_id: entityId,
            coverage_status: sourceStatus,
          }),
        }, { sourceRefs: providerRefs(builder, providerId, source, versionId), validFrom: partialDateTime(source.incorporation_date) });
      }
      if (entityId) {
        builder.add("Party", `party:${slug(providerId)}:${slug(entityId)}:customer`, {
          entity_id: entityId,
          role: "customer",
          // A business-registry subject is an organization: the library's corporate customer type.
          customer_type: "corporate",
          profile: { legal_name: organization.name },
          ...withExtensions({ legal_form: text(source.legal_form), jurisdiction: text(source.jurisdiction), source: providerId }),
        });
      }
    }
    for (const relationship of list(host.relationships)) {
      const type = text(relationship.type);
      if (type !== "officer_of" && type !== "director_of") continue;
      const person = entities.get(text(relationship.from_entity_id) ?? "");
      const organizationEntity = entities.get(text(relationship.to_entity_id) ?? "");
      if (!person || !organizationEntity) continue;
      const personId = addEntity(builder, providerId, person, versionId) ?? person.objectId;
      const role = type === "director_of" ? "director" : "officer";
      builder.add("OfficerRole", `officer:${slug(providerId)}:${slug(text(relationship.relationship_id) ?? `${personId}:${role}`)}`, {
        entity_id: personId, organization_id: organizationEntity.objectId, role,
        ...withExtensions({ name: person.name, assertion_status: text(relationship.assertion_status) ?? "unknown" }),
      }, { validFrom: partialDateTime(relationship.valid_from), validTo: partialDateTime(relationship.valid_to) });
    }
    return builder.records.length ? { records: builder.records, recordGap: null } : gap("The business result carried no organization with a registration identifier.", input.outcome);
  }

  if (kind === "ownership") {
    for (const relationship of list(host.relationships)) {
      const type = text(relationship.type);
      if (!type || !["owns", "controls", "beneficial_owner_of"].includes(type)) continue;
      const from = entities.get(text(relationship.from_entity_id) ?? "");
      const to = entities.get(text(relationship.to_entity_id) ?? "");
      if (!from || !to) continue;
      addEntity(builder, providerId, from, versionId);
      addEntity(builder, providerId, to, versionId);
      const ownership = record(relationship.ownership);
      const percent = typeof ownership.exact_percent === "number" ? ownership.exact_percent
        : typeof ownership.lower_percent === "number" ? ownership.lower_percent : undefined;
      const relationshipId = slug(text(relationship.relationship_id) ?? `${from.objectId}>${to.objectId}`);
      const window = { validFrom: partialDateTime(relationship.valid_from), validTo: partialDateTime(relationship.valid_to) };
      const asserted = text(relationship.assertion_status) ?? "unknown";
      // The library's interest is a fraction in [0, 1]; a percentage outside [0, 100] is unusable.
      if (percent !== undefined && percent >= 0 && percent <= 100 && ownership.kind !== "control" && ownership.kind !== "voting") {
        const exact = typeof ownership.exact_percent === "number";
        if (!exact && typeof ownership.upper_percent === "number" && (ownership.upper_percent < percent || ownership.upper_percent > 100)) continue;
        builder.add(exact ? "OwnershipInterest" : "OwnershipRange", `ownership:${slug(providerId)}:${relationshipId}`, {
          owner: from.objectId, owned: to.objectId,
          ...(exact ? { interest: decimal(percent / 100) } : {
            lower: decimal(percent / 100), upper: decimal((typeof ownership.upper_percent === "number" ? ownership.upper_percent : 100) / 100),
            lower_inclusive: ownership.lower_inclusive === true, upper_inclusive: ownership.upper_inclusive === true,
          }),
          ...withExtensions({
            interest_basis: typeof ownership.exact_percent === "number" ? "exact" : "lower_bound",
            ...(typeof ownership.upper_percent === "number" ? { interest_upper: decimal(ownership.upper_percent / 100) } : {}),
            kind: text(ownership.kind) ?? "unknown", directness: text(ownership.directness) ?? "unknown", assertion_status: asserted,
            completeness: text(result.completeness) ?? "unknown",
          }),
        }, window);
      }
      if (type === "controls" || ownership.kind === "control" || ownership.kind === "voting") {
        builder.add("ControlRight", `control:${slug(providerId)}:${relationshipId}`, {
          controller: from.objectId, controlled: to.objectId, basis: text(ownership.kind) ?? type,
          verified: asserted === "confirmed",
        }, window);
      }
    }
    if (!builder.records.length) {
      return gap(`The ownership result established no ownership or control edge (completeness ${text(result.completeness) ?? "unknown"}).`, input.outcome);
    }
    return { records: builder.records, recordGap: null, ...(subject ? { subjectEntityId: subject.objectId } : {}) };
  }

  if (kind === "screening") {
    const matches = list(result.matches);
    const datasetVersions = texts(result.dataset_versions);
    const subjectId = context.subjectId ?? subject?.objectId;
    if (subjectId && subject?.name) {
      builder.add("ScreeningExecution", `screen:${slug(providerId)}:${slug(input.providerCheckId)}`, {
        subject: subjectId, screening_type: capability === "screening.adverse_media" ? "adverse_media" : capability === "screening.pep" ? "pep" : capability === "screening.sanctions" ? "sanctions" : "watchlist",
        provider: providerId, query: subject.name, query_time: observedAt,
        status: result.truncated === true || execution.status !== "completed" ? "PARTIAL" : "COMPLETED", dataset_versions: datasetVersions,
        scope: texts(result.scope), list_published_at: isoTime(result.list_published_at) ?? null,
        candidate_count: typeof result.total_candidates === "number" ? Math.max(matches.length, result.total_candidates) : matches.length,
        truncated: result.truncated === true, limitations: ["Provider search scope only; not universal clearance."],
      });
    }
    if (capability === "screening.adverse_media") {
      const evidence = new Map(list(host.evidence).map((item) => [text(item.evidence_id), item]));
      for (const match of matches) {
        const citations = texts(match.evidence_ids).map((id) => evidence.get(id)).filter((item): item is Json => Boolean(item));
        const first = citations[0] ?? {};
        const title = text(first.source_title) ?? (texts(match.categories).join(", ") || undefined);
        if (!title) continue;
        builder.add("AdverseMediaEvent", `media:${slug(providerId)}:${slug(text(match.match_id)!)}`, {
          subjects: [subject?.name].filter(Boolean),
          title,
          source: text(first.source_url) ?? text(first.provider_id) ?? providerId,
          // A provider-reported media match is an allegation until someone confirms it.
          status: "ALLEGATION",
          coverage,
          event_key: text(match.candidate_entity_id) ?? text(match.match_id),
          ...withExtensions({
            categories: texts(match.categories),
            provider_disposition: text(match.disposition) ?? "unresolved",
            published_at: isoTime(first.published_at),
            coverage_status: sourceStatus,
          }),
        }, { sourceRefs: citations.map((item) => builder.ref("ProviderEvidence", `${providerId}:${text(item.evidence_id)}`, versionId)) });
      }
    } else {
      // The library's list types are sanctions, pep and watchlist (every other list).
      const listType = capability === "screening.pep" ? "pep" : capability === "screening.sanctions" ? "sanctions" : "watchlist";
      const subjectId = subject ? addEntity(builder, providerId, subject, versionId) ?? subject.objectId : undefined;
      for (const match of matches) {
        const candidate = entities.get(text(match.candidate_entity_id) ?? "");
        if (!candidate?.name) continue;
        const entryId = builder.add("WatchlistEntry", `watchlist:${slug(providerId)}:${slug(texts(candidate.entity.source_record_ids)[0] ?? candidate.objectId)}`, {
          name: candidate.name,
          identifiers: list(candidate.entity.identifiers).map((identifier) => text(identifier.value)).filter(Boolean),
          list_type: listType,
          list_version: datasetVersions.join(",") || "unknown",
          coverage,
          ...withExtensions({
            screening_capability: capability,
            list_ids: texts(match.list_ids),
            programs: texts(match.programs),
            entity_type: text(candidate.entity.entity_type) ?? "unknown",
            coverage_status: sourceStatus,
          }),
        }, { sourceRefs: providerRefs(builder, providerId, candidate.entity, versionId) });
        if (subjectId) {
          // A conflict is either reported by the provider (`conflicting_fields` naming an
          // identifier or birth date) or established here by comparing what both sides state,
          // like for like (identifierConflict). Anything else leaves the hit at REVIEW, never a
          // false-match candidate.
          const reported = texts(match.conflicting_fields).filter((field) => IDENTIFIER_FIELD.test(field) || /birth/i.test(field)).map((field) => `provider:${field}`);
          const conflict = [...new Set([...reported, ...(subject ? identifierConflict(subject.entity, candidate.entity) : [])])].sort();
          builder.add("ScreeningHit", `hit:${slug(providerId)}:${slug(text(match.match_id)!)}`, {
            entity_id: subjectId, entry_id: entryId,
            features: { identifier_conflict: conflict.length > 0 },
            ...withExtensions({ categories: texts(match.categories), matched_fields: texts(match.matched_fields), scores: list(match.scores), provider_disposition: text(match.disposition) ?? "unresolved",
              ...(conflict.length ? { identifier_conflict_basis: conflict } : {}) }),
          });
        }
      }
      // PEP data's relatives and close associates of the screened subject: a PEPRelationship the
      // library's pep.relationship.resolve reads. Verified only when the provider confirms it; a
      // rejected assertion is no relationship.
      const subjectKey = text(host.subject_entity_id);
      if (capability === "screening.pep" && subjectId && subjectKey) {
        for (const relationship of list(host.relationships)) {
          const type = text(relationship.type);
          if ((type !== "family_of" && type !== "close_associate_of") || text(relationship.assertion_status) === "rejected") continue;
          const from = text(relationship.from_entity_id), to = text(relationship.to_entity_id);
          const otherKey = from === subjectKey ? to : to === subjectKey ? from : null;
          const other = otherKey ? entities.get(otherKey) : undefined;
          if (!other?.name) continue;
          const otherId = addEntity(builder, providerId, other, versionId) ?? other.objectId;
          builder.add("PEPRelationship", `pep-relationship:${slug(providerId)}:${slug(text(relationship.relationship_id) ?? `${subjectId}:${otherId}:${type}`)}`, {
            source: subjectId, target: otherId, relation: type === "family_of" ? "family" : "close_associate",
            verified: text(relationship.assertion_status) === "confirmed",
            ...withExtensions({ assertion_status: text(relationship.assertion_status) ?? "unknown", provider: providerId }),
          }, { sourceRefs: providerRefs(builder, providerId, other.entity, versionId) });
        }
      }
    }
    if (!matches.length) {
      builder.add("NegativeSearchEvidence", `negative:${slug(providerId)}:${slug(capability)}:${slug(input.providerCheckId)}`, {
        capability, provider: providerId, subject: subject?.name ?? null, dataset_versions: datasetVersions,
        scope: texts(result.scope), truncated: result.truncated === true, total_candidates: typeof result.total_candidates === "number" ? result.total_candidates : 0,
        coverage, query_time: observedAt,
        limitations: ["No candidate above the provider's threshold for this query; not universal clearance."],
        ...withExtensions({ coverage_status: sourceStatus }),
      });
    }
    return builder.records.length ? { records: builder.records, recordGap: null } : gap("The screening result carried candidates the normalizer could not attribute.", input.outcome);
  }

  if (kind === "verification") {
    const subjectName = subject?.name ?? text(host.subject_entity_id) ?? "subject";
    // A check that completed but asked for review verified nothing: UNVERIFIED, never VERIFIED.
    const status = input.outcome === "passed" ? "VERIFIED" : input.outcome === "failed" ? "FAILED" : "UNVERIFIED";
    builder.add("VerificationRecord", `verification:${slug(providerId)}:${slug(capability)}:${slug(versionId)}`, {
      subject: subject?.objectId ?? subjectName,
      status,
      method: `${providerId}:${capability}`,
      evidence_ids: evidenceIds,
      ...withExtensions({
        provider_outcome: input.outcome,
        checks: list(result.checks).map((check) => ({ check_id: text(check.check_id), name: text(check.name), outcome: text(check.outcome) })),
        coverage,
        coverage_status: sourceStatus,
      }),
    });
    return { records: builder.records, recordGap: null };
  }

  if (kind === "reference") {
    for (const entity of entities.values()) addEntity(builder, providerId, entity, versionId);
    return builder.records.length ? { records: builder.records, recordGap: null } : gap("The reference result carried no named entity.", input.outcome);
  }

  return gap(`Result family ${kind ?? "missing"} has no canonical-record normalizer.`, input.outcome);
}

// ---------------------------------------------------------------------------
// OpenSanctions match API (invokeOpenSanctions output)
// ---------------------------------------------------------------------------

/**
 * Normalize a direct OpenSanctions screen: each candidate above the threshold becomes a
 * WatchlistEntry (the matched list entity) and a ScreeningHit against the queried subject; no
 * candidate becomes NegativeSearchEvidence. Coverage is never `complete`: the match API returns
 * candidates above a threshold, not a capture of the list.
 */
/** OpenSanctions property names that carry an identifier (registration, tax, LEI, passport, …). */
const IDENTIFIER_FIELD = /(identifier|number|code|lei|inn|ogrn|imo|swift|bic|isin|registration|passport|tax|vat)/i;

export function normalizeOpenSanctionsResult(output: unknown, context: RecordSourceContext): NormalizedRecords {
  const source = record(output);
  if (source.status !== "OK" || !Array.isArray(source.alerts)) return gap("The OpenSanctions screen did not return a result.", null);
  const screeningType = text(source.screeningType) === "PEP" ? "pep" : "sanctions";
  const dataset = text(source.dataset) ?? "default";
  const observedAt = context.observedAt ?? isoTime(source.screenedAt) ?? new Date().toISOString();
  const query = record(source.query);
  const subjectName = texts(record(query.properties).name)[0];
  const subjectId = context.subjectId ?? text(source.subjectId) ?? (subjectName ? `subject-name:${slug(subjectName)}` : undefined);
  const builder = new Builder(context, {
    observedAt,
    synthetic: synthetic(texts(source.warnings), text(source.executionMode)),
    normalizer: `opensanctions.${screeningType}`,
    receiptRefs: receiptRefs(context, `${dataset}@${observedAt}`),
  });
  const coverage = {
    complete: false,
    jurisdictions: [],
    as_of: observedAt,
    provider: "opensanctions",
    limitations: [`OpenSanctions match API, dataset ${dataset}, candidates at or above threshold ${String(source.threshold ?? "unknown")}; not a full list capture.`],
  };
  if (subjectId && subjectName) {
    builder.add("Entity", subjectId, { name: subjectName, identifiers: [], entity_type: query.schema === "Person" ? "individual" : "company" });
    builder.add("ScreeningExecution", `screen:opensanctions:${screeningType}:${slug(stableDigest({ subjectId, query, observedAt }).slice(0, 24))}`, {
      subject: subjectId, screening_type: screeningType, provider: "opensanctions", query: subjectName, query_time: observedAt,
      status: source.truncated === true ? "PARTIAL" : "COMPLETED", dataset_versions: text(source.datasetVersion) ? [text(source.datasetVersion)!] : [], scope: texts(source.topics),
      list_published_at: isoTime(source.listPublishedAt) ?? null, candidate_count: list(source.alerts).length,
      truncated: source.truncated === true, limitations: coverage.limitations,
    });
  }
  for (const alert of list(source.alerts)) {
    const listRecordId = text(alert.listRecordId);
    const name = text(alert.matchedName);
    if (!listRecordId || !name) continue;
    const versionId = text(alert.lastSeen) ?? observedAt;
    const entryId = builder.add("WatchlistEntry", `watchlist:opensanctions:${slug(listRecordId)}`, {
      name, identifiers: [listRecordId], list_type: screeningType, list_version: `opensanctions:${dataset}@${versionId}`, coverage,
      ...withExtensions({ datasets: texts(alert.datasets), topics: texts(alert.topics), programs: texts(alert.programs), entity_type: text(alert.entitySchema) ?? "unknown", coverage_status: "partial" }),
    }, { sourceRefs: [builder.ref("ProviderRecord", `opensanctions:${listRecordId}`, versionId)] });
    builder.add("ScreeningHit", `hit:opensanctions:${slug(screeningType)}:${slug(listRecordId)}`, {
      entity_id: subjectId ?? "subject",
      entry_id: entryId,
      features: {
        // A conflicting identifier field makes the hit a false-match candidate for the library.
        identifier_conflict: texts(alert.conflictingFields).some((field) => IDENTIFIER_FIELD.test(field)),
        ...(typeof alert.score === "number" && alert.score >= 0 && alert.score <= 1 ? { score: alert.score } : {}),
      },
      ...withExtensions({
        score_meaning: text(alert.scoreMeaning) ?? "IDENTITY_MATCH_CONFIDENCE",
        accepted_by_matcher: alert.acceptedByMatcher === true, matched_fields: texts(alert.matchedFields), conflicting_fields: texts(alert.conflictingFields),
      }),
    });
  }
  if (!list(source.alerts).length) {
    builder.add("NegativeSearchEvidence", `negative:opensanctions:${screeningType}:${slug(stableDigest({ query, dataset, observedAt }).slice(0, 24))}`, {
      capability: screeningType === "pep" ? "screening.pep" : "screening.sanctions", provider: "opensanctions", subject: subjectName ?? null,
      dataset_versions: [dataset], scope: texts(source.topics), truncated: false, total_candidates: 0, coverage, query_time: observedAt,
      limitations: ["No candidate at or above the threshold for this query; not universal clearance."],
      ...withExtensions({ query, coverage_status: "partial" }),
    });
  }
  return { records: builder.records, recordGap: null };
}

// ---------------------------------------------------------------------------
// KYC evidence pipeline package (invokeEvidencePipeline output, operation `package`)
// ---------------------------------------------------------------------------

/** Media types for the evidence pipeline's document formats; anything else stays generic. */
const DOCUMENT_MEDIA_TYPES: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", htm: "text/html",
  pdf: "application/pdf", json: "application/json", xml: "application/xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp", heif: "image/heif",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

type PackagePage = { documentId: string; page: number; text: string; textSha256: string | undefined; segments: Map<string, number>; geometry: Json; regions: Json[] };

/** The package's `pages` (full decoded page text per document, kyc-evidence-server), keyed by document. */
function packagePages(value: unknown): Map<string, PackagePage[]> {
  const byDocument = new Map<string, PackagePage[]>();
  for (const item of list(value)) {
    const documentId = text(item.document_id);
    const page = typeof item.page === "number" && Number.isInteger(item.page) && item.page >= 1 ? item.page : null;
    if (!documentId || page === null || typeof item.text !== "string" || !item.text.length) continue;
    const segments = new Map<string, number>();
    for (const segment of list(item.segments)) {
      const id = text(segment.segment_id);
      if (id && typeof segment.start === "number" && Number.isInteger(segment.start) && segment.start >= 0) segments.set(id, segment.start);
    }
    const pages = byDocument.get(documentId) ?? [];
    pages.push({ documentId, page, text: item.text, textSha256: text(item.text_sha256), segments, geometry: record(item.geometry), regions: list(item.segments).filter(segment => Array.isArray(segment.bbox)) });
    byDocument.set(documentId, pages);
  }
  for (const pages of byDocument.values()) pages.sort((a, b) => a.page - b.page);
  return byDocument;
}

/**
 * Normalize a document evidence package into document records:
 *
 * - one DocumentVersion per parsed document (`artifact_hash` is the source file's sha256; the
 *   pipeline does not keep the file, so `artifact_ref` names the pipeline's document);
 * - one DocumentPage per page, only from the package's `pages` (full decoded text): `text` is the
 *   whole page (`text_basis: "full_text"`) and its `segments` map evidence offsets onto it. Cited
 *   quotes are never stitched into a page, since a skill would read fragments as the whole page.
 *   A package without `pages` (an older evidence server) yields Evidence records only;
 * - one Evidence record per cited span, with its page span (`page_start`/`page_end`, Unicode
 *   code points) when the page's full text is known.
 *
 * A document's `document_version` is its source file's sha256, the identity every skill uses to
 * bind spans and assertions to exact content. Nothing here is verified: every Evidence record is
 * `verified: false` and maps to no acceptance requirement. A package without evidence or pages is
 * a gap.
 */
export function normalizeEvidencePackage(output: unknown, context: RecordSourceContext): NormalizedRecords {
  const source = record(output);
  const data = record(source.data);
  if (text(source.operation) !== "package") return gap("Only an evidence package can be normalized into document records.", null);
  const evidence = list(data.evidence);
  const fullPages = packagePages(data.pages);
  if (!evidence.length && !fullPages.size) return gap("The evidence package carried no cited evidence span or page text.", null);
  const documents = new Map(list(data.documents).map((document) => [text(document.document_id), document]));
  const finished = list(data.runs).map((run) => isoTime(run.finished_at)).filter((value): value is string => Boolean(value)).sort().at(-1);
  const observedAt = context.observedAt ?? finished ?? new Date().toISOString();
  const builder = new Builder(context, {
    observedAt,
    synthetic: synthetic(texts(data.warnings), text(source.executionMode)) || /synthetic|not for production/i.test(text(data.disclaimer) ?? ""),
    normalizer: "evidence.package",
    receiptRefs: receiptRefs(context, observedAt),
  });

  // DocumentVersion first: pages and evidence cite it.
  const versionRefs = new Map<string, CanonicalRecordRef>();
  const versionOf = (documentId: string, item?: Json) =>
    text(item?.document_sha256) ?? text(documents.get(documentId)?.sha256) ?? documentId;
  for (const [documentId, document] of documents) {
    if (!documentId) continue;
    const sha256 = text(document.sha256);
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) continue;
    const pages = fullPages.get(documentId) ?? [];
    const declared = typeof document.page_count === "number" && Number.isInteger(document.page_count) && document.page_count >= 0 ? document.page_count : null;
    // Without a parser count or decoded pages, the highest cited page is only a lower bound.
    const cited = Math.max(0, ...evidence.filter((item) => text(item.document_id) === documentId)
      .map((item) => (typeof item.page === "number" && Number.isInteger(item.page) ? item.page : 0)));
    const pageCountBasis = declared !== null ? "parser" : pages.length ? "decoded_pages" : "cited_pages_lower_bound";
    const format = (text(document.format) ?? "").toLowerCase();
    builder.add("DocumentVersion", documentId, {
      document_id: documentId,
      artifact_hash: sha256,
      media_type: DOCUMENT_MEDIA_TYPES[format] ?? "application/octet-stream",
      artifact_ref: text(document.artifact_ref) ?? `kyc-evidence-pipeline:${documentId}`,
      page_count: declared ?? (pages.length || cited),
      ...withExtensions({
        filename: text(document.filename), format: format || undefined, document_family: text(document.family),
        profile_id: text(document.profile_id), parser: text(record(document.parser).name), run_id: text(document.current_run_id),
        page_count_basis: pageCountBasis,
      }),
    });
    const added = builder.records.at(-1)!;
    versionRefs.set(documentId, builder.ref("DocumentVersion", documentId, added.version_id));
  }
  const versionRef = (documentId: string, documentVersion: string) =>
    versionRefs.get(documentId) ?? builder.ref("DocumentVersion", documentId, documentVersion);

  const pageEvidence = new Map<string, string[]>();
  for (const item of evidence) {
    const documentId = text(item.document_id);
    const evidenceId = text(item.evidence_id);
    const quote = text(item.quote);
    if (!documentId || !evidenceId || !quote) continue;
    const full = fullPages.get(documentId);
    // Pages are 1-based. Unpaged formats are one page (number 1) when the full text is known.
    const declaredPage = typeof item.page === "number" && Number.isInteger(item.page) ? item.page : null;
    const page = declaredPage !== null ? (declaredPage >= 1 ? declaredPage : null) : full ? 1 : null;
    if (page === null) continue;
    const documentVersion = versionOf(documentId, item);
    const fullPage = full?.find((candidate) => candidate.page === page);
    const segmentStart = fullPage && text(item.segment_id) ? fullPage.segments.get(text(item.segment_id)!) : undefined;
    const span = segmentStart !== undefined && typeof item.start === "number" && typeof item.end === "number"
      ? { page_start: segmentStart + item.start, page_end: segmentStart + item.end } : {};
    builder.add("Evidence", `evidence:${slug(documentId)}:${slug(evidenceId)}`, {
      source_id: documentId, content: quote, content_hash: sha256Hex(quote),
      // A cited quote maps to no acceptance requirement and is not independently verified:
      // evidence.sufficiency.assess must not count it until both are established.
      requirement_ids: [], verified: false,
      ...withExtensions({ evidence_id: evidenceId, document_version: documentVersion, page, locator: text(item.locator), section_path: texts(item.section_path), segment_id: text(item.segment_id), ...span }),
    }, { sourceRefs: [versionRef(documentId, documentVersion)] });
    const key = `${documentId}#${page}`;
    pageEvidence.set(key, [...(pageEvidence.get(key) ?? []), evidenceId]);
  }
  for (const [documentId, pages] of fullPages) {
    const documentVersion = versionOf(documentId);
    const document = record(documents.get(documentId));
    for (const page of pages) {
      builder.add("DocumentPage", `page:${slug(documentId)}:${page.page}`, {
        text: page.text, page: page.page, document_version: documentVersion,
        ...withExtensions({
          text_basis: "full_text", representation: "normalized_text", offset_basis: "unicode_code_points",
          text_sha256: page.textSha256, document_id: documentId, document_family: text(document.family),
          evidence_ids: pageEvidence.get(`${documentId}#${page.page}`) ?? [],
          segments: [...page.segments].map(([segment_id, start]) => ({ segment_id, start })),
          ...(Object.keys(page.geometry).length ? { geometry: page.geometry, regions: page.regions } : {}),
        }),
      }, { sourceRefs: [versionRef(documentId, documentVersion)] });
    }
  }
  return builder.records.length ? { records: builder.records, recordGap: null } : gap("No evidence span or page had a document, page and text.", null);
}
