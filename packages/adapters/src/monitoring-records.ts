import type { NormalizedRecords, RecordSourceContext } from "./canonical-records.js";
import { recordWriter } from "./record-writer.js";

/**
 * `transaction.monitor.v1` normalizer: a monitoring system's alerts → `Alert` records.
 *
 * An alert is what the monitor raised, never a finding. A completed run with no alerts yields no
 * record and a `recordGap`: absence of alerts is not a clear result (the monitor's rules and
 * coverage are not ours to certify), exactly as an empty screen is not a clean `WatchlistEntry`.
 */
export const MONITOR_NORMALIZER = "wiring.monitoring";
export const MONITOR_NORMALIZER_VERSION = "1";

export type MonitorAlert = {
  alert_id: string; rule_id: string; severity: string; subject: string; raised_at: string; event_ids: string[];
};
export type MonitorInput = { alerts: MonitorAlert[]; subject?: string; synthetic?: boolean };

const SEVERITIES = new Set(["HIGH", "MEDIUM", "LOW"]);

export function normalizeTransactionMonitoring(input: MonitorInput, context: RecordSourceContext): NormalizedRecords {
  const gap = (reason: string, outcome: string | null = null): NormalizedRecords =>
    ({ records: [], recordGap: { code: "EVIDENCE_GAP", reason, outcome } });
  if (!Array.isArray(input.alerts)) return gap("monitoring result has no alerts list");
  if (input.alerts.length === 0) return gap("monitoring returned no alerts; absence of alerts is not a clear result", "completed");

  const { records, add } = recordWriter(context, MONITOR_NORMALIZER, MONITOR_NORMALIZER_VERSION, input.synthetic === true);
  const seen = new Map<string, string>();
  for (const alert of input.alerts) {
    if (!alert.alert_id || !alert.rule_id || !alert.subject || !Number.isFinite(Date.parse(alert.raised_at)) || !Array.isArray(alert.event_ids) || alert.event_ids.length === 0) {
      return gap(`alert ${alert.alert_id ?? "?"} is missing required fields`);
    }
    const fingerprint = JSON.stringify([alert.rule_id, alert.subject, [...alert.event_ids].sort(), alert.severity]);
    const prior = seen.get(alert.alert_id);
    if (prior !== undefined) {
      if (prior !== fingerprint) return gap(`alert ${alert.alert_id} appears twice with conflicting content`);
      continue; // alert.ingest deduplicates by source id; so does the normalizer
    }
    seen.set(alert.alert_id, fingerprint);
    add("Alert", `alert:${alert.alert_id}`, {
      source_id: alert.alert_id, rule_id: alert.rule_id, subject: alert.subject,
      // Never invent a severity: an unrecognised one is UNKNOWN, which the library accepts.
      severity: SEVERITIES.has(alert.severity) ? alert.severity : "UNKNOWN", event_ids: [...alert.event_ids],
    }, [alert.subject], alert.raised_at);
  }
  return { records, recordGap: null, ...(context.subjectId ? { subjectEntityId: context.subjectId } : {}) };
}
