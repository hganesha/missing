import type { ReactNode } from "react";
import { Icon, type IconName } from "../icon/Icon";
import { Button } from "./controls";
import { JsonViewer, LocalTimestamp } from "./data";
import styles from "./feedback.module.css";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/** Loading placeholder that reserves the final geometry. */
export function Skeleton({ height = 160, label = "Loading" }: { height?: number | string; label?: string }) {
  return (
    <div className={styles.skeleton} style={{ height }} role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function EmptyState({ icon = "inbox", title, children, action, headingLevel }: { icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode; headingLevel?: 1 | 2 | 3 }) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden="true"><Icon name={icon} size="xl" /></span>
      <Title className={styles.emptyTitle}>{title}</Title>
      {children ? <div className={styles.emptyBody}>{children}</div> : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}

/**
 * Shown when a refresh failed but the last good data is still on screen (ui-specs §2.2,
 * BUILD-SPEC §9.1). Never blank the data; say how old it is and offer a retry.
 */
export function StaleDataBanner({ lastValidAt, reason, onRetry }: { lastValidAt: string | null; reason?: string; onRetry: () => void }) {
  return (
    <div className={styles.stale} role="alert">
      <Icon name="alert" />
      <p className={styles.staleText}>
        Showing the last verified data from <LocalTimestamp iso={lastValidAt} compact />.
        {" "}Refresh failed{reason ? <> (<code>{reason}</code>)</> : null}.
      </p>
      <Button size="sm" icon="refresh" onClick={onRetry}>Retry now</Button>
    </div>
  );
}

/** "live · 5 s", "refreshing…" or "stale · refresh failed", plus a manual refresh. */
export function FreshnessIndicator({ updatedAt, intervalSec, refreshing = false, stale = false, onRefresh }: {
  updatedAt: string | null;
  intervalSec?: number;
  refreshing?: boolean;
  stale?: boolean;
  onRefresh?: () => void;
}) {
  const text = stale ? "stale · refresh failed" : refreshing ? "refreshing…" : intervalSec ? `live · ${intervalSec} s` : "loaded";
  return (
    <span className={styles.freshness}>
      <span className={styles.freshChip} data-stale={stale}>
        <span className={styles.freshDot} aria-hidden="true" />
        {text}
      </span>
      <LocalTimestamp iso={updatedAt} compact />
      {onRefresh ? <Button size="sm" variant="quiet" icon="refresh" aria-label="Refresh now" onClick={onRefresh} disabled={refreshing} busy={refreshing} /> : null}
    </span>
  );
}

export type ErrorDetailValue = {
  error: string;
  message?: string | null;
  status?: number;
  details?: unknown;
  correlationId?: string;
};

/** Reason code + message + details + correlation id (BUILD-SPEC §9.2). Never "HTTP 409" alone. */
export function ErrorDetail({ error, title, action }: { error: ErrorDetailValue; title?: ReactNode; action?: ReactNode }) {
  const hasDetails = error.details !== undefined && error.details !== null;
  return (
    <div className={styles.error} role="alert">
      <p className={styles.errorTitle}><Icon name="xcircle" /> {title ?? error.message ?? "The request failed."}</p>
      <p className={styles.errorCode}>
        <code>{error.error}</code>
        {error.status ? <span> · HTTP {error.status}</span> : null}
      </p>
      {hasDetails || error.correlationId ? (
        <details className={styles.errorMore}>
          <summary>Details</summary>
          {error.correlationId ? <p className={styles.errorCode}>Correlation ID <code>{error.correlationId}</code></p> : null}
          {hasDetails ? <JsonViewer data={error.details} label="Error details" maxHeight={240} /> : null}
        </details>
      ) : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export type Diagnostic = { code: string; severity: "error" | "warning" | "info"; path: string; message: string };

const SEVERITY: Record<Diagnostic["severity"], { icon: IconName; label: string }> = {
  error: { icon: "xcircle", label: "Error" },
  warning: { icon: "alert", label: "Warning" },
  info: { icon: "info", label: "Info" },
};

/** Compiler and validation diagnostics; each path can link into the source editor. */
export function DiagnosticsList({ diagnostics, onSelectPath }: { diagnostics: readonly Diagnostic[]; onSelectPath?: (path: string) => void }) {
  if (diagnostics.length === 0) return <p className={styles.muted}>No diagnostics.</p>;
  return (
    <ul className={styles.diagnostics}>
      {diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code}-${diagnostic.path}-${index}`} data-severity={diagnostic.severity} className={styles.diagnostic}>
          <span className={styles.severity}><Icon name={SEVERITY[diagnostic.severity].icon} size="sm" /> {SEVERITY[diagnostic.severity].label}</span>
          <code className={styles.diagCode}>{diagnostic.code}</code>
          <span className={styles.diagMessage}>{diagnostic.message}</span>
          {onSelectPath
            ? <button type="button" className={styles.pathLink} onClick={() => onSelectPath(diagnostic.path)}>{diagnostic.path}</button>
            : <code className={styles.path}>{diagnostic.path}</code>}
        </li>
      ))}
    </ul>
  );
}

/** Native disclosure: keyboard accessible, and content stays mounted so form state survives. */
export function InspectorSection({ title, description, count, defaultOpen = false, children }: {
  title: ReactNode;
  description?: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className={styles.section} open={defaultOpen}>
      <summary className={styles.sectionSummary}>
        <span className={styles.chevron} aria-hidden="true"><Icon name="chevr" size="sm" /></span>
        <span className={styles.sectionText}>
          <span className={styles.sectionTitle}>{title}</span>
          {description ? <span className={styles.sectionDescription}>{description}</span> : null}
        </span>
        {count !== undefined ? <span className={styles.countBadge}>{count}</span> : null}
      </summary>
      <div className={styles.sectionBody}>{children}</div>
    </details>
  );
}

export const LIFECYCLE_STAGES = ["DRAFT", "COMPILED", "EVALUATED", "APPROVED", "PUBLISHED"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** DRAFT → COMPILED → EVALUATED → APPROVED → PUBLISHED, with who and when for each step reached. */
export function LifecycleRail({ current, events = [] }: {
  current: LifecycleStage;
  events?: ReadonlyArray<{ stage: LifecycleStage; actor?: string | null; at?: string | null }>;
}) {
  const currentIndex = LIFECYCLE_STAGES.indexOf(current);
  return (
    <ol className={styles.rail} aria-label={`Lifecycle: ${current}`}>
      {LIFECYCLE_STAGES.map((stage, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
        const event = events.find((entry) => entry.stage === stage);
        return (
          <li key={stage} className={cx(styles.step)} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className={styles.stepMark} aria-hidden="true">
              {state === "done" ? <Icon name="check" size="sm" /> : state === "current" ? <Icon name="target" size="sm" /> : null}
            </span>
            <span className={styles.stepLabel}>{stage}</span>
            <span className="sr-only">{state === "done" ? "completed" : state === "current" ? "current stage" : "not reached"}</span>
            {event && state !== "upcoming" ? (
              <span className={styles.stepMeta}>
                {event.actor ? <span>{event.actor}</span> : null}
                {event.at ? <LocalTimestamp iso={event.at} /> : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
