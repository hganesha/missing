import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectorCatalogSchema } from "@ehf/contracts";
import { createDatabase } from "./index.js";
import { catalogCapabilityDraft, getConnector, listConnectors, seedConnectorCatalog, upsertConnector, type ConnectorClient } from "./connectors.js";

const catalog = connectorCatalogSchema.parse(JSON.parse(
  readFileSync(new URL("../../../config/connector-catalog.json", import.meta.url), "utf8"),
));

describe("connector catalog seed", () => {
  it("derives a registry-valid draft contract for every catalog capability", () => {
    for (const capability of catalog.capabilities) {
      const draft = catalogCapabilityDraft(capability);
      expect(draft.status).toBe("draft");
      expect(draft.adapterBindingId).toBe(capability.defaultConnectorId ?? draft.adapterBindingId);
      if (!capability.defaultConnectorId) expect(draft.adapterBindingId).toMatch(/^unconfigured:/);
    }
  });

  it("filters and pages the registry with keyset cursors", async () => {
    const calls: unknown[][] = [];
    const row = (id: string) => ({
      connector_id: id,
      definition: catalog.connectors.find((connector) => connector.connectorId === id),
      definition_digest: "a".repeat(64), status: "available", created_at: new Date(0), updated_at: new Date(0),
    });
    const db = {
      query: async (_text: string, values?: unknown[]) => {
        calls.push(values ?? []);
        return { rows: [row("wiring:companies-house:business.officers.lookup"), row("wiring:companies-house:business.ownership.discover")] };
      },
    } as unknown as ConnectorClient;
    const page = await listConnectors(db, { providerId: "companies-house", limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.connector.capabilityId).toBe("business.officers.lookup.v1");
    expect(page.nextCursor).not.toBeNull();
    await listConnectors(db, { cursor: page.nextCursor!, limit: 1 });
    expect(calls[1]![4]).toBe("wiring:companies-house:business.officers.lookup");
    await expect(listConnectors(db, { cursor: "not-a-cursor" })).rejects.toThrow("pagination.cursor_invalid");
    await expect(listConnectors(db, { limit: 0 })).rejects.toThrow("pagination.limit_invalid");
  });

  const templated = {
    connectorId: "databricks-serving:kyc-llm", adapterId: "databricks-serving", providerId: "databricks", providerName: "Databricks",
    capabilityId: "model.general.inference.v1", operation: "kyc-llm", resultFamily: null, status: "available", demoSupported: false,
    liveBlockers: [], source: { catalog: "ehfconcept/platform", revision: "connector-template:databricks-serving" },
  };

  it("upserts one validated connector and never lifts an operator quarantine", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db = {
      query: async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        return { rows: [{ definition: JSON.parse(String(values[4])), definition_digest: values[5], status: values[6], created_at: new Date(0), updated_at: new Date(0), inserted: true }] };
      },
    } as unknown as ConnectorClient;
    const result = await upsertConnector(db, templated);
    expect(result.created).toBe(true);
    expect(result.record.connector.connectorId).toBe("databricks-serving:kyc-llm");
    expect(calls[0]!.values.slice(0, 4)).toEqual(["databricks-serving:kyc-llm", "model.general.inference.v1", "databricks-serving", "databricks"]);
    expect(calls[0]!.text).toContain("when connector_registry.status in ('quarantined', 'retired') then connector_registry.status");
    await expect(upsertConnector(db, { ...templated, adapterId: "http-operation" })).rejects.toThrow(/connector.adapter_prefix_mismatch/);
    await expect(upsertConnector(db, { ...templated, capabilityId: "model.general" })).rejects.toThrow();
  });
});

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("connector registry in PostgreSQL", () => {
  it("seeds additively and never lowers an operator's connector status", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    try {
      await seedConnectorCatalog(db, catalog);
      await db.query("update harness_gateway.connector_registry set status='live_ready' where connector_id='wiring:persona:identity.person.verify'");
      const again = await seedConnectorCatalog(db, catalog);
      expect(again).toEqual({ connectorsCreated: 0, connectorsUpdated: 0, capabilitiesCreated: 0 });
      expect((await getConnector(db, "wiring:persona:identity.person.verify"))?.connector.status).toBe("live_ready");
      const sanctions = await listConnectors(db, { capabilityId: "screening.sanctions.v1", limit: 500 });
      expect(sanctions.items.map((item) => item.connector.connectorId)).toContain("opensanctions:sanctions");

      const connectorId = "databricks-serving:kyc-llm-integration-test";
      await db.query("delete from harness_gateway.connector_registry where connector_id=$1", [connectorId]);
      const definition = {
        connectorId, adapterId: "databricks-serving", providerId: "databricks", providerName: "Databricks",
        capabilityId: "model.general.inference.v1", operation: "kyc-llm-integration-test", resultFamily: null, status: "live_ready",
        demoSupported: false, liveBlockers: [], source: { catalog: "ehfconcept/platform", revision: "connector-template:databricks-serving" },
      };
      expect((await upsertConnector(db, definition)).created).toBe(true);
      await db.query("update harness_gateway.connector_registry set status='quarantined' where connector_id=$1", [connectorId]);
      const reregistered = await upsertConnector(db, definition);
      expect(reregistered).toMatchObject({ created: false, record: { connector: { status: "quarantined" } } });
      await db.query("delete from harness_gateway.connector_registry where connector_id=$1", [connectorId]);
    } finally {
      await db.end();
    }
  });
});
