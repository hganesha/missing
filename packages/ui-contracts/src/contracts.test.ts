import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPERATIONS as GENERATED, type OperationMeta } from "./index.js";
import { declaredResponses, validateResponse, validatorFor } from "./validate.js";

const OPERATIONS: readonly OperationMeta[] = GENERATED;

const personas = JSON.parse(readFileSync(new URL("../vendor/docs/ui/contracts/fixtures/personas.json", import.meta.url), "utf8")) as {
  personas: Array<{ persona: { id: string }; session: unknown }>;
};

describe("operation table", () => {
  it("has every operation in the contract", () => {
    const bundle=JSON.parse(readFileSync(new URL('../vendor/bundle.json',import.meta.url),'utf8'));
    const declared=Object.values(bundle.paths).flatMap(item=>Object.values(item as Record<string,{operationId?:string}>).flatMap(operation=>operation.operationId?[operation.operationId]:[]));
    expect(OPERATIONS.map(operation=>operation.operationId).sort()).toEqual(declared.sort());
    expect(new Set(OPERATIONS.map((op) => op.operationId)).size).toBe(OPERATIONS.length);
  });

  it("marks every non-GET session operation as needing CSRF", () => {
    const unprotected = OPERATIONS.filter((op) => op.method !== "GET" && !op.public && !op.mockOnly && !op.csrf).map((op) => op.operationId);
    expect(unprotected).toEqual([]);
  });

  it("names an upstream for every non-mock operation", () => {
    expect(OPERATIONS.filter((op) => !op.mockOnly && !op.xUpstream && !op.public).map((op) => op.operationId)).toEqual([]);
  });
});

describe("validators", () => {
  it("compiles a validator for every declared JSON response", () => {
    const failures: string[] = [];
    for (const { operationId, status } of declaredResponses()) {
      if (!/^\d{3}$/.test(status)) continue;
      try {
        validateResponse(operationId, Number(status), {});
      } catch (error) {
        failures.push(`${operationId} ${status}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("accepts every persona session fixture as a Session", () => {
    const validate = validatorFor("Session");
    for (const { persona, session } of personas.personas) {
      expect(validate(session), `${persona.id}: ${JSON.stringify(validate.errors?.slice(0, 2))}`).toBe(true);
    }
  });

  it("rejects a malformed Session", () => {
    expect(validatorFor("Session")({ roles: "not-an-array" })).toBe(false);
  });

  it("validates graph operations and retains arbitrary JSON Schema contracts", () => {
    const validate = validatorFor("AuthoringGraphMutation");
    expect(validate({ type: "insert-on-edge", edgeId: "review-path", node: { id: "review", kind: "approval", name: "Review evidence", position: { x: 300, y: 180 } } })).toBe(true);
    expect(validate({ type: "layout", positions: [{ nodeId: "review", position: { x: 300, y: 180 } }] })).toBe(true);
    expect(validate({ type: "update-contract", nodeId: "review", inputSchema: { type: "object", required: ["caseId"], properties: { caseId: { type: "string" } } }, outputSchema: { type: "object" }, contextSelectorIds: [] })).toBe(true);
    expect(validate({ type: "insert-on-edge", edgeId: "review-path", node: { id: "agent", kind: "agent", name: "Unbound agent" } })).toBe(false);
    expect(validate({ type: "update-node", nodeId: "review", name: "Review" })).toBe(false);
    expect(validate({ type: "layout", positions: [] })).toBe(false);
  });
});
