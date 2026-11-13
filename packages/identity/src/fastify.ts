import {
  AuthorizationError,
  createAuthorizer,
  type AuthorizationDecision,
  type Authorizer,
  type PlatformAction,
  type Principal,
  type ResourceRef,
} from "./authorization.js";
import type { PrincipalResolver, RequestLike } from "./principal.js";

export type GuardOptions = {
  resolver: PrincipalResolver;
  onDecision?: (decision: AuthorizationDecision) => void;
};

export type Guard = {
  authorizer: Authorizer;
  /**
   * Resolve the caller and authorize an action in one step. Throws AuthorizationError,
   * which carries the HTTP status and a stable reason code and nothing sensitive.
   */
  require(request: RequestLike, action: PlatformAction, resource?: ResourceRef): Promise<Principal>;
};

export function createGuard(options: GuardOptions): Guard {
  const authorizer = createAuthorizer(options.onDecision);
  return {
    authorizer,
    async require(request, action, resource = { kind: action.split(".")[0] ?? "resource" }) {
      let principal: Principal | null = null;
      try {
        principal = await options.resolver.resolve(request);
      } catch (error) {
        if (!(error instanceof AuthorizationError)) throw error;
        // Re-evaluate as an anonymous caller so the denial is recorded through the same
        // path as every other decision, with the resolver's reason preserved.
        options.onDecision?.({ ...error.decision, action, resourceKind: resource.kind, resourceId: resource.id ?? null });
        throw error;
      }
      authorizer.require(principal, action, resource);
      return principal;
    },
  };
}
