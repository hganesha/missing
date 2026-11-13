import { toCanonicalInput, type PartyDossier } from "./corpus.js";

export const MAX_RECORDS_PER_COMMAND = 200;

export type SeedOptions = {
  baseUrl: string;
  tenantId: string;
  /** Bearer token of the development principal (the initial deployer, §8.1 of the plan). */
  token: string;
  policySnapshotDigest: string;
  harnessPlanDigest: string;
  permissionEnvelopeDigest: string;
  actor?: { type: "HUMAN"; principalId: string; roles: string[] };
  /** Case API delegation: the edge token above acts for this human (x-actor-id / x-actor-roles). Default `Case.Analyst`. */
  actorRoles?: string[];
  /** The policy pin of the case's plan (the plan's case authority). Omitted, the case carries only the snapshot digest. */
  policyAuthority?: { policyId: string; policyVersion: string; policyBundleDigest: string; dependencyDigest: string };
  /** The policy jurisdiction the case's pack covers. Default: the case API's (US). */
  jurisdiction?: string;
  /** `kyb_onboarding` for a business or trust. Default `kyc_onboarding`. */
  caseType?: "kyc_onboarding" | "kyb_onboarding";
  /**
   * A separate copy of the party: its own external reference and idempotency scope, so the same
   * party can be loaded again as a fresh case (a sandbox run). Default: the party's one corpus case.
   */
  copy?: string;
  fetch?: typeof fetch;
};
export type SeedResult = { caseId: string; created: boolean; recordsWritten: number; subjectsAdded: number; commands: number };

type Json = Record<string, unknown>;

/**
 * Seed one party: open the case (idempotent on the external ref), add its subjects, then write
 * all canonical records in batches. Every command carries a deterministic idempotency key, so a
 * rerun adds nothing. The party must run as a human principal: the case API refuses agent and
 * integration actors without an integration envelope.
 */
export async function seedParty(dossier: PartyDossier, options: SeedOptions): Promise<SeedResult> {
  const http = options.fetch ?? fetch;
  const actor = options.actor ?? { type: "HUMAN" as const, principalId: "corpus-loader", roles: [] };
  const call = async (method: string, path: string, body: unknown, idempotencyKey?: string): Promise<Json> => {
    const response = await http(new URL(path, options.baseUrl), {
      method,
      headers: {
        "content-type": "application/json", authorization: `Bearer ${options.token}`,
        "x-actor-id": actor.principalId, "x-actor-roles": (options.actorRoles ?? ["Case.Analyst"]).join(","),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`corpus.seed_failed ${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as Json;
  };

  const scope = options.copy ? `corpus:${dossier.id}:${options.copy}` : `corpus:${dossier.id}`;
  const commandScope = options.copy ? `corpus-${dossier.id}-${options.copy}` : `corpus-${dossier.id}`;
  const caseType = options.caseType ?? "kyc_onboarding";
  const created = await call("POST", "/v1/cases", {
    tenantId: options.tenantId, caseType, schemaVersion: caseType === "kyb_onboarding" ? "kyb.case.v1" : "kyc.case.v1",
    externalRef: options.copy ? `${dossier.case.external_ref}-${options.copy}` : dossier.case.external_ref,
    policySnapshotDigest: options.policySnapshotDigest, harnessPlanDigest: options.harnessPlanDigest,
    ...(options.jurisdiction ? { jurisdiction: options.jurisdiction } : {}),
    ...(options.policyAuthority ? { policyAuthority: options.policyAuthority } : {}), actor,
  }, `${scope}:case`);
  const caseRow = created.case as { caseId: string; caseSequence: number };
  const caseId = caseRow.caseId;
  // Always start from the creation sequence, not the case's current one: a replayed command must
  // carry the same preconditions as the original (they are part of its request digest), and each
  // replayed response returns the sequence it originally got, which advances this counter.
  let sequence = 1;
  let commands = 0;

  const command = async (commandType: string, payload: Json, key: string) => {
    const result = await call("POST", `/v1/cases/${encodeURIComponent(caseId)}/commands`, {
      commandId: `${commandScope}-${key}`, commandType, commandVersion: "1", tenantId: options.tenantId, caseId, actor,
      authority: {
        planDigest: options.harnessPlanDigest, permissionEnvelopeDigest: options.permissionEnvelopeDigest,
        policySnapshotDigest: options.policySnapshotDigest,
      },
      payload, preconditions: { caseSequence: sequence }, idempotencyKey: `${scope}:${key}`,
    });
    if (typeof result.caseSequence === "number") sequence = result.caseSequence;
    commands += 1;
  };

  for (const subject of dossier.case.subjects) {
    await command("AddSubject", {
      subjectId: subject.entity_id, subjectType: subject.subject_type, displayName: subject.name,
      attributes: { corpus_ref: subject.ref, role: subject.role },
      identifiers: subject.identifiers.map((i) => ({ identifierType: i.identifier_type, value: i.value, source: i.source })),
    }, `subject:${subject.ref}`);
  }

  // The party's documents are case records too: the document agent reads their pages.
  const inputs = [...dossier.records, ...(dossier.documents ?? [])].map(toCanonicalInput);
  for (let i = 0; i < inputs.length; i += MAX_RECORDS_PER_COMMAND) {
    await command("RecordCanonicalRecords", { records: inputs.slice(i, i + MAX_RECORDS_PER_COMMAND) }, `records:${i / MAX_RECORDS_PER_COMMAND}`);
  }
  return { caseId, created: created.created === true, recordsWritten: inputs.length, subjectsAdded: dossier.case.subjects.length, commands };
}
