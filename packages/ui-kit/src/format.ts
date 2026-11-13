/** Formatting helpers (BUILD-SPEC v2 §7.3). Pure, so they are easy to test. */

/** Digests longer than 22 characters show as `first15…last6` (ui-specs §2.2). */
export function fmtDigest(value: string, full = false): string {
  return !full && value.length > 22 ? `${value.slice(0, 15)}…${value.slice(-6)}` : value;
}

/** Hashes in technical copy show as `9c41…e07b` (STYLE-GUIDE §3). */
export function fmtHash(value: string): string {
  const bare = value.replace(/^sha256:/, "");
  return bare.length > 12 ? `${bare.slice(0, 4)}…${bare.slice(-4)}` : bare;
}

const two = (value: number) => String(value).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Local-time rendering. Compact is `HH:MM:SS`; the default is `MMM DD, HH:MM:SS` (24-hour).
 * Formatting is explicit rather than locale-driven so it is identical in tests and browsers.
 */
export function fmtLocalTime(iso: string, compact = false): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
  return compact ? time : `${MONTHS[date.getMonth()]} ${two(date.getDate())}, ${time}`;
}

/** Full UTC value for the tooltip, e.g. `2026-11-08 14:05:12 UTC`. */
export function fmtUtc(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

/** Reported cost with 4 decimals, marked partial when the source says it is incomplete. */
export function fmtCost(costUsd: number, complete: boolean): string {
  return `$${costUsd.toFixed(4)}${complete ? "" : " (incomplete)"}`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}
