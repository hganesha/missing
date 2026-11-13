import { describe, expect, it } from "vitest";
import {
  connectorCoverageSchema,
  coverageEntryFor,
  coverageReasonFromError,
  evaluateConnectorCoverage,
  platformSettingsSchema,
  PLATFORM_SETTING_DEFAULTS,
} from "./index.js";

const now = new Date("2026-11-07T12:00:00Z");
const all = { require_entitlement: true, require_jurisdiction_coverage: true, require_list_freshness: true };
const coverage = connectorCoverageSchema.parse({
  "wiring:*": { entitled: true, jurisdictions: ["US"], lists: null },
  "wiring:opensanctions:*": { entitled: true, jurisdictions: ["US", "GB"], lists: { mode: "snapshot", items: [{ id: "us-ofac-sdn", asOf: "2026-11-07T06:00:00Z", maxAgeHours: 24 }] } },
  "opensanctions:sanctions": { entitled: true, jurisdictions: ["*"], lists: { mode: "provider_hosted", attestedBy: "operator" } },
});
const evaluate = (connectorId: string, jurisdiction: string | null, policy = all) => evaluateConnectorCoverage({ coverage, connectorId, policy, jurisdiction, now });

describe("connector coverage", () => {
  it("resolves the exact key, else the longest matching prefix", () => {
    expect(coverageEntryFor(coverage, "opensanctions:sanctions")?.key).toBe("opensanctions:sanctions");
    expect(coverageEntryFor(coverage, "wiring:opensanctions:screening.pep")?.key).toBe("wiring:opensanctions:*");
    expect(coverageEntryFor(coverage, "wiring:gleif:lei")?.key).toBe("wiring:*");
    expect(coverageEntryFor(coverage, "opensanctions:pep")).toBeNull();
  });

  it("is eligible only for what the operator attests, checked in a fixed order", () => {
    expect(evaluate("wiring:opensanctions:screening.sanctions", "gb")).toEqual({ eligible: true, entryKey: "wiring:opensanctions:*" });
    expect(evaluate("opensanctions:sanctions", "BR")).toMatchObject({ eligible: true });
    expect(evaluate("opensanctions:pep", "US")).toMatchObject({ eligible: false, reason: "coverage_unregistered" });
    expect(evaluate("wiring:opensanctions:screening.sanctions", null)).toMatchObject({ eligible: false, reason: "jurisdiction_unknown" });
    expect(evaluate("wiring:opensanctions:screening.sanctions", "DE")).toMatchObject({ eligible: false, reason: "jurisdiction_not_covered", detail: "DE" });
    expect(evaluate("wiring:gleif:lei", "US")).toMatchObject({ eligible: false, reason: "list_freshness_unknown" });
    expect(evaluateConnectorCoverage({ coverage, connectorId: "wiring:opensanctions:x", policy: all, jurisdiction: "US", now: new Date("2026-11-08T07:00:00Z") }))
      .toMatchObject({ eligible: false, reason: "list_stale", detail: "us-ofac-sdn" });
  });

  it("checks only what the policy requires, and nothing when it requires nothing", () => {
    expect(evaluate("wiring:gleif:lei", "US", { ...all, require_list_freshness: false })).toMatchObject({ eligible: true });
    expect(evaluate("unregistered:x", null, { require_entitlement: false, require_jurisdiction_coverage: false, require_list_freshness: false }))
      .toEqual({ eligible: true, entryKey: null });
    const unentitled = connectorCoverageSchema.parse({ "x:y": { entitled: false, jurisdictions: ["*"] } });
    expect(evaluateConnectorCoverage({ coverage: unentitled, connectorId: "x:y", policy: { ...all, require_list_freshness: false }, jurisdiction: "US", now }))
      .toMatchObject({ eligible: false, reason: "entitlement_missing" });
  });

  it("rejects malformed entries and defaults to attesting nothing", () => {
    expect(connectorCoverageSchema.safeParse({ "x:y": { entitled: true, jurisdictions: ["usa"] } }).success).toBe(false);
    expect(connectorCoverageSchema.safeParse({ "x:y": { entitled: true, jurisdictions: [], extra: 1 } }).success).toBe(false);
    expect(connectorCoverageSchema.safeParse({ "x:y": { entitled: true, jurisdictions: [], lists: { mode: "snapshot", items: [] } } }).success).toBe(false);
    expect(PLATFORM_SETTING_DEFAULTS.gateway.connectorCoverage).toEqual({});
    // A stored gateway section written before this setting existed still parses.
    expect(platformSettingsSchema.shape.gateway.parse({ recordedFallback: "deny" }).connectorCoverage).toEqual({});
  });

  it("reads the refusal reason back from a gateway error", () => {
    expect(coverageReasonFromError("gateway.skill_coverage_denied:list_stale")).toBe("list_stale");
    expect(coverageReasonFromError("gateway.skill_coverage_denied:made_up")).toBeNull();
    expect(coverageReasonFromError("gateway.capability_denied")).toBeNull();
  });
});
