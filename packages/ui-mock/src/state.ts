import type { Schemas } from "@ehf/ui-contracts";
import { clone, DEFAULT_PERSONA_ID, DEFAULT_SCENARIO, EHF, PLATFORM, persona, SCENARIO, SCENARIOS, type Rec, type ScenarioName } from "./fixtures.js";
import { platformSeeds, replaceFixturePlaceholders } from "./seeds.js";
import { agenticKycDraft } from "./process-scope.js";

export type FailNext = { status: number; error: string };

/** Faults are one-shot unless their name is in `sticky` (BUILD-SPEC v2 §6.6). */
export type Faults = {
  latencyMs: number | null;
  offline: boolean;
  failNext: FailNext | null;
  staleBasisNext: boolean;
  expireSessionNext: boolean;
  csrfRejectNext: boolean;
  revokeRoleNext: string | null;
  upstreamDown: string[];
  sticky: string[];
};

export const NO_FAULTS: Faults = {
  latencyMs: null,
  offline: false,
  failNext: null,
  staleBasisNext: false,
  expireSessionNext: false,
  csrfRejectNext: false,
  revokeRoleNext: null,
  upstreamDown: [],
  sticky: [],
};

export type Violation = { operationId: string; status: number; message: string };

export type MockOptions = {
  /** Base latency per request; 0 in node tests, 120 in the browser. */
  latencyMs?: number;
  /** Relative jitter applied to latency (0.3 = ±30%). */
  jitter?: number;
  personaId?: string;
  scenario?: ScenarioName;
};

/**
 * All mutable mock state. Relay handlers read and mutate `store` (EHF-shaped, seeded from
 * ehf.kyb-1042.json for the current scenario state); FinCrime handlers project `fin`
 * (scenario.kyb-1042.json) with live values from `store`; platform handlers use `platform`.
 */
export type MockState = {
  options: Required<Pick<MockOptions, "latencyMs" | "jitter">>;
  personaId: string;
  scenario: ScenarioName;
  clock: string;
  store: Rec;
  fin: Rec;
  platform: Rec;
  faults: Faults;
  sessionExpired: boolean;
  revokedRoles: Set<string>;
  violations: Violation[];
  /** Decisions recorded in this session by decisionId (replay and idempotency conflicts). */
  decisionLog: Map<string, { body: string; decision: Rec }>;
  /** Business commands by idempotency key. */
  commandLog: Map<string, { body: string; receipt: Rec }>;
  /** Runs by Idempotency-Key. */
  runLog: Map<string, Rec>;
  /** Principals who created, updated or compiled each draft (separation of duties). */
  draftActors: Map<string, Set<string>>;
  policyWorkspaces: Map<string, Rec[]>;
  /** Activation history by policy workspace, oldest first (phase F). */
  policyActivations: Map<string, Rec[]>;
  /** Institution catalog revisions by institution id, oldest first. */
  institutionCatalogs: Map<string, Rec[]>;
  intelligence: Map<string, { candidates: Schemas["IntelligenceRecord"][]; history: Schemas["IntelligenceRecord"][]; reports: Schemas["IntelligenceCheckReport"][]; activity: Schemas["IntelligenceActivity"][] }>;
  /** Document Factory registry by tenant (handlers/document-factory.ts). */
  documentFactory: Map<string, import("./handlers/document-factory.js").FactoryStore>;
  externalBindingRevisions: Map<string, Schemas["ExternalBindingRevision"][]>;
  contextSources: Map<string, {index:Schemas["ContextSourceIndex"];history:Schemas["ContextBindingHead"][]}>;
  externalProviders: Map<string, Schemas["ExternalProviderRecord"][]>;
  runtimeAdmission: { revision:number; state: "running" | "stopped"; activeRunPolicy: "drain" | "cancel" | null; changedAt: string };
  counter: number;
  listeners: Set<(kind: string) => void>;
};

export function createState(options: MockOptions = {}): MockState {
  const state = {
    options: { latencyMs: options.latencyMs ?? 0, jitter: options.jitter ?? 0.3 },
    personaId: options.personaId ?? DEFAULT_PERSONA_ID,
    scenario: options.scenario ?? DEFAULT_SCENARIO,
  } as MockState;
  resetState(state, options.scenario ?? DEFAULT_SCENARIO);
  return state;
}

/** Reset everything except options and persona; violations are cleared too. */
export function resetState(state: MockState, scenario: ScenarioName = DEFAULT_SCENARIO): void {
  state.faults = clone(NO_FAULTS);
  state.sessionExpired = false;
  state.revokedRoles = new Set();
  state.violations = [];
  state.decisionLog = new Map();
  state.commandLog = new Map();
  state.runLog = new Map();
  state.platform = { ...clone(PLATFORM), ...platformSeeds() };
  replaceFixturePlaceholders(state.platform);
  // A composed agentic KYC process whose scope (customer type, jurisdictions, products) can change.
  state.platform.drafts.push(agenticKycDraft((state.platform.drafts as Rec[])[1]!));
  state.draftActors = new Map((state.platform.drafts as Rec[]).map((draft) => [
    draft.draftId as string,
    new Set(((draft.events ?? []) as Rec[]).filter((event) => /created|updated|compiled/.test(event.eventType)).map((event) => event.actor as string)),
  ]));
  state.policyWorkspaces = new Map();
  state.policyActivations = new Map();
  state.institutionCatalogs = new Map();
  state.intelligence = new Map();
  state.documentFactory = new Map();
  state.externalBindingRevisions = new Map();
  state.externalProviders = new Map();
  state.contextSources = new Map();
  state.counter = 0;
  state.listeners ??= new Set();
  loadScenario(state, scenario);
  state.runtimeAdmission = { revision:0, state: "running", activeRunPolicy: null, changedAt: state.clock };
}

/** Jump to a scenario state: reseed the EHF store slice and the FinCrime projections. */
export function loadScenario(state: MockState, scenario: ScenarioName): void {
  if (!SCENARIOS.includes(scenario)) throw new Error(`ui-mock: unknown scenario ${scenario}`);
  state.scenario = scenario;
  state.store = clone(EHF.states[scenario]);
  state.fin = clone(SCENARIO.states[scenario]);
  state.clock = state.store.clock;
}

export function notify(state: MockState, kind: string): void {
  for (const listener of state.listeners) listener(kind);
}

export function nextId(state: MockState, prefix: string): string {
  state.counter += 1;
  return `${prefix}_${String(state.counter).padStart(4, "0")}`;
}

export function now(state: MockState): string {
  return state.clock;
}

/** Advance the mock clock by `seconds`; every mutation stamps the clock, not wall time. */
export function advanceClock(state: MockState, seconds: number): string {
  state.clock = new Date(Date.parse(state.clock) + seconds * 1000).toISOString().replace(/\.000Z$/, "Z");
  return state.clock;
}

export function currentPersona(state: MockState) {
  return persona(state.personaId);
}
