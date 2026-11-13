import externalBindings from "../../../config/external-capability-bindings.json" with { type: "json" };
import { OPERATIONS, type OperationMeta } from "@ehf/ui-contracts";
import { EHF, FINCRIME, PLATFORM, RECORDS, SCENARIO, type Rec, type ScenarioName } from "./fixtures.js";
import { actionTokens, sessionFor } from "./http.js";
import { createMockServer } from "./node.js";
import { loadScenario, resetState } from "./state.js";

/** Test helpers: a node mock server plus a small typed-ish caller. Not exported publicly. */
export const BASE = "http://ui.test/api";
export const META: readonly OperationMeta[] = OPERATIONS as readonly OperationMeta[];
export const meta = (operationId: string) => META.find((op) => op.operationId === operationId)!;

export function setup() {
  const { server, state } = createMockServer();
  return {
    server,
    state,
    as(personaId: string) {
      state.personaId = personaId;
      state.revokedRoles.clear();
      state.sessionExpired = false;
    },
    at(scenario: ScenarioName) {
      resetState(state, scenario);
    },
    jump(scenario: ScenarioName) {
      loadScenario(state, scenario);
    },
    async call(operationId: string, options: { path?: Record<string, string>; query?: Record<string, string>; body?: unknown; headers?: Record<string, string>; csrf?: boolean | string } = {}) {
      const op = meta(operationId);
      if (!op) throw new Error(`unknown op ${operationId}`);
      const params = { ...defaultParams(state, operationId), ...(options.path ?? {}) };
      const path = op.path.replace(/\{([^}]+)\}/g, (_match, name: string) => encodeURIComponent(params[name] ?? `missing-${name}`));
      const url = new URL(`${BASE}${path}`);
      const query = { ...(operationId === "getAdminIdentityProviderUsers" ? { query: "Jamie" } : {}), ...options.query };
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const headers: Record<string, string> = { accept: "application/json", ...(options.headers ?? {}) };
      if (op.method !== "GET" && options.csrf !== false) headers["x-csrf-token"] = typeof options.csrf === "string" ? options.csrf : sessionFor(state).csrfToken;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(url, { method: op.method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
      const text = await response.text();
      let json: Rec | undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: response.status, body: json as Rec, headers: response.headers, text };
    },
  };
}

/** Path parameters that exist in the seeded data, per operation. */
export function defaultParams(state: { store: Rec; fin: Rec; platform: Rec }, operationId: string): Record<string, string> {
  const firstAgent = (FINCRIME.catalog.agents as Rec[])[0]!;
  const humanItem = (state.store.humanQueue as Rec[])[0]?.workItem?.workItemId ?? "wi_decision";
  return {
    caseId: EHF.caseId,
    draftId: (PLATFORM.drafts as Rec[])[0]!.draftId,
    nodeId: "intake",
    agentId: firstAgent.id,
    workspaceId: "kyc",
    revision: "1",
    planDigest: EHF.planDigest,
    runId: EHF.runId,
    traceId: EHF.traceId,
    digest: operationId === "getAuthoringCatalogsFincrimeDigest" ? FINCRIME.catalog.catalogDigest : "e".repeat(64),
    format: "json",
    evidenceId: RECORDS[0]!.id,
    workItemId: humanItem,
    releaseId: (state.store.releases as Rec[])[0]!.releaseId,
    bindingId: operationId.includes("ExternalCapabilityBindings") ? externalBindings.bindings[0]!.bindingId : "crm-intake-kyb",
    deliveryId: "dlv_0001",
    actionId: "request-documents",
    providerId: (PLATFORM.providers as Rec[])[0]!.provider.id,
    profileId: (PLATFORM.modelProfiles as Rec[])[0]!.profile.id,
    section: (PLATFORM.settings as Rec[])[0]!.section,
    taskId: Object.keys(FINCRIME.tasks)[0]!,
    skillId: (FINCRIME.skills as Rec[])[0]!.skill_id,
    productId: Object.keys(FINCRIME.contextProducts)[0]!,
    institutionId: "bank.synthetic",
    kind:'policies',
    entryId:'document-requirements',
    contradictionId: "cf-12",
    findingId: "s-pep",
    documentId: "doc_779093eab5c33653af964d04",
    entryRef: (state.fin.recorder?.entries as Rec[] | undefined)?.[0]?.ref ?? "none",
  };
}

export function permitted(op: OperationMeta, actions: string[]): boolean {
  const tokens = actionTokens(op.xAction);
  return tokens.length === 0 || tokens.some((action) => actions.includes(action));
}

export { SCENARIO };
