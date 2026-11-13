import { setupServer } from "msw/node";
import { createHandlers } from "./handlers.js";
import { createState, type MockOptions } from "./state.js";

/** Node mock server for vitest and contract tests (no latency by default). */
export function createMockServer(options: MockOptions = {}) {
  const state = createState({ latencyMs: 0, ...options });
  return { server: setupServer(...createHandlers(state)), state };
}
