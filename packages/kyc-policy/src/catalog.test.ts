import { describe, expect, it } from "vitest";

import { KYC_POLICY_ROOT, kycPolicyCatalog } from "./catalog.js";
import { loadPolicyCatalog } from "@ehf/policy-engine";

describe("policy catalog integrity", () => {
  const catalog = kycPolicyCatalog();

  it("loads every authored artifact and cross-checks them", () => {
    expect(catalog.rules.size).toBeGreaterThan(0);
    expect(catalog.reasonCodes.size).toBeGreaterThan(0);
    expect(catalog.obligations.size).toBeGreaterThan(0);
    expect(catalog.tables.size).toBe(3);
    expect([...catalog.gateTables.keys()].sort()).toEqual([
      "decision-ready",
      "disposition",
      "screening-ready",
    ]);
  });

  it("pins a stable bundle digest over the authored sources", () => {
    expect(catalog.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(loadPolicyCatalog(KYC_POLICY_ROOT).bundleDigest).toBe(catalog.bundleDigest);
  });

  it("covers every rule by at least one reason code and vice versa", () => {
    for (const rule of catalog.rules.values()) {
      expect(catalog.reasonCodes.has(rule.reasonCode)).toBe(true);
    }
    const citedCodes = new Set<string>();
    for (const table of catalog.tables.values()) {
      for (const row of table.spec.rows) citedCodes.add(row.reasonCode);
      citedCodes.add(table.spec.default.reasonCode);
    }
    for (const rule of catalog.rules.values()) citedCodes.add(rule.reasonCode);
    for (const code of catalog.reasonCodes.values()) {
      expect(
        citedCodes.has(code.code),
        `reason code ${code.code} is defined but nothing can emit it`,
      ).toBe(true);
    }
  });

  it("only enforces a rule through a table that actually cites it", () => {
    for (const rule of catalog.rules.values()) {
      for (const tableId of rule.enforcedBy) {
        const table = catalog.tables.get(tableId)!;
        const cited = table.spec.rows.some((row) => row.rules.includes(rule.id))
          || table.spec.default.rules.includes(rule.id);
        expect(cited, `${rule.id} claims enforcement by ${tableId} but no row cites it`).toBe(true);
      }
    }
  });

  it("registers a routing queue for every code that needs a human", () => {
    for (const code of catalog.reasonCodes.values()) {
      if (code.outcome === "ALLOW") {
        expect(code.routeTo).toBeNull();
        continue;
      }
      expect(code.routeTo, `${code.code} has no queue`).not.toBeNull();
      expect(catalog.queues.has(code.routeTo!)).toBe(true);
    }
  });
});

describe("authority limits", () => {
  const catalog = kycPolicyCatalog();

  it("permits no automatic decline anywhere in the policy", () => {
    for (const table of catalog.tables.values()) {
      for (const row of table.spec.rows) {
        expect(row.disposition ?? "APPROVED").toBe("APPROVED");
      }
    }
    const decline = catalog.reasonCodes.get("DECLINE_REQUIRES_HUMAN_AUTHORITY")!;
    expect(decline.outcome).toBe("REVIEW");
    expect(decline.humanAuthorityRequired).toBe(true);
    expect(decline.dualControlRequired).toBe(true);
  });

  it("lets only the disposition gate finalize anything", () => {
    const gates = catalog.policy.spec.gates;
    expect(gates["screening-ready"]!.mayFinalizeDisposition).toBe(false);
    expect(gates["decision-ready"]!.mayFinalizeDisposition).toBe(false);
    expect(gates.disposition!.mayFinalizeDisposition).toBe(true);
    expect(gates.disposition!.finalizeConstraints?.allowedDispositions).toEqual(["APPROVED"]);
  });

  it("gates every ALLOW row on eligibility and a valid attestation", () => {
    const table = catalog.tables.get("table.kyc.disposition.v1")!;
    const allowRows = table.spec.rows.filter((row) => row.outcome === "ALLOW");
    expect(allowRows.length).toBeGreaterThan(0);
    for (const row of allowRows) {
      expect(row.when.cohortEligibility, `${row.id} approves without checking eligibility`).toBe("ELIGIBLE");
      expect(row.when.attestation, `${row.id} approves without a valid attestation`).toBe("VALID");
    }
  });

  it("only lets attested cohorts be approved automatically", () => {
    const eligible = [...catalog.riskCohorts.values()].filter((cohort) => cohort.automaticApprovalEligible);
    expect(eligible.length).toBeGreaterThan(0);
    for (const cohort of eligible) {
      expect(cohort.requiresAttestation, `${cohort.id} is auto-approvable without attestation`).toBe(true);
    }
    const constraints = catalog.policy.spec.gates.disposition!.finalizeConstraints!;
    expect(constraints.eligibleCohorts.sort()).toEqual(eligible.map((cohort) => cohort.id).sort());
  });

  it("never defaults a gate to ALLOW", () => {
    for (const table of catalog.tables.values()) {
      expect(table.spec.default.outcome, `${table.metadata.id} falls through to ALLOW`).not.toBe("ALLOW");
    }
    expect(catalog.policy.spec.defaultOutcome).not.toBe("ALLOW");
    expect(catalog.policy.spec.unknownHandling).not.toBe("ALLOW");
    expect(catalog.policy.spec.errorHandling).not.toBe("ALLOW");
  });

  it("routes every UNKNOWN token to a human rather than past a gate", () => {
    for (const table of catalog.tables.values()) {
      for (const condition of table.spec.conditions) {
        if (!condition.tokens.includes("UNKNOWN")) continue;
        const handled = table.spec.rows.some((row) => {
          const expected = row.when[condition.id];
          const values = Array.isArray(expected) ? expected : expected === undefined ? [] : [expected];
          return values.includes("UNKNOWN") && row.outcome !== "ALLOW";
        });
        expect(
          handled,
          `${table.metadata.id} condition ${condition.id} can be UNKNOWN with no row to catch it`,
        ).toBe(true);
      }
    }
  });

  it("keeps every unresolved owner input visible as a release blocker", () => {
    const blocking = [...catalog.ownerInputs.values()].filter(
      (input) => input.blocksRelease && input.status !== "RESOLVED",
    );
    expect(blocking.length).toBeGreaterThan(0);
    for (const input of blocking) {
      expect(Object.keys(input.placeholder).length, `${input.id} has no placeholder to run on`).toBeGreaterThan(0);
    }
  });
});
