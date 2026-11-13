import { OPERATIONS, type OperationMeta } from "@ehf/ui-contracts";
import { http, HttpResponse, type HttpHandler } from "msw";
import { actionTokens, type Ctx, fail, type Impl, rolesGranting, sessionFor } from "./http.js";
import { IMPLEMENTATIONS } from "./handlers/index.js";
import { createState, notify, type MockState } from "./state.js";

export { createState, type MockState } from "./state.js";

/** OpenAPI path template → MSW path pattern under /api. */
function mswPath(meta: OperationMeta): string {
  // MSW treats ":" as a parameter marker; escape literal colons such as `/ledger:verify`.
  const path = meta.path.replace(/:(?!\{)/g, "\\:").replace(/\{([^}]+)\}/g, ":$1");
  return meta.path.startsWith('/auth/') ? `*${path}` : `*/api${path}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One-shot faults clear after use unless sticky. */
function consume(state: MockState, name: string): void {
  if (state.faults.sticky.includes(name)) return;
  const faults = state.faults as unknown as Record<string, unknown>;
  faults[name] = name === "failNext" || name === "revokeRoleNext" ? null : false;
}

/** Operations whose authorization depends on the request body; checked in their handler. */
const BODY_AUTHORIZED = new Set(["postCasesCaseIdCommands", "postReleasesReleaseIdTransition", "postGatewayRegistry"]);

/**
 * Apply faults and the §6.4 checks in order (session, CSRF, role), then run the handler.
 * Upstream workflow rules (SoD, revisions, claims, dual control, basis) live in handlers.
 */
async function run(state: MockState, meta: OperationMeta, request: Request, params: Record<string, string | readonly string[] | undefined>): Promise<Response> {
  const latency = state.faults.latencyMs ?? state.options.latencyMs;
  if (latency > 0) await sleep(Math.max(0, latency * (1 + (Math.random() * 2 - 1) * state.options.jitter)));
  if (state.faults.offline) {
    if (!state.faults.sticky.includes("offline")) state.faults.offline = false;
    return HttpResponse.error();
  }

  const url = new URL(request.url);
  let body: Record<string, unknown> | undefined;
  if (meta.method !== "GET") {
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
  }
  const ctx: Ctx = {
    state,
    meta,
    request,
    url,
    params: new Proxy(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, decodeURIComponent(String(Array.isArray(value) ? value[0] : value ?? ""))])), {
      get: (target, key) => (typeof key === "string" ? target[key] ?? "" : undefined),
    }) as Ctx["params"],
    session: sessionFor(state),
    subject: "",
    body,
    correlationId: `mock-${crypto.randomUUID()}`,
  };
  ctx.subject = ctx.session.subject.subjectId;

  const implementation = IMPLEMENTATIONS[meta.operationId];
  if (!implementation) return fail(ctx, 501, "mock.not_implemented", `${meta.operationId} is not implemented in the mock.`);
  // Public sign-in remains reachable; sign-out follows session and CSRF checks.
  if (meta.mockOnly || meta.public || meta.path.startsWith("/auth/") && meta.method === "GET") return implementation(ctx);

  // Session
  if (state.faults.expireSessionNext) {
    consume(state, "expireSessionNext");
    state.sessionExpired = true;
  }
  if (state.sessionExpired) return fail(ctx, 401, "session.expired", "Your session ended. Sign in again.");

  // Upstream availability and injected failures
  const service = meta.xUpstream?.service;
  if (service && state.faults.upstreamDown.includes(service)) {
    return fail(ctx, 503, "bff.upstream_unavailable", `${service} is unavailable.`, { blockers: [service] });
  }
  if (state.faults.failNext) {
    const { status, error } = state.faults.failNext;
    consume(state, "failNext");
    return fail(ctx, status, error, `Injected failure (${error}).`);
  }

  if (meta.method !== "GET") {
    // A role revoked "after page load" takes effect at the next mutation.
    if (state.faults.revokeRoleNext) {
      state.revokedRoles.add(state.faults.revokeRoleNext);
      consume(state, "revokeRoleNext");
      ctx.session = sessionFor(state);
      notify(state, "session");
    }
    // CSRF
    const token = request.headers.get("x-csrf-token");
    if (state.faults.csrfRejectNext || token !== ctx.session.csrfToken) {
      if (state.faults.csrfRejectNext) consume(state, "csrfRejectNext");
      return fail(ctx, 403, "csrf.invalid", "The request could not be verified. Refresh and try again.");
    }
  }

  // Role → action (roleActions only)
  const tokens = actionTokens(meta.xAction);
  if (tokens.length && !BODY_AUTHORIZED.has(meta.operationId) && !tokens.some((action) => ctx.session.actions.includes(action))) {
    const roles = [...new Set(tokens.flatMap(rolesGranting))];
    return fail(ctx, 403, "authorization.role_missing", `Your role does not permit this. Requires ${roles.join(" or ") || tokens.join(" or ")}.`, { actor: ctx.subject });
  }

  return implementation(ctx);
}

/** One handler per contract operation. */
export function createHandlers(state: MockState = createState()): HttpHandler[] {
  // MSW matches in registration order: register static paths before parameterised ones so
  // a static path is never captured by a `{param}` sibling.
  const params = (meta: OperationMeta) => (meta.path.match(/\{/g) ?? []).length;
  const ordered = [...(OPERATIONS as readonly OperationMeta[])].sort((a, b) => params(a) - params(b));
  return ordered.map((meta) => {
    const method = meta.method.toLowerCase() as "get" | "put" | "post" | "patch" | "delete";
    return http[method](mswPath(meta), ({ request, params }) => run(state, meta, request, params));
  });
}

export const implementedOperations = (): string[] => Object.keys(IMPLEMENTATIONS);
export type { Impl };
