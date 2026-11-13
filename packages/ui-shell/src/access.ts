import type { Schemas } from "@ehf/ui-contracts";

type Session = Pick<Schemas["Session"], "actions" | "authoringEnabled" | 'navigation'>;

/** UI hint only: the server re-checks every call (N11). */
export function canUse(session: Session, requires: readonly string[], authoring = false): boolean {
  if (authoring && !session.authoringEnabled) return false;
  return requires.length === 0 || requires.some((action) => session.actions.includes(action));
}

/**
 * Where "/" lands. Authenticated presentation preferences are honored only when their
 * route is available. Without them, derive a destination from granted actions (GAP-020).
 * This hint never changes authority or bypasses the route guard.
 */
export function landingRoute(session: Session, available: (path: string) => boolean): string {
  const preferred=session.navigation?.landingRoute;
  if(preferred?.startsWith('/')&&!preferred.startsWith('//')&&available(preferred))return preferred;
  const has = (action: string) => session.actions.includes(action);
  const candidates: Array<[boolean, string]> = [
    [has("human_work.decide") || has("case.write"), "/work"],
    [(has("draft.write") || has("draft.approve")) && session.authoringEnabled, "/studio/drafts"],
    [has("admin.write"), "/platform/admin"],
    [has("event.read") && !has("human_work.decide"), "/assurance"],
    [true, "/platform"],
  ];
  return candidates.find(([ok, path]) => ok && available(path))?.[1] ?? "/platform";
}
