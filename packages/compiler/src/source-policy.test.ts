import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyHarnessPlanDigest, harnessPlanV2Schema } from "@ehf/contracts";
import { compilePackage } from "./compiler.js";
import { parsePackage } from "./package.js";
import { invoiceFixture, INVOICE_PACKAGE, invoiceWorkflowWithGroupAndSubgraph, modelProfilesPath } from "./test-support.js";

describe("source policy pins in compiled plans", () => {
  const pins = { policyDigests: ["a".repeat(64)], bindings: parsePackage(INVOICE_PACKAGE).capabilities.map((capability) => ({
    capabilityId: capability.id, connectorId: capability.adapterBindingId, bindingDigest: "b".repeat(64), accessDigest: "c".repeat(64),
  })) };
  const compile = (sourceAuthorization: unknown) => {
    const directory = invoiceFixture("source-policy", `${INVOICE_PACKAGE}\nsourceAuthorization: ${JSON.stringify(sourceAuthorization)}\n`, invoiceWorkflowWithGroupAndSubgraph());
    try { return compilePackage(directory, { modelProfiles: modelProfilesPath }); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  };
  it("includes policy and binding pins in the plan digest", () => {
    const compiled = compile(pins);
    const plan = harnessPlanV2Schema.parse(compiled.plan);
    expect(verifyHarnessPlanDigest(plan)).toBe(true);
    expect(plan.sourceAuthorization).toEqual(pins);
    expect(compile({ ...pins, policyDigests: ["d".repeat(64)] }).planDigest).not.toBe(compiled.planDigest);
  });
  it("refuses missing, duplicate, unknown or unbound source pins", () => {
    for (const invalid of [{ ...pins, bindings: [] }, { ...pins, bindings: [...pins.bindings, pins.bindings[0]] },
      { ...pins, bindings: [{ ...pins.bindings[0], capabilityId: "unknown.v1" }] },
      { ...pins, bindings: [{ ...pins.bindings[0], connectorId: "wiring:unbound:source" }] },
      { ...pins, bindings: pins.bindings.slice(1) }]) expect(() => compile(invalid)).toThrow(/package.source_/);
  });
});
