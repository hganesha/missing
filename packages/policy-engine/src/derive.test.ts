import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { compileBusinessPolicy, type BusinessPolicySource } from "./business-policy.js";
import { deriveDiligenceContent, summarizeDiligenceDecisions } from "./diligence/derive.js";
import { evaluateDiligence } from "./diligence/evaluate.js";
import { diligenceDesignSchema, projectDiligenceDesign } from "./diligence/schema.js";
import { projectInstallationContent, validateInstallationContent } from "./installation-content.js";

const kyb = parse(readFileSync(new URL("../../../domains/kyb-agentic/policy.yaml", import.meta.url), "utf8")) as BusinessPolicySource;
const design = diligenceDesignSchema.parse(parse(readFileSync(new URL("../../../domains/policy/diligence/bank-synthetic.yaml", import.meta.url), "utf8")));
const source = projectDiligenceDesign(design, kyb.policySets);

describe("content derived from the diligence block", () => {
  it("plans work from the decision's resolved requirements: levels and the rules that add obligations", () => {
    expect(deriveDiligenceContent(source, "edd_triggers")).toEqual([
      { id: "diligence-level-edd", predicate: { field: "diligence_level", op: "eq", value: "EDD" }, tasks: ["EVD-ADVERSE-MEDIA", "EVD-SOURCE-OF-FUNDS", "EVD-EDD-NARRATIVE"] },
      // Confirmed adverse media adds public-source research: its own trigger, firing when the decision lists it.
      { id: "diligence-rule-adverse-media", predicate: { field: "diligence_requirements", op: "contains", value: "EVD-PUBLIC-SOURCE-RESEARCH" }, tasks: ["EVD-PUBLIC-SOURCE-RESEARCH"] },
    ]);
    const requirements = deriveDiligenceContent(source, "requirements") as Array<{ id: string; description: string; when: { field: string; op: string; value: string } }>;
    expect(requirements).toHaveLength(11);
    // Each requirement applies exactly when the decision lists it.
    for (const entry of requirements) expect(entry.when).toEqual({ field: "diligence_requirements", op: "contains", value: entry.id });
    expect(requirements.find((entry) => entry.id === "EVD-SANCTIONS-SCREENING")!.description).toBe("Required at SDD, CDD, EDD due diligence, and when the customer holds a product as authorized user.");
    expect(requirements.find((entry) => entry.id === "EVD-PUBLIC-SOURCE-RESEARCH")!.description).toBe("Required when Confirmed adverse media adds it.");
  });

  it("is materialized into the compiled policy sets, validated by the library contract and projected to skills", () => {
    const policy = structuredClone(kyb);
    for (const set of policy.policySets) {
      const fields = (set.configuration.content as { fields: Record<string, unknown> }).fields;
      fields.edd_triggers = { status: "DERIVED", owner: "installation.policy.owner", from: "diligence" };
      fields.requirements = { status: "DERIVED", owner: "installation.policy.owner", from: "diligence" };
    }
    const compiled = compileBusinessPolicy(policy, { opaVersion: "1.9.0" });
    const set = compiled.policySets[0]!;
    const { unresolved } = validateInstallationContent(set.configuration.content, set.scope.jurisdiction);
    expect(unresolved).not.toContain("edd_triggers");
    expect(unresolved).not.toContain("requirements");
    expect(compiled.releaseBlockers.map((blocker) => blocker.id)).not.toContain(`${set.id}:edd_triggers`);
    const projected = projectInstallationContent(set, ["edd_triggers", "requirements"], []);
    expect(projected.unresolved).toEqual([]);
    expect(projected.values.edd_triggers).toEqual(deriveDiligenceContent(compiled.source.diligence!, "edd_triggers"));
    // The source keeps the instruction, not the value: an edited design changes the compiled sets.
    expect((compiled.source.policySets[0]!.configuration.content as { fields: Record<string, { status: string }> }).fields.edd_triggers!.status).toBe("DERIVED");
    const edited = structuredClone(policy);
    edited.diligence!.requirements.EDD = [...edited.diligence!.requirements.EDD!, "EVD-PUBLIC-SOURCE-RESEARCH"];
    const recompiled = compileBusinessPolicy(edited, { opaVersion: "1.9.0" });
    const tasks = (projectInstallationContent(recompiled.policySets[0]!, ["edd_triggers"], []).values.edd_triggers as Array<{ tasks: string[] }>)[0]!.tasks;
    expect(tasks).toContain("EVD-PUBLIC-SOURCE-RESEARCH");
  });

  it("refuses a derived field without a diligence block, or one it cannot derive", () => {
    const withoutBlock = structuredClone(kyb);
    delete withoutBlock.diligence;
    (withoutBlock.policySets[0]!.configuration.content as { fields: Record<string, unknown> }).fields.edd_triggers = { status: "DERIVED", owner: "o", from: "diligence" };
    expect(() => compileBusinessPolicy(withoutBlock, { opaVersion: "1.9.0" })).toThrow("policy.derived_content_requires_diligence:edd_triggers");
    const unsupported = structuredClone(kyb);
    (unsupported.policySets[0]!.configuration.content as { fields: Record<string, unknown> }).fields.risk_tiers = { status: "DERIVED", owner: "o", from: "diligence" };
    expect(() => compileBusinessPolicy(unsupported, { opaVersion: "1.9.0" })).toThrow("policy.derived_content_unsupported:risk_tiers");
  });
});

describe("monitoring summary", () => {
  it("counts levels, cells, overlays that fired and decided, escalations and unresolved reasons", () => {
    const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T00:00:00Z`;
    const decided = (facts: Record<string, unknown>, scope: Record<string, unknown>, day: number) => ({
      gateId: "diligence-level", evaluatedAt: at(day), scope: { jurisdiction: "US", ...scope },
      result: evaluateDiligence(source, { facts: { asOf: at(day), selected: { policyRecordPEPRelationship: [], policyCaseFindings: [], policyRecordGeographyExposure: [], packOwnership: [], ...facts } },
        configuration: kyb.policySets[0]!.configuration, scope: { customerType: "corporate", ...scope } }),
    });
    const receipts = [
      decided({}, { products: ["deposit"], legalForm: "corporation" }, 1),
      decided({ policyRecordPEPRelationship: [{ data: { verified: true } }] }, { products: ["deposit", "payments"], legalForm: "corporation" }, 2),
      decided({ policyRecordPEPRelationship: [{ data: { verified: true } }] }, { products: ["payments"], legalForm: "ordinary_trust" }, 3),
      decided({}, { products: ["deposit"], legalForm: "unknown" }, 4),
    ];
    const summary = summarizeDiligenceDecisions(receipts, source.levels);
    expect(summary).toMatchObject({ total: 4, decided: 3, unresolved: 1, byLevel: { CDD: 1, EDD: 2 }, escalated: 1, unresolvedReasons: { DILIGENCE_PARTY_TYPE_UNKNOWN: 1 },
      byJurisdiction: { US: 4 }, first: at(1), last: at(4) });
    // The PEP overlay fired twice but only changed the outcome for the company; the trust's payments cell was already EDD.
    expect(summary.overlays).toEqual([{ id: "overlay.pep", fired: 2, decisive: 1 }]);
    expect(summary.cells).toEqual([
      { partyType: "company", product: "deposit", total: 2, byLevel: { CDD: 1, EDD: 1 } },
      { partyType: "company", product: "payments", total: 1, byLevel: { EDD: 1 } },
      { partyType: "trust", product: "payments", total: 1, byLevel: { EDD: 1 } },
    ]);
  });
});
