import { isKnownState, stateGlyph, stateTone, type Tone } from "@ehf/ui-tokens";
import type { ReactNode } from "react";
import { Icon, type IconName } from "../icon/Icon";
import styles from "./status.module.css";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/** `NEEDS_REVIEW` → `Needs review`, one-to-one (STYLE-GUIDE §3: business surfaces may humanise). */
export function humanizeEnum(value: string): string {
  if (value.toUpperCase() === "WAITING_HUMAN") return "Awaiting human review";
  const words = value.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Split a dimension key such as `WorkItemStatus` into an engraved label `Work item status`. */
export function dimensionLabel(dimension: string): string {
  return humanizeEnum(dimension.replace(/([a-z])([A-Z])/g, "$1_$2"));
}

export type StatusBadgeProps = {
  /** A stateMap dimension, e.g. `WorkItemStatus`. */
  dimension: string;
  /** The raw enum value from the API. */
  value: string | null | undefined;
  /** Override the text; defaults to the raw value (or its humanised form). */
  label?: ReactNode;
  humanize?: boolean;
  /** Show the engraved dimension name; use it wherever two state chips could be confused. */
  showDimension?: boolean | string;
  size?: "md" | "lg";
};

/**
 * A state as tone + glyph + text, never colour alone (N4, N5). Unknown values render
 * neutral with a help glyph and an explicit "unknown value" marker.
 */
export function StatusBadge({ dimension, value, label, humanize = false, showDimension = false, size = "md" }: StatusBadgeProps) {
  const tone = stateTone(dimension, value);
  const known = isKnownState(dimension, value);
  const text = label ?? (value ? (humanize ? humanizeEnum(value) : value) : "Not reported");
  const glyph = stateGlyph(dimension, value) as IconName;
  const badge = (
    <span className={cx(styles.status, size === "lg" && styles.large)} data-tone={tone} data-known={known}>
      {tone === "running" ? <span className={styles.pulse} aria-hidden="true" /> : <Icon name={glyph} size="sm" />}
      <span>{text}</span>
      {!known && value ? <span className={styles.unknown}>unknown value</span> : null}
    </span>
  );
  if (!showDimension) return badge;
  return (
    <span className={styles.dim}>
      <span className={styles.engraved}>{typeof showDimension === "string" ? showDimension : dimensionLabel(dimension)}</span>
      {badge}
    </span>
  );
}

/** Tone badge for values that are not stateMap enums (readiness, connection). */
export function ToneBadge({ tone, icon, children }: { tone: Tone; icon: IconName; children: ReactNode }) {
  return (
    <span className={styles.status} data-tone={tone}>
      <Icon name={icon} size="sm" />
      <span>{children}</span>
    </span>
  );
}

export type Readiness = "Ready" | "Healthy" | "Degraded" | "Unavailable" | "Unreachable" | "Unknown";

/** Service readiness. Computed upstream; "Unknown" is never shown as ready. */
export function ReadinessBadge({ status }: { status: Readiness }) {
  if (status === "Ready" || status === "Healthy") return <ToneBadge tone="positive" icon="checkcircle">{status}</ToneBadge>;
  if (status === "Degraded") return <ToneBadge tone="attention" icon="alert">Degraded</ToneBadge>;
  if (status === "Unknown") return <ToneBadge tone="neutral" icon="help">Readiness unknown</ToneBadge>;
  return <ToneBadge tone="blocking" icon="xcircle">{status}</ToneBadge>;
}

/** P0 pill shown whenever the session's data is synthetic (N9). */
export function SyntheticPill({ label = "Synthetic", detail }: { label?: string; detail?: string }) {
  return (
    <span className={styles.synthetic} title={detail ?? "All records are synthetic. Nothing here is a real-world verification."}>
      <Icon name="beaker" size="sm" />
      {label}
    </span>
  );
}

export type EpistemicKind = "observation" | "assertion" | "fact" | "hypothesis" | "finding" | "recommendation" | "decision" | "claim" | "assumption";

const EPISTEMIC_LABEL: Record<EpistemicKind, string> = {
  observation: "Observation",
  assertion: "Assertion",
  fact: "Verified fact",
  hypothesis: "Hypothesis",
  finding: "Finding",
  recommendation: "Recommendation",
  decision: "Authorized decision",
  claim: "Claim",
  assumption: "Assumption",
};

/** Shape says what kind of claim something is, independent of its status (STYLE-GUIDE §5.2). */
export function EpistemicMarker({ kind, children }: { kind: EpistemicKind; children?: ReactNode }) {
  return (
    <span className={styles.epi} data-kind={kind}>
      <span className={styles.epiMark} aria-hidden="true" />
      <span>{children ?? EPISTEMIC_LABEL[kind]}</span>
      {children ? <span className="sr-only"> ({EPISTEMIC_LABEL[kind]})</span> : null}
    </span>
  );
}

/** Something missing, sampled, stale, restricted or limited, with its machine code (STYLE-GUIDE §5.7). */
export function Disclosure({ tone = "neutral", title, code, icon, children }: {
  tone?: "neutral" | "attention" | "blocking" | "info";
  title: ReactNode;
  code?: string;
  icon?: IconName;
  children?: ReactNode;
}) {
  const fallback: Record<string, IconName> = { neutral: "info", attention: "alert", blocking: "lock", info: "history" };
  return (
    <div className={styles.disclosure} data-tone={tone}>
      <Icon name={icon ?? fallback[tone]!} />
      <div>
        <strong>{title}</strong>
        {code ? <> <code className={styles.code}>{code}</code></> : null}
        {children ? <div className={styles.disclosureBody}>{children}</div> : null}
      </div>
    </div>
  );
}

/** Result of an action. Announced politely; never steals focus. */
export function InlineMessage({ tone, children }: { tone: "ok" | "warn" | "error"; children: ReactNode }) {
  const icon: Record<string, IconName> = { ok: "checkcircle", warn: "alert", error: "xcircle" };
  return (
    <div className={styles.message} data-tone={tone} role="status" aria-live="polite">
      <Icon name={icon[tone]!} />
      <div>{children}</div>
    </div>
  );
}
