import { expect, it } from "vitest";
import type { ContextPack } from "@ehf/context-plane";
import { createContextStore, recordContextPack } from "./index.js";

// Under the production profile a pack body (it holds case data) goes to the pack container or
// nowhere: there is no database fallback (data-stores-plan.md §3.6).
it("refuses to keep a pack body in the database under the production profile", async () => {
  const store = createContextStore({ connectionString: "postgresql://unused@127.0.0.1:1/x", packBlobs: null, env: { SECURITY_PROFILE: "production" } });
  try {
    const pack = { runId: "run", nodeId: "node", packDigest: "a".repeat(64), manifest: null } as unknown as ContextPack;
    await expect(recordContextPack(store, { tenantId: "t", caseId: "c", runId: "run", nodeId: "node", attempt: 1, pack }))
      .rejects.toThrow("context_store.pack_blob_required_in_production");
  } finally { await store.db.end(); }
});
