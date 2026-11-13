import { describe, expect, it } from "vitest";
import { caseStoreSchemas, renderMigration } from "./config.js";

describe("case store schema configuration", () => {
  it("uses isolated defaults", () => {
    expect(caseStoreSchemas({})).toEqual({ core: "case_core", ledger: "case_ledger", evidence: "evidence" });
  });

  it("renders validated custom schema identifiers", () => {
    const schemas = caseStoreSchemas({
      CASE_CORE_SCHEMA: "poc_case_core",
      CASE_LEDGER_SCHEMA: "poc_case_ledger",
      EVIDENCE_SCHEMA: "poc_evidence",
    });
    expect(renderMigration("{{CASE_CORE_SCHEMA}} {{CASE_LEDGER_SCHEMA}} {{EVIDENCE_SCHEMA}}", schemas))
      .toBe('\"poc_case_core\" \"poc_case_ledger\" \"poc_evidence\"');
  });

  it("rejects identifiers that could alter migration SQL", () => {
    expect(() => caseStoreSchemas({ CASE_CORE_SCHEMA: "case_core; drop schema public" })).toThrow("case_store.schema_invalid");
  });
});
