import { describe, expect, it } from "vitest";
import { sourceDecisionIdsForSelection } from "./index.js";

describe("source lineage at context use", () => {
  it("finds and deduplicates predecessor and canonical-record source decisions", () => {
    expect(sourceDecisionIdsForSelection({
      registry: [{ object_id: "company", provenance: { method: "connector_normalizer", source_decision_id: "SD-registry" } }],
      screening: { sourceAuthorization: { decisionId: "SD-screening" } }, duplicate: { sourceAuthorization: { decisionId: "SD-registry" } },
    })).toEqual(["SD-registry", "SD-screening"]);
  });
  it("blocks legacy external records without authority lineage and permits internal records", () => {
    expect(() => sourceDecisionIdsForSelection([{ provenance: { method: "connector_normalizer" } }])).toThrow("source_authorization_missing");
    expect(sourceDecisionIdsForSelection([{ provenance: { method: "manual_entry" } }, { provenance: { method: "skill_proposal" } }])).toEqual([]);
  });
});
