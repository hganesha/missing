import { describe, expect, it } from "vitest";
import {
  contextBindingSchema,
  resolveContextSourceParameters,
} from "./context-sources.js";
import fixture from "../test-fixtures/context-source.json" with { type: "json" };

const binding = contextBindingSchema.parse({
  ...fixture.binding,
  parameters: [
    {
      name: "customer_id",
      type: "string",
      required: true,
      valueFrom: { source: "input", path: "subject.customerId" },
    },
  ],
});
describe("context source lookup values", () => {
  it("resolves only declared case/entity input paths and ignores caller attempts to override the mapped parameter", () => {
    expect(
      resolveContextSourceParameters(binding, {
        subject: { customerId: "CIF-123", name: "Example" },
        customer_id: "different",
        unrelated: "metadata",
      }),
    ).toEqual({ customer_id: "CIF-123" });
  });
  it("takes case identity only from verified execution authority", () => {
    const scoped = contextBindingSchema.parse({
      ...binding,
      parameters: [
        {
          name: "case_ref",
          type: "string",
          required: true,
          valueFrom: { source: "case_id" },
        },
      ],
    });
    expect(
      resolveContextSourceParameters(
        scoped,
        { caseId: "spoofed" },
        { caseId: "CASE-1042" },
      ),
    ).toEqual({ case_ref: "CASE-1042" });
    expect(() =>
      resolveContextSourceParameters(scoped, { caseId: "spoofed" }),
    ).toThrow("case_authority_required");
  });
  it("fails absent, inherited, null, array and non-scalar input without fallback", () => {
    for (const subject of [
      {},
      { customerId: null },
      [{ customerId: "first" }],
      { customerId: { value: "object" } },
      Object.create({ customerId: "inherited" }),
    ])
      expect(() =>
        resolveContextSourceParameters(binding, {
          subject,
          customer_id: "fallback",
        }),
      ).toThrow(/lookup_value/);
    for (const input of [null, [], "id"])
      expect(() => resolveContextSourceParameters(binding, input)).toThrow(
        "parameter_invalid",
      );
  });
  it("validates scalar types and bounds without coercion and preserves optional omissions", () => {
    for (const [type, valid, invalid] of [
      ["number", 0, "0"],
      ["boolean", false, "false"],
      ["string", "CIF-123", 123],
    ] as const) {
      const typed = contextBindingSchema.parse({
        ...binding,
        parameters: [{ ...binding.parameters[0], type }],
      });
      expect(
        resolveContextSourceParameters(typed, {
          subject: { customerId: valid },
        }).customer_id,
      ).toBe(valid);
      expect(() =>
        resolveContextSourceParameters(typed, {
          subject: { customerId: invalid },
        }),
      ).toThrow("lookup_value_invalid");
    }
    for (const customerId of [" ", "x".repeat(1001), NaN, Infinity])
      expect(() =>
        resolveContextSourceParameters(binding, { subject: { customerId } }),
      ).toThrow("lookup_value_invalid");
    expect(
      resolveContextSourceParameters(
        { parameters: [{ ...binding.parameters[0]!, required: false }] },
        { subject: {} },
      ),
    ).toEqual({});
  });
  it("keeps legacy direct parameters strict and supports explicit mappings mixed with direct values", () => {
    const legacy = contextBindingSchema.parse(fixture.binding);
    const original = {
      customer_id: "CIF-123",
      extra: "still rejected by the connector",
    };
    expect(resolveContextSourceParameters(legacy, original)).toBe(original);
    expect(
      resolveContextSourceParameters(
        {
          parameters: [
            ...binding.parameters,
            { name: "active", type: "boolean", required: true },
          ],
        },
        { subject: { customerId: "CIF-123" }, active: false },
      ),
    ).toEqual({ customer_id: "CIF-123", active: false });
  });
  it("rejects unsafe paths, unknown source modes and numeric case IDs at contract validation", () => {
    for (const path of [
      "subject.__proto__.id",
      "constructor.id",
      "subject.0.id",
      "subjects[0].id",
      "subject..id",
      "x".repeat(301),
      Array(14).fill("field").join("."),
    ])
      expect(
        contextBindingSchema.safeParse({
          ...binding,
          parameters: [
            { ...binding.parameters[0], valueFrom: { source: "input", path } },
          ],
        }).success,
      ).toBe(false);
    expect(
      contextBindingSchema.safeParse({
        ...binding,
        parameters: [
          {
            name: "case",
            type: "number",
            required: true,
            valueFrom: { source: "case_id" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      contextBindingSchema.safeParse({
        ...binding,
        parameters: [
          {
            ...binding.parameters[0],
            valueFrom: { source: "secret", path: "anything" },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
