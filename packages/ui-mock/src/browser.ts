import { setupWorker } from "msw/browser";
import { PERSONAS, SCENARIOS, type ScenarioName } from "./fixtures.js";
import { createHandlers } from "./handlers.js";
import { createState, type MockOptions, type MockState } from "./state.js";
import { mountToolbar } from "./toolbar/toolbar.js";

const STORAGE_KEY = "ehf-mock:v1";

type Persisted = { personaId?: string; scenario?: string; clock?: string };

/**
 * Persona, scenario and clock survive page reloads (sessionStorage, per tab), so a refresh or
 * a deep link keeps you as the same persona. Store mutations (decisions, commands) do not:
 * a reload replays the scenario state from its fixtures.
 */
function readPersisted(): Persisted {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Persisted;
    return {
      ...(PERSONAS.some((entry) => entry.persona.personaId === value.personaId) ? { personaId: value.personaId } : {}),
      ...(SCENARIOS.includes(value.scenario as ScenarioName) ? { scenario: value.scenario } : {}),
      ...(typeof value.clock === "string" && !Number.isNaN(Date.parse(value.clock)) ? { clock: value.clock } : {}),
    };
  } catch {
    return {};
  }
}

function persist(state: MockState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ personaId: state.personaId, scenario: state.scenario, clock: state.clock }));
  } catch {
    // Storage unavailable (private mode): the mock still works, it just forgets on reload.
  }
}

/**
 * Start the browser mock and its toolbar. Called only from apps/web/src/mock-bootstrap.ts,
 * which is loaded with a dynamic import in mock mode, so none of this reaches http builds.
 */
export async function startMockWorker(options: { serviceWorkerUrl?: string; toolbar?: boolean } & MockOptions = {}) {
  const { serviceWorkerUrl, toolbar = true, ...mockOptions } = options;
  const saved = readPersisted();
  const state = createState({
    latencyMs: 120, jitter: 0.3,
    ...(saved.personaId ? { personaId: saved.personaId } : {}),
    ...(saved.scenario ? { scenario: saved.scenario as ScenarioName } : {}),
    ...mockOptions,
  });
  if (saved.clock) state.clock = saved.clock;
  state.listeners.add(() => persist(state));
  const worker = setupWorker(...createHandlers(state));
  await worker.start({ onUnhandledRequest: "bypass", quiet: true, serviceWorker: { url: serviceWorkerUrl ?? "/mockServiceWorker.js" } });
  if (toolbar && typeof document !== "undefined") mountToolbar(state);
  return { worker, state };
}
