import { describe, expect, it } from "vitest";
import { sandboxPayloadShape, sandboxSkillObservationSchema } from "./sandbox-observation.js";

describe("sandbox payload capture", () => {
  it("retains allowlisted structure while masking scalar values and dynamic keys", () => {
    const raw = {
      context: { records: [{ object_type: "DocumentPage", data: { name: "person-to-mask", token: "secret-to-mask" } }] },
      "private-key-value": "private-value",
      parameters: { identifiers: ["customer-secret-1", "customer-secret-2"] },
    };
    const result = sandboxPayloadShape(raw)!;
    expect(result.fields).toEqual(expect.arrayContaining([
      { path: "$/context/records", type: "array", count: 1 },
      { path: "$/parameters/identifiers", type: "array", count: 2 },
      { path: "$/~other", type: "omitted", count: 1 },
    ]));
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/customer-secret|person-to-mask|secret-to-mask|private-key-value|private-value|token/);
    expect(sandboxPayloadShape(undefined)).toBeNull();
  });

  it("rejects a preview submitted with raw values or unapproved field paths", () => {
    const base = {
      kind: "skill", nodeId: "document-check", key: "skill:node:document.check", invocationId: null,
      data: { skillId: "document.check", skillVersion: "1.0.0", status: "COMPLETED", contextHash: null,
        resultDigest: null, documents: [], input: sandboxPayloadShape({ name: "sensitive" }), output: null },
    };
    expect(sandboxSkillObservationSchema.safeParse(base).success).toBe(true);
    for (const field of [
      { path: "$/private-key-value", type: "string", count: null },
      { path: "$/name", type: "string", count: null, value: "private value" },
    ]) {
      expect(sandboxSkillObservationSchema.safeParse({
        ...base, data: { ...base.data, input: { fields: [field], truncated: false } },
      }).success).toBe(false);
    }
  });
});
