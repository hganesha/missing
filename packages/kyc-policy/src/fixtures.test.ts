import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { KYC_POLICY_ROOT, kycPolicyCatalog } from "./catalog.js";
import { loadCorpus } from "./corpus.js";

const catalog = kycPolicyCatalog();

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(KYC_POLICY_ROOT, relativePath), "utf8")) as Record<string, unknown>;
}

interface ScreeningFixtureFile {
  schemaVersion: string;
  capability: string;
  fixtures: {
    id: string;
    summary: string;
    expected: Record<string, unknown>;
  }[];
}

const screeningFiles = [
  "fixtures/providers/sanctions.json",
  "fixtures/providers/pep.json",
  "fixtures/providers/adverse-media.json",
  "fixtures/providers/outages.json",
];

/**
 * Fixtures that nothing checks rot quietly, and a rotten fixture is worse than none: it
 * looks like coverage. These keep the provider fixtures and UAT scenarios honest against
 * the catalog they claim to exercise.
 */
describe("provider fixtures", () => {
  const files = screeningFiles.map((path) => [path, readJson(path) as unknown as ScreeningFixtureFile] as const);

  it("declares the shared fixture schema version", () => {
    for (const [path, file] of files) {
      expect(file.schemaVersion, path).toBe("harness.fixtures.screening.v1");
      expect(file.fixtures.length, path).toBeGreaterThan(0);
    }
  });

  it("gives every fixture a unique id and a summary someone can read", () => {
    const seen = new Set<string>();
    for (const [path, file] of files) {
      for (const fixture of file.fixtures) {
        expect(seen.has(fixture.id), `${path}: duplicate fixture id ${fixture.id}`).toBe(false);
        seen.add(fixture.id);
        expect(fixture.summary.length, `${path} ${fixture.id}`).toBeGreaterThan(20);
      }
    }
  });

  it("only expects reason codes the policy can actually emit", () => {
    for (const [path, file] of files) {
      for (const fixture of file.fixtures) {
        const reasonCode = fixture.expected.gateReasonCode;
        if (reasonCode === undefined || reasonCode === null) continue;
        expect(
          catalog.reasonCodes.has(String(reasonCode)),
          `${path} ${fixture.id} expects unknown reason code ${String(reasonCode)}`,
        ).toBe(true);
      }
    }
  });

  it("only expects finding types the decision tables know how to read", () => {
    const knownFindingTypes = new Set<string>(["NO_MATERIAL_MATCH"]);
    for (const table of catalog.tables.values()) {
      for (const condition of table.spec.conditions) {
        const extractor = condition.extractor;
        if (extractor.kind === "presence" && extractor.collection === "findings") {
          const findingType = extractor.where.findingType;
          if (typeof findingType === "string") knownFindingTypes.add(findingType);
        }
        if (extractor.kind === "strongestFinding") {
          for (const rank of extractor.ranking) knownFindingTypes.add(rank.findingType);
        }
      }
    }
    for (const [path, file] of files) {
      for (const fixture of file.fixtures) {
        const findingType = fixture.expected.findingType;
        if (findingType === undefined) continue;
        expect(
          knownFindingTypes.has(String(findingType)),
          `${path} ${fixture.id} expects finding type ${String(findingType)}, which no table reads`,
        ).toBe(true);
      }
    }
  });

  it("names a real owner input wherever a fixture defers to one", () => {
    for (const [path, file] of files) {
      const thresholds = (file as unknown as { thresholdsOwnerInput?: string }).thresholdsOwnerInput;
      if (thresholds) expect(catalog.ownerInputs.has(thresholds), path).toBe(true);
      for (const fixture of file.fixtures) {
        for (const ref of (fixture.expected.ownerInputRefs as string[] | undefined) ?? []) {
          expect(catalog.ownerInputs.has(ref), `${path} ${fixture.id} names unknown owner input ${ref}`).toBe(true);
        }
      }
    }
  });

  it("never lets a provider failure read as a clean screen", () => {
    const outages = readJson("fixtures/providers/outages.json") as unknown as ScreeningFixtureFile;
    for (const fixture of outages.fixtures) {
      const status = fixture.expected.screeningStatus;
      if (status === "OK") {
        // The one OK case is hostile content, which is a data-trust problem rather than an
        // availability one; it must still be marked untrusted.
        expect(fixture.expected.instructionTrust, fixture.id).toBe("UNTRUSTED_EXTERNAL");
        continue;
      }
      expect(["DEGRADED", "UNAVAILABLE"], fixture.id).toContain(status);
      expect(fixture.expected.gateReasonCode, fixture.id).toBe("SCREENING_PROVIDER_OUTAGE");
      expect(fixture.expected.gateOutcome, fixture.id).toBe("REVIEW");
    }
  });
});

interface UatScenarioSet {
  spec: {
    scenarios: {
      id: string;
      title: string;
      cohort: string | null;
      corpusTags: string[];
      steps: string[];
      expected: string[];
      stopIf: string[];
    }[];
  };
}

describe("UAT scenarios", () => {
  const set = parseYaml(
    readFileSync(resolve(KYC_POLICY_ROOT, "fixtures/uat/scenarios.yaml"), "utf8"),
  ) as UatScenarioSet;
  const corpus = loadCorpus();
  const corpusTags = new Set(corpus.flatMap((corpusCase) => corpusCase.tags));

  it("gives every scenario steps, expectations and a stop condition", () => {
    expect(set.spec.scenarios.length).toBeGreaterThanOrEqual(10);
    for (const scenario of set.spec.scenarios) {
      expect(scenario.steps.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.expected.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.stopIf.length, `${scenario.id} has no condition that would stop sign-off`)
        .toBeGreaterThan(0);
    }
  });

  it("names cohorts and corpus tags that exist", () => {
    for (const scenario of set.spec.scenarios) {
      if (scenario.cohort !== null) {
        expect(catalog.riskCohorts.has(scenario.cohort), `${scenario.id} names unknown cohort`).toBe(true);
      }
      for (const tag of scenario.corpusTags) {
        expect(corpusTags.has(tag), `${scenario.id} references corpus tag ${tag}, which no case carries`).toBe(true);
      }
    }
  });

  it("covers the behaviours the policy's authority limits depend on", () => {
    const text = JSON.stringify(set.spec.scenarios).toLowerCase();
    for (const behaviour of ["attestation", "decline", "sanctions", "outage", "stale", "replay"]) {
      expect(text.includes(behaviour), `no UAT scenario covers ${behaviour}`).toBe(true);
    }
  });
});
