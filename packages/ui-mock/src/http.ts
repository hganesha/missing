import type { OperationMeta } from "@ehf/ui-contracts";
import { validateResponse } from "@ehf/ui-contracts/validate";
import { HttpResponse } from "msw";
import { clone, persona, ROLE_ACTIONS, type Rec } from "./fixtures.js";
import type { MockState } from "./state.js";

/** Path parameters across the contract; a parameter absent from a route reads as "". */
export type ParamName =
  | "caseId" | "draftId" | "nodeId" | "agentId" | "workspaceId" | "revision" | "planDigest" | "runId" | "traceId"
  | "digest" | "format" | "evidenceId" | "workItemId" | "releaseId" | "bindingId"
  | "deliveryId" | "actionId" | "providerId" | "profileId" | "section" | "taskId" | "skillId" | "productId" | "institutionId"
  | "userId" | "sourceId" | "evaluationId" | "contradictionId" | "findingId" | "entryRef" | "documentId" | "kind" | "entryId" | "layerId"
  | "documentType" | "jobId" | "environment";

export type Ctx = {
  state: MockState;
  meta: OperationMeta;
  request: Request;
  url: URL;
  params: Record<ParamName, string>;
  /** The caller's session with revoked roles removed and actions recomputed. */
  session: Rec;
  subject: string;
  /** Parsed JSON body (undefined when absent or not JSON). */
  body: Rec | undefined;
  correlationId: string;
};

export type Impl = (ctx: Ctx) => Response | Promise<Response>;

/** Actions granted by a set of roles, from the fixture's roleActions table only (N12). */
export function actionsFor(roles: readonly string[]): string[] {
  return [...new Set(roles.flatMap((role) => ROLE_ACTIONS[role] ?? []))].sort();
}

export function sessionFor(state: MockState): Rec {
  const base = clone(persona(state.personaId).session);
  const managed = (state.platform.users as Rec[] | undefined)?.find(user => user.subjectId === base.subject.subjectId);
  if (managed) {
    base.roles = [...managed.roles];
    base.subject.displayName = managed.displayName;
    base.subject.email = managed.email;
  }
  base.roles = (base.roles as string[]).filter((role) => !state.revokedRoles.has(role));
  base.actions = actionsFor(base.roles);
  const focus=state.personaId==='context_architect'?['context','skills','agents']:state.personaId==='agent_architect'?['agents','skills','context']:state.personaId==='platform_admin'||state.personaId==='ops_manager'?['external-capabilities','policies','agents']:state.personaId==='auditor'||state.personaId==='harness_approver'?['policies','context','skills']:['documents','policies','agents'];
  base.navigation={landingRoute:state.personaId==='agent_architect'?'/catalogs':persona(state.personaId).persona.landingRoute,catalogs:focus};
  return base;
}

export function can(ctx: Pick<Ctx, "session">, action: string): boolean {
  return (ctx.session.actions as string[]).includes(action);
}

/** Platform action tokens in an `x-action` value such as "case.write | case.review (…)". */
export function actionTokens(xAction: string | null): string[] {
  if (!xAction) return [];
  return [...new Set(xAction.match(/\b[a-z_]+\.[a-z_]+(?:\.[a-z_]+)?\b/g) ?? [])];
}

/** Roles that grant an action, for "Requires …" copy in error details. */
export function rolesGranting(action: string): string[] {
  return Object.entries(ROLE_ACTIONS).filter(([, actions]) => actions.includes(action)).map(([role]) => role);
}

function record(ctx: Ctx, status: number, body: unknown): void {
  try {
    const result = validateResponse(ctx.meta.operationId, status, body);
    if (!result.valid) violate(ctx.state, ctx.meta.operationId, status, result.message);
  } catch (error) {
    violate(ctx.state, ctx.meta.operationId, status, (error as Error).message);
  }
}

export function violate(state: MockState, operationId: string, status: number, message: string): void {
  state.violations.push({ operationId, status, message });
  console.error(`[ui-mock] ${operationId} ${status} violates the contract: ${message}`);
}

/** Weak ETag over the JSON body, unless the handler supplies one (e.g. "seq-14"). */
function etagOf(body: unknown): string {
  const text = JSON.stringify(body);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `W/"${(hash >>> 0).toString(16)}"`;
}

export function ok(ctx: Ctx, body: unknown, status = 200, options: { etag?: string } = {}): Response {
  const headers: Record<string, string> = { "x-correlation-id": ctx.correlationId, "cache-control": "no-store" };
  if (ctx.meta.method === "GET") {
    const etag = options.etag ?? etagOf(body);
    headers.etag = etag;
    if (ctx.request.headers.get("if-none-match") === etag) return new HttpResponse(null, { status: 304, headers });
  }
  record(ctx, status, body);
  return HttpResponse.json(body as never, { status, headers });
}

/** A non-JSON success (auth redirects, export downloads). */
export function raw(ctx: Ctx, body: string, contentType: string, status = 200, extra: Record<string, string> = {}): Response {
  return new HttpResponse(body, { status, headers: { "content-type": contentType, "x-correlation-id": ctx.correlationId, ...extra } });
}

export function errorBody(ctx: Pick<Ctx, "correlationId">, status: number, error: string, message: string, details?: Rec): Rec {
  return {
    error,
    message,
    status,
    correlationId: ctx.correlationId,
    retryable: status >= 500 || status === 429,
    ...(details ? { details } : {}),
  };
}

/** Respond with the ApiError contract; the body is validated against the op's declared status. */
export function fail(ctx: Ctx, status: number, error: string, message: string, details?: Rec): Response {
  const body = errorBody(ctx, status, error, message, details);
  record(ctx, status, body);
  return HttpResponse.json(body, { status, headers: { "x-correlation-id": ctx.correlationId, "cache-control": "no-store" } });
}

/** An ApiError that names what the caller can do about it (e.g. scope.pack_layer_missing). */
export function refusal(ctx: Ctx, status: number, error: string, message: string, remedy?: string): Response {
  const body = { ...errorBody(ctx, status, error, message), ...(remedy ? { remedy } : {}) };
  record(ctx, status, body);
  return HttpResponse.json(body, { status, headers: { "x-correlation-id": ctx.correlationId, "cache-control": "no-store" } });
}

/** `{items, nextCursor, generatedAt}` honouring `limit` and an offset `cursor`. */
export function page<T>(ctx: Ctx, items: T[], extra: Rec = {}): Rec {
  const limit = Math.min(Math.max(Number(ctx.url.searchParams.get("limit") ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(ctx.url.searchParams.get("cursor") ?? 0) || 0, 0);
  const slice = items.slice(offset, offset + limit);
  return { items: slice, nextCursor: offset + limit < items.length ? String(offset + limit) : null, generatedAt: ctx.state.clock, ...extra };
}

export function notFound(ctx: Ctx, what: string): Response {
  return fail(ctx, 404, "resource.not_found", `${what} was not found.`);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Rec).sort(([a], [b]) => a.localeCompare(b)))
    : item));
}
