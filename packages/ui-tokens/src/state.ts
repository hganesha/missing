import { STATE_MAP } from "./generated/tokens.js";

/**
 * Raw enum values → tone and glyph (BUILD-SPEC v2 N4, STYLE-GUIDE §5.1).
 *
 * The API sends raw enum values; components never choose colours. A state is always tone +
 * glyph + text, so this module supplies the first two and the badge supplies the text.
 * Unknown dimensions or values fall back to neutral with a "help" glyph and are reported as
 * unknown, so the UI can mark them instead of guessing a meaning (N8: unknown ≠ pass).
 */
export type Tone = "positive" | "attention" | "blocking" | "info" | "neutral" | "running" | "draft";

export const TONES: readonly Tone[] = ["positive", "attention", "blocking", "info", "neutral", "running", "draft"];

export type StateDimension = keyof typeof STATE_MAP;

export const STATE_DIMENSIONS = Object.keys(STATE_MAP) as StateDimension[];

/** Glyph names the ui-kit icon sprite must provide. */
export type Glyph =
  | "check" | "alert" | "xcircle" | "info" | "minus" | "activity" | "file" | "help"
  | "pause" | "block" | "x" | "clock" | "inbox" | "eye" | "lock" | "flag" | "shield"
  | "hand" | "gavel" | "arrowl" | "refresh" | "split" | "beaker" | "link" | "shieldcheck"
  | "send" | "checkcircle" | "history";

const TONE_GLYPH: Record<Tone, Glyph> = {
  positive: "check",
  attention: "alert",
  blocking: "xcircle",
  info: "info",
  neutral: "minus",
  running: "activity",
  draft: "file",
};

/**
 * `EffectMode` values are autonomy tiers, not tones. Tones follow the style guide's
 * "Effects → tier" row; `effectTier()` returns the tier label itself.
 */
const EFFECT_TONE: Record<string, Tone> = {
  read_only: "positive",
  internal_write: "info",
  proposal: "info",
  human_gated: "blocking",
  external_write: "blocking",
};

/** Per-value glyphs from the style guide's dimension table and BUILD-SPEC §7.1. */
const GLYPH_OVERRIDES: Partial<Record<StateDimension, Record<string, Glyph>>> = {
  SkillStatus: { NEEDS_EVIDENCE: "file", NEEDS_REVIEW: "pause", BLOCKED: "block", FAILED: "xcircle" },
  TaskStatus: { PENDING: "clock", BLOCKED: "block", CANCELLED: "x" },
  CaseState: { OPEN: "inbox", REVIEW: "eye", CLOSED: "lock" },
  Disposition: { ESCALATE: "flag" },
  ApprovalStatus: { PENDING: "clock", CONSUMED: "lock", REVOKED: "block", EXPIRED: "clock" },
  Outcome: { UNKNOWN: "help", NOT_APPLICABLE: "minus" },
  VerificationStatus: { UNVERIFIED: "alert", UNKNOWN: "help" },
  FindingStatus: { INDICATOR: "flag", EXCULPATORY: "shield" },
  MediaStatus: { UNKNOWN: "help", RETRACTED: "history" },
  Severity: { UNKNOWN: "help" },
  EffectMode: { read_only: "eye", internal_write: "refresh", proposal: "file", human_gated: "lock", external_write: "send" },
  Maturity: { implemented_synthetic: "beaker", integration_verified: "link", production_qualified: "shieldcheck" },
  WorkItemStatus: {
    PROPOSED: "file", BLOCKED: "block", READY: "inbox", LEASED: "lock", RETRY_SCHEDULED: "refresh", REWORK_REQUIRED: "refresh",
    HUMAN_REQUIRED: "hand", WAITING_HUMAN: "hand", SUSPENDED: "pause", CANCELLED: "x", EXPIRED: "clock",
  },
  RunStatus: { queued: "clock", manual_review: "hand", denied: "block", cancelled: "x" },
  // DECLINED is a decision, not a failure: neutral tone with its own glyph.
  KycCaseStatus: { INTAKE: "inbox", NEEDS_INFORMATION: "file", SUSPENDED: "pause", DECLINED: "gavel", CLOSED: "lock", HUMAN_REVIEW: "hand" },
  ReleaseStatus: { candidate: "file", approved: "checkcircle", deprecated: "history", revoked: "block" },
  AuthoringStatus: { DRAFT: "file", COMPILED: "checkcircle", EVALUATED: "checkcircle", APPROVED: "checkcircle", PUBLISHED: "check" },
  PolicyDecision: { REVIEW: "eye", UNKNOWN: "help", BLOCK: "block" },
  CommandOutcome: { CONFLICT: "split" },
  // Human decisions are never toned good or bad: neutral, told apart by glyph and text.
  HumanDecision: { APPROVE: "check", REJECT: "x", RETURN: "arrowl" },
  ContextReadiness: { not_subscribed: "minus", unavailable: "block" },
};

function rawValue(dimension: string, value: string): string | undefined {
  const map = (STATE_MAP as Record<string, Record<string, string>>)[dimension];
  return map?.[value];
}

/** True when the dimension and value exist in tokens.json's stateMap. */
export function isKnownState(dimension: string, value: string | null | undefined): boolean {
  return typeof value === "string" && rawValue(dimension, value) !== undefined;
}

/** Tone for a raw enum value. Unknown or missing values are neutral, never positive. */
export function stateTone(dimension: string, value: string | null | undefined): Tone {
  if (typeof value !== "string") return "neutral";
  if (dimension === "EffectMode") return EFFECT_TONE[value] ?? "neutral";
  const raw = rawValue(dimension, value);
  return raw && (TONES as readonly string[]).includes(raw) ? (raw as Tone) : "neutral";
}

/** Glyph for a raw enum value; unknown values get "help" so they never pass as known. */
export function stateGlyph(dimension: string, value: string | null | undefined): Glyph {
  if (!isKnownState(dimension, value)) return "help";
  const override = GLYPH_OVERRIDES[dimension as StateDimension]?.[value as string];
  return override ?? TONE_GLYPH[stateTone(dimension, value)];
}

/** Autonomy tier label for an `EffectMode` value, e.g. `L2|L3 (policy)` for human_gated. */
export function effectTier(value: string): string | undefined {
  return rawValue("EffectMode", value);
}

/** Every (dimension, value) pair in the stateMap; drives stories and tests. */
export function allStates(): Array<{ dimension: StateDimension; value: string }> {
  return STATE_DIMENSIONS.flatMap((dimension) =>
    Object.keys(STATE_MAP[dimension] as Record<string, string>).map((value) => ({ dimension, value })));
}

export const GLYPHS_USED: readonly Glyph[] = [
  ...new Set<Glyph>([...Object.values(TONE_GLYPH), "help", ...Object.values(GLYPH_OVERRIDES).flatMap((map) => Object.values(map ?? {}))]),
];
