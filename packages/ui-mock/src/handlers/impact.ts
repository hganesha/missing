import type { DiligenceSource } from "@ehf/policy-engine/diligence";
import { referenceGateResult, regressionSetSchema, runImpact, type RegressionCase } from "@ehf/policy-engine/impact";
import { parse } from "yaml";
import type { Rec } from "../fixtures.js";
import { fail, type Impl, ok } from "../http.js";
import { businessCompilation, businessSource, diligenceRefusal } from "./business-policy.js";
import { digestOf } from "./institutions.js";

// Impact simulation as the control API runs it (phase F), with the reference evaluation in place of OPA.
const SET_FILES = import.meta.glob("../../../../domains/policy/regression/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const SETS = Object.values(SET_FILES).map((text) => regressionSetSchema.parse(parse(text)));

export const impact: Record<string, Impl> = {
  postAuthoringPoliciesImpact: async (ctx) => {
    const sources = [businessSource((ctx.body?.baseline as Rec | undefined)?.files as Rec | undefined), businessSource((ctx.body?.candidate as Rec | undefined)?.files as Rec | undefined)];
    if (sources.some((source) => !source)) return fail(ctx, 400, "policy.impact_input_invalid", "Send the baseline and candidate policy files.");
    const refused = sources.map((source) => diligenceRefusal(source!)).find(Boolean);
    if (refused) return fail(ctx, 400, "policy.compile_failed", refused);
    const candidate = sources[1]!;
    const diligence = candidate.diligence as DiligenceSource | undefined;
    if (!diligence) return fail(ctx, 422, "policy.impact_requires_diligence", "The candidate has no diligence design to simulate.");
    const institution = String(((candidate.policySets as Rec[])[0]!.scope as Rec).institution);
    const diligenceGate = String(diligence.gateId ?? "diligence-level");
    const gateId = ctx.body?.gateId === undefined ? diligenceGate : ctx.body.gateId;
    const known = (source: Rec) => gateId === diligenceGate || Object.hasOwn((source.gates as Rec | undefined) ?? {}, String(gateId));
    if (typeof gateId !== "string" || !sources.every((source) => known(source!))) return fail(ctx, 400, "policy.impact_gate_unknown", "Both policies must define the gate.");
    const set = SETS.find((entry) => entry.metadata.institution === institution);
    if (!set) return fail(ctx, 422, "policy.regression_set_missing", `No regression set for ${institution}.`);
    const side = (source: Rec) => {
      const compiled = businessCompilation(source);
      const policy = { gates: source.gates, diligence: { gateId: "diligence-level", ...(source.diligence as Rec) } } as unknown as Parameters<typeof referenceGateResult>[0];
      return {
        ref: { policyId: String((source.metadata as Rec).id), version: String((source.metadata as Rec).version), bundleDigest: digestOf(source) },
        sets: compiled.policySets as Array<Rec & { id: string; scope: { jurisdiction: string; institution: string; products: string[]; customerTypes: string[] }; configuration: Rec }>,
        evaluate: async (policySet: { configuration: Rec }, entry: RegressionCase, facts: Rec, gate: string) => referenceGateResult(policy, gate, { gateId: gate, inputProfile: "canonical.onboarding.v2", facts, observations: {}, subjectIds: [],
          configuration: policySet.configuration, scope: { jurisdiction: entry.scope.jurisdiction, institution, products: [...entry.scope.products].sort(), customerType: entry.scope.customerType, legalForm: entry.scope.legalForm } }),
      };
    };
    const report = await runImpact({ set, gateId, diligenceGateId: diligenceGate, levels: diligence.levels, baseline: side(sources[0]!), candidate: side(candidate) });
    return ok(ctx, { report, digest: digestOf(report) });
  },
};
