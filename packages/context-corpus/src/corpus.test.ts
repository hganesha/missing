import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_RECORDS_PER_COMMAND, readManifest, readParty, seedParty, toCanonicalInput, validateParty } from "./index.js";

const root = fileURLToPath(new URL("../../../fixtures/context-corpus", import.meta.url));

describe("context corpus fixtures", () => {
  const manifest = readManifest(root);

  it("lists the heroes with matching digests, and records the crowd", () => {
    expect(manifest.parties.map((p) => p.id)).toEqual(["H01", "H02", "H03", "H04", "H05", "H06", "H07", "H10", "H12"]);
    expect((manifest as any).crowd).toMatchObject({ parties: 1500 });
    for (const p of manifest.parties) expect(readParty(root, p.id).records).toHaveLength(p.record_count);
  });

  it.each(["H01", "H02", "H03", "H04", "H05", "H06", "H07", "H10", "H12"])("%s: every record passes the platform record contract", (id) => {
    expect(validateParty(readParty(root, id))).toEqual([]);
  });

  it.each(["H01", "H04", "H05", "H07", "H10"])("%s: one complete DatasetScope whose count matches the transactions", (id) => {
    const { records } = readParty(root, id);
    const scopes = records.filter((r) => r.object_type === "DatasetScope");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.data).toMatchObject({ complete: true, expected_count: records.filter((r) => r.object_type === "Transaction").length });
  });

  it("rejects a record that violates its closed schema", () => {
    const dossier = readParty(root, "H04");
    const bad = structuredClone(dossier);
    (bad.records.find((r) => r.object_type === "OwnershipInterest")!.data as Record<string, unknown>).interest = "1.5";
    expect(validateParty(bad).join("\n")).toContain("OwnershipInterest");
  });

  it("detects a tampered records file", () => {
    expect(() => readParty(root, "H99")).toThrow("corpus.party_unknown");
  });

  it("maps records to canonical inputs without losing ids or subjects", () => {
    const record = readParty(root, "H04").records.find((r) => r.object_type === "BeneficialOwner")!;
    const input = toCanonicalInput(record);
    expect(input.object_id).toBe(record.id);
    expect(input.subject_ids).toEqual(record.subject_ids);
    expect(input.provenance.method).toBe("manual_entry");
  });
});

describe("seedParty", () => {
  const options = {
    baseUrl: "http://case-api.test", tenantId: "tenant-synthetic", token: "t",
    policySnapshotDigest: "a".repeat(64), harnessPlanDigest: "b".repeat(64), permissionEnvelopeDigest: "c".repeat(64),
  };

  it("opens the case, adds every subject and batches records within the command limit", async () => {
    const calls: { path: string; body: any; key: string | null }[] = [];
    let seq = 1;
    const fake = (async (url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ path: url.pathname, body, key: (init.headers as Record<string, string>)["idempotency-key"] ?? null });
      if (url.pathname === "/v1/cases") return new Response(JSON.stringify({ created: true, case: { caseId: "case-1", caseSequence: seq } }));
      expect(body.preconditions.caseSequence).toBe(seq);
      seq += 1;
      return new Response(JSON.stringify({ outcome: "ACCEPTED", caseSequence: seq }));
    }) as unknown as typeof fetch;

    const dossier = readParty(root, "H04");
    const result = await seedParty(dossier, { ...options, fetch: fake });
    const commands = calls.filter((c) => c.path.endsWith("/commands"));
    const subjectCmds = commands.filter((c) => c.body.commandType === "AddSubject");
    const recordCmds = commands.filter((c) => c.body.commandType === "RecordCanonicalRecords");
    expect(subjectCmds).toHaveLength(dossier.case.subjects.length);
    // Records and the party's documents (delivery plan W3).
    const seeded = recordCmds.flatMap((c) => c.body.payload.records);
    expect(dossier.documents?.length).toBe(8);
    expect(seeded).toHaveLength(dossier.records.length + dossier.documents!.length);
    expect(seeded.filter((r: { object_type: string }) => r.object_type === "DocumentPage")).toHaveLength(4);
    expect(recordCmds.every((c) => c.body.payload.records.length <= MAX_RECORDS_PER_COMMAND)).toBe(true);
    expect(calls.every((c) => c.path !== "/v1/cases" || c.key === "corpus:H04:case")).toBe(true);
    expect(new Set(commands.map((c) => c.body.idempotencyKey)).size).toBe(commands.length);
    expect(result).toMatchObject({ caseId: "case-1", recordsWritten: dossier.records.length + dossier.documents!.length });
  });

  it("surfaces an API refusal", async () => {
    const fake = (async () => new Response("{\"error\":\"authorization.tenant_mismatch\"}", { status: 403 })) as unknown as typeof fetch;
    await expect(seedParty(readParty(root, "H01"), { ...options, fetch: fake })).rejects.toThrow("corpus.seed_failed");
  });
});
