import catalogArtifact from "../../ui-contracts/vendor/catalog/ehf-catalog.json" with { type: "json" };
import contextMatrix from "../../ui-contracts/vendor/catalog/context-matrix.json" with { type: "json" };
import ehf from "../../ui-contracts/vendor/docs/ui/contracts/fixtures/ehf.kyb-1042.json" with { type: "json" };
import fincrime from "../../ui-contracts/vendor/docs/ui/contracts/fixtures/fincrime.catalog.json" with { type: "json" };
import personas from "../../ui-contracts/vendor/docs/ui/contracts/fixtures/personas.json" with { type: "json" };
import platform from "../../ui-contracts/vendor/docs/ui/contracts/fixtures/platform.json" with { type: "json" };
import records from "../../ui-contracts/vendor/docs/ui/contracts/fixtures/records.kyb-1042.json" with { type: "json" };
import scenario from "../../ui-contracts/vendor/docs/ui/contracts/fixtures/scenario.kyb-1042.json" with { type: "json" };

/**
 * Fixture access. Only the mock reads fixtures; UI code never does (N1). Fixtures are
 * validated upstream (validate_contracts.py); the mock clones them per scenario state and
 * never mutates these module-level objects.
 */
// Fixture JSON is large and loosely typed; the mock treats it as plain records.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;

export type PersonaFixture = { persona: Rec & { personaId: string; roles: string[] }; session: Rec & { csrfToken: string } };

export const PERSONAS: readonly PersonaFixture[] = (personas as Rec).personas;
export const DEFAULT_PERSONA_ID: string = (personas as Rec).default ?? PERSONAS[0]!.persona.personaId;
export const ROLE_ACTIONS = (personas as Rec).roleActions as Record<string, string[]>;

export function persona(id: string): PersonaFixture {
  const found = PERSONAS.find((entry) => entry.persona.personaId === id);
  if (!found) throw new Error(`ui-mock: unknown persona ${id}`);
  return found;
}

export const SCENARIOS = ["ownership_review", "screening_review", "decision_pending", "second_approval", "decided"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];
export const DEFAULT_SCENARIO: ScenarioName = (scenario as Rec).default;

export const EHF = ehf as Rec;
export const SCENARIO = scenario as Rec;
export const PLATFORM = platform as Rec;
export const FINCRIME = fincrime as Rec;
export const RECORDS: Rec[] = (records as Rec).records;
export const CONTEXT_MATRIX: Rec[] = contextMatrix as Rec[];

/** Catalog artifact content (canonical JSON inside the admitted artifact). */
const content = JSON.parse((catalogArtifact as Rec).content) as Rec;
export const SKILL_MANIFESTS: Map<string, Rec> = new Map((content.skills as Rec[]).map((entry) => [entry.value.id, entry.value]));

export function clone<T>(value: T): T {
  return structuredClone(value);
}
