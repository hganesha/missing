import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeTransactionStatements, parseCamt053, type TransactionScope } from "./transaction-records.js";

const root = fileURLToPath(new URL("../../../fixtures/context-corpus/parties", import.meta.url));
const load = (party: string) => {
  const records = readFileSync(`${root}/${party}/records.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const xml = readFileSync(`${root}/${party}/iso20022/camt.053.xml`, "utf8");
  const accountEntities: Record<string, string> = {};
  for (const r of records) if (r.object_type === "Account") accountEntities[r.id] = r.data.entity_id;
  const scope = records.find((r) => r.object_type === "DatasetScope").data as TransactionScope;
  return { records, xml, accountEntities, scope, customer: JSON.parse(readFileSync(`${root}/${party}/case.json`, "utf8")).customer_entity_id as string };
};
const context = { connectorId: "corpus:replay", capabilityId: "financial.transactions.v1", invocationId: "inv-1", tenantId: "tenant-synthetic" };
const FIELDS = ["source", "target", "amount", "currency", "timestamp", "event_id", "status", "transaction_type", "country"] as const;

describe("financial.transactions.v1 normalizer", () => {
  for (const party of ["H01", "H04", "H05", "H07", "H10"]) {
    it(`${party}: camt.053 normalizes to the committed Transaction records and scope`, () => {
      const c = load(party);
      const out = normalizeTransactionStatements({ statements: [c.xml], scope: c.scope, accountEntities: c.accountEntities }, { ...context, subjectId: c.customer });
      expect(out.recordGap).toBeNull();
      const expected = new Map(c.records.filter((r: any) => r.object_type === "Transaction").map((r: any) => [r.data.event_id, r]));
      const txs = out.records.filter((r) => r.object_type === "Transaction");
      expect(txs).toHaveLength(expected.size);
      for (const t of txs) {
        const want: any = expected.get((t.data as any).event_id);
        for (const f of FIELDS) expect((t.data as any)[f]).toBe(want.data[f]);
        expect(new Set(t.subject_ids)).toEqual(new Set(want.subject_ids));
        expect(t.provenance.method).toBe("connector_normalizer");
      }
      const scope = out.records.find((r) => r.object_type === "DatasetScope")!.data as any;
      expect(scope).toMatchObject({ ...c.scope, complete: true });
    });
  }

  it("is deterministic: the same input yields the same record versions", () => {
    const c = load("H05");
    const run = () => normalizeTransactionStatements({ statements: [c.xml], scope: c.scope }, context).records.map((r) => r.version_id);
    expect(run()).toEqual(run());
  });

  it("writes no DatasetScope when the provider did not state one", () => {
    const c = load("H01");
    const out = normalizeTransactionStatements({ statements: [c.xml] }, context);
    expect(out.records.some((r) => r.object_type === "DatasetScope")).toBe(false);
    expect(out.recordGap?.reason).toContain("DatasetScope");
  });

  it("never marks a scope complete when the returned count disagrees", () => {
    const c = load("H01");
    const out = normalizeTransactionStatements({ statements: [c.xml], scope: { ...c.scope, expected_count: c.scope.expected_count + 5 } }, context);
    expect((out.records.find((r) => r.object_type === "DatasetScope")!.data as any).complete).toBe(false);
  });

  const entry = (extra: string, ref = "evt-1", dir = "CRDT") =>
    `<Document xmlns="urn:iso:std:iso20022:tech:xsd:camt.053.001.08"><Stmt><Acct><Id><Othr><Id>A</Id></Othr></Id></Acct>` +
    `<Ntry><NtryRef>${ref}</NtryRef><Amt Ccy="USD">10.00</Amt><CdtDbtInd>${dir}</CdtDbtInd>${extra}<Sts><Cd>BOOK</Cd></Sts>` +
    `<BookgDt><DtTm>2026-01-05T10:00:00Z</DtTm></BookgDt><BkTxCd><Prtry><Cd>transfer</Cd><Issr>ach</Issr></Prtry></BkTxCd>` +
    `<NtryDtls><TxDtls><RltdPties><Dbtr><Nm>X</Nm></Dbtr><DbtrAcct><Id><Othr><Id>B</Id></Othr></Id></DbtrAcct>` +
    `<Cdtr><Nm>Y</Nm></Cdtr><CdtrAcct><Id><Othr><Id>A</Id></Othr></Id></CdtrAcct></RltdPties><AddtlTxInf>ctry=US</AddtlTxInf></TxDtls></NtryDtls></Ntry></Stmt></Document>`;

  it("maps reversal and pending markers and rejects an entry that disagrees with its statement", () => {
    expect(parseCamt053(entry("<RvslInd>true</RvslInd>"))[0]!.status).toBe("reversed");
    expect(normalizeTransactionStatements({ statements: [entry("", "evt-2", "DBIT")] }, context).recordGap?.reason).toContain("disagrees");
  });

  it("refuses conflicting duplicates, malformed statements and empty results", () => {
    const a = entry("", "evt-3"), b = entry("", "evt-3").replace("10.00", "11.00");
    expect(normalizeTransactionStatements({ statements: [a, b] }, context).recordGap?.reason).toContain("conflicting");
    expect(normalizeTransactionStatements({ statements: [a, a] }, context).records.filter((r) => r.object_type === "Transaction")).toHaveLength(1);
    expect(normalizeTransactionStatements({ statements: ["<x/>"] }, context).records).toEqual([]);
    expect(normalizeTransactionStatements({ statements: [] }, context).recordGap).not.toBeNull();
  });
});

describe("camt.053 parsing stays linear on hostile input", () => {
  it("handles the repetition patterns CodeQL reported without slowing down", () => {
    const hostile = [
      "camt.053" + "<Stmt>".repeat(200_000),
      "camt.053<Stmt>" + "<Acct><Id><Othr><Id>a".repeat(100_000) + "</Stmt>",
      "camt.053<Stmt><Acct><Id><Othr><Id>x</Id>" + "<Ntry>".repeat(200_000) + "</Stmt>",
      "camt.053<Stmt><Acct><Id><Othr><Id>x</Id><Ntry>" + "<AddtlNtryInf>a".repeat(100_000) + "</Ntry></Stmt>",
    ];
    const started = performance.now();
    for (const xml of hostile) { try { parseCamt053(xml); } catch { /* malformed input may be refused */ } }
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
