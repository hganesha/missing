import type { Schemas } from "@ehf/ui-contracts";
import type { IconName } from "@ehf/ui-kit";
import type { ComponentType } from "react";

/** Layout templates (UI-ARCHITECTURE §4.2, BUILD-SPEC v2 §8.2). */
export type Template = "Console" | "Queue" | "CaseRoom" | "DecisionDesk" | "Instrument" | "Atlas" | "Preview" | "Recorder" | "Lineage" | "Catalog";

/**
 * One routed surface. `requires` lists platform actions; the surface is reachable when the
 * session holds ANY of them (BUILD-SPEC §8.3). Empty means any signed-in user.
 */
export type SurfaceRoute = {
  /** TanStack path, e.g. `/platform/runs/$runId`. */
  path: string;
  /** Surface id from BUILD-SPEC §10, e.g. `PLT-07`, `BIZ-03`. */
  surfaceId: string;
  title: string;
  template: Template;
  requires: readonly string[];
  /** Hidden when the deployment runs with authoring disabled (ui-specs §1.4). */
  authoring?: boolean;
  component: ComponentType;
};

export type Studio = {
  id: string;
  label: string;
  icon: IconName;
  /** Entry route of the studio. */
  route: string;
  requires: readonly string[];
  navigation?: readonly {label:string;route:string;requires:readonly string[];authoring?:boolean}[];
  catalogLinks?: readonly {label:string;route:string;requires:readonly string[]}[];
};

/** A domain registers through this contract; the shell and platform never import it (N13). */
export interface DomainModule {
  id: string;
  label: string;
  studios: readonly Studio[];
  routes: readonly SurfaceRoute[];
  /** Domain labels for a human-work item; null falls back to Approve · Reject · Return. */
  decisionOptions(item: Schemas["HumanQueueItem"]): Schemas["DecisionOption"][] | null;
  commandLabel(type: string): string;
  reasonLabel(code: string): string | undefined;
}
