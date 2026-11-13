import { randomUUID } from "node:crypto";
import { qualify } from "./config.js";
import type { CaseStore } from "./index.js";

/**
 * A case or evidence event, ready to leave the transaction that produced it.
 *
 * Deliberately narrow: identifiers, a type and a classification. The payload stays in
 * the row so a sink that must not see case content never receives it.
 */
export type OutboxRecord = {
  outboxId: string;
  eventId: string;
  source: "case" | "evidence";
  tenantId: string;
  caseId: string;
  caseSequence: number | null;
  planDigest: string;
  eventType: string;
  classification: string;
  createdAt: string;
};

/**
 * Where published events go.
 *
 * The outbox is the hand-off point for a message bus. Until one is configured the events
 * still have to leave the table, or the rows accumulate forever -- which is what they
 * were doing: written inside every case transaction and never read by anything.
 */
export interface OutboxSink {
  readonly name: string;
  publish(records: OutboxRecord[]): Promise<void>;
}

/**
 * Default sink: emit each event to the process log and consider it delivered.
 *
 * Minimal but real -- the container platform collects stdout into its log pipeline,
 * so the audit stream has somewhere to go. It is not a replacement for a bus, and the
 * interface exists so one can be dropped in without touching the case transaction.
 */
export class LoggingOutboxSink implements OutboxSink {
  readonly name = "log";

  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(line)) {}

  async publish(records: OutboxRecord[]): Promise<void> {
    for (const record of records) {
      this.write(`${JSON.stringify({ outbox: record })}\n`);
    }
  }
}

/** Reference-only sink for the governed integration control plane. */
export class IntegrationControlPlaneOutboxSink implements OutboxSink {
  readonly name = "integration-control-plane";

  constructor(private readonly options: { endpoint: string; authorization: () => Promise<string> }) {}

  async publish(records: OutboxRecord[]): Promise<void> {
    const authorization = await this.options.authorization();
    for (const record of records) {
      const cloudEvent = {
        specversion: "1.0",
        id: record.eventId,
        source: `urn:ehf:${record.source}`,
        type: record.eventType,
        subject: `cases/${record.caseId}`,
        time: record.createdAt,
        datacontenttype: "application/json",
        data: {
          tenantId: record.tenantId,
          deploymentId: null,
          planDigest: record.planDigest,
          caseId: record.caseId,
          caseSequence: record.caseSequence,
          eventId: record.eventId,
          classification: record.classification,
          correlationId: record.caseId,
          causationId: null,
          hop: 0,
          traceparent: null,
        },
      };
      const response = await fetch(`${this.options.endpoint.replace(/\/$/, "")}/v1/integrations/internal/events`, {
        method: "POST",
        headers: { authorization, "content-type": "application/cloudevents+json" },
        body: JSON.stringify(cloudEvent),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`integration.outbox_publish_${response.status}`);
    }
  }
}

export type RelayOptions = {
  batchSize?: number;
  /** A crashed relay's claim becomes eligible again after this interval. */
  claimTimeoutMs?: number;
  /** Published rows older than this are removed; 0 keeps them indefinitely. */
  retentionDays?: number;
};

type Drained = { published: number; purged: number };

/**
 * Move one batch of unpublished events to the sink and mark them delivered.
 *
 * Claims rows with `for update skip locked` so several relays can run without
 * publishing the same event twice, and marks them only after the sink accepted them --
 * at-least-once, which is what the consumer side is expected to handle.
 */
export async function drainOutbox(
  store: CaseStore,
  sink: OutboxSink,
  options: RelayOptions = {},
): Promise<Drained> {
  const batchSize = Math.max(1, Math.min(500, options.batchSize ?? 100));
  const claimTimeoutSeconds = Math.max(5, Math.ceil((options.claimTimeoutMs ?? 300_000) / 1000));
  let published = 0;
  // The relay reads every tenant's outbox, which the tenant policies forbid to any service
  // role. It works only through the relay functions (case-store migration 012), which run
  // as ehf_case_relay_controller and return metadata, never payloads.
  for (const [source, schema] of [["case", store.schemas.ledger], ["evidence", store.schemas.evidence]] as const) {
    const claimId = randomUUID();
    const claimed = await store.db.query<{
      outbox_id: string; tenant_id: string; case_id: string; event_id: string | null;
      case_sequence: string | number | null; event_type: string; classification: string;
      created_at: Date; harness_plan_digest: string | null;
    }>(`select * from ${qualify(schema, "relay_claim_outbox")}($1, $2, $3)`, [batchSize, claimId, claimTimeoutSeconds]);
    if (!claimed.rows.length) continue;
    const records: OutboxRecord[] = claimed.rows.map((row) => ({
      outboxId: row.outbox_id,
      eventId: row.event_id ?? row.outbox_id,
      source,
      tenantId: row.tenant_id,
      caseId: row.case_id,
      caseSequence: row.case_sequence === null ? null : Number(row.case_sequence),
      planDigest: row.harness_plan_digest ?? "",
      eventType: row.event_type,
      classification: row.classification,
      createdAt: row.created_at.toISOString(),
    }));
    try {
      // Publishing happens after the claim committed. A slow or unavailable bus therefore
      // cannot hold row locks or an open database transaction.
      await sink.publish(records);
      await store.db.query(`select ${qualify(schema, "relay_mark_published")}($1, $2::text[])`,
        [claimId, records.map((record) => record.outboxId)]);
      published += records.length;
    } catch (error) {
      await store.db.query(`select ${qualify(schema, "relay_release_claim")}($1)`, [claimId])
        .catch(() => { /* the claim timeout recovers if release also fails */ });
      throw error;
    }
  }
  const purged = options.retentionDays && options.retentionDays > 0
    ? await purgePublished(store, options.retentionDays)
    : 0;
  return { published, purged };
}

async function purgePublished(store: CaseStore, retentionDays: number): Promise<number> {
  let purged = 0;
  for (const schema of [store.schemas.ledger, store.schemas.evidence]) {
    const result = await store.db.query<{ purged: number }>(
      `select ${qualify(schema, "relay_purge_published")}($1) as purged`, [retentionDays]);
    purged += Number(result.rows[0]?.purged ?? 0);
  }
  return purged;
}

export type OutboxRelay = { stop: () => void };

/** Run the relay on an interval until stopped. */
export function startOutboxRelay(
  store: CaseStore,
  sink: OutboxSink,
  options: RelayOptions & { intervalMs?: number; onError?: (error: unknown) => void } = {},
): OutboxRelay {
  const intervalMs = Math.max(250, options.intervalMs ?? 5_000);
  let draining = false;
  const timer = setInterval(() => {
    if (draining) return;
    draining = true;
    void drainOutbox(store, sink, options)
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => { draining = false; });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
