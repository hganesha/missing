import { describe, expect, it } from "vitest";
import { SeparationOfDutiesError, setAuthoringLifecycle, type Database } from "./index.js";

const draftRow = {
  draft_id: "draft_1", name: "d", domain: "kyc", version: "0.1.0", status: "APPROVED",
  revision: 3, package_source: "", workflow_source: "", parsed_package: {}, parsed_workflow: {},
  compiled_plan: null, diagnostics: [], evaluation_report: null, approved_by: "approver",
  published_plan_digest: null, created_at: new Date(), updated_at: new Date(),
};

/** Stands in for a draft whose listed actors contributed content. */
function database(contributors: string[]): Database {
  return {
    query: async (text: string) => {
      if (text.includes("from harness_control.authoring_events")) {
        return { rowCount: contributors.length, rows: contributors.map((actor) => ({ actor })) };
      }
      return { rowCount: 1, rows: [draftRow] };
    },
  } as unknown as Database;
}

describe("separation of duties", () => {
  it("refuses approval by someone who shaped the draft", async () => {
    // approved_by was previously written and never compared with anything, so one
    // identity could author, evaluate, approve and publish its own plan.
    await expect(setAuthoringLifecycle(database(["author@example.test"]), "draft_1", {
      expectedStatus: "EVALUATED", status: "APPROVED", actor: "author@example.test",
    })).rejects.toBeInstanceOf(SeparationOfDutiesError);
  });

  it("refuses publication by a contributor too", async () => {
    await expect(setAuthoringLifecycle(database(["author@example.test"]), "draft_1", {
      expectedStatus: "APPROVED", status: "PUBLISHED", actor: "author@example.test",
    })).rejects.toBeInstanceOf(SeparationOfDutiesError);
  });

  it("allows an independent approver", async () => {
    await expect(setAuthoringLifecycle(database(["author@example.test"]), "draft_1", {
      expectedStatus: "EVALUATED", status: "APPROVED", actor: "approver@example.test",
    })).resolves.toMatchObject({ draftId: "draft_1" });
  });

  it("does not gate transitions that confer no authority", async () => {
    // Compiling and evaluating your own draft is ordinary authoring work.
    await expect(setAuthoringLifecycle(database(["author@example.test"]), "draft_1", {
      expectedStatus: "COMPILED", status: "EVALUATED", actor: "author@example.test",
    })).resolves.toMatchObject({ draftId: "draft_1" });
  });
});
