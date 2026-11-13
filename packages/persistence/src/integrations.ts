import { randomUUID } from "node:crypto";
import {
  harnessPlanV2Schema,
  parseHarnessPlan,
  type HarnessPlanV2,
  integrationBindingSchema,
  integrationCloudEventSchema,
  integrationConnectorSchema,
  stableDigest,
  type IntegrationBinding,
  type IntegrationBindingStatus,
  type IntegrationCloudEvent,
  type IntegrationConnector,
  type IntegrationIntent,
} from "@ehf/contracts";
import type { Database } from "./index.js";

type QueryClient = Pick<Database, "query">;

async function tenant(client: QueryClient, tenantId: string): Promise<void> {
  await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
}

// Routing an inbound event to its binding, and claiming deliveries across tenants, is
// authorized by the connecting role's membership in ehf_integration_controller
// (migration 035), not by a session setting a client could claim.

function schemaMatches(schema: Record<string, unknown>, value: unknown): boolean {
  const type = schema.type;
  if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) return false;
  if (type === "array" && !Array.isArray(value)) return false;
  if (type === "string" && typeof value !== "string") return false;
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return false;
  if (type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) return false;
  if (type === "boolean" && typeof value !== "boolean") return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => stableDigest(candidate) === stableDigest(value))) return false;
  if (type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some((key) => typeof key === "string" && !(key in record))) return false;
    if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties as Record<string, unknown>)) {
        if (key in record && child && typeof child === "object" && !Array.isArray(child)
          && !schemaMatches(child as Record<string, unknown>, record[key])) return false;
      }
    }
  }
  return true;
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function filtersMatch(filters: Record<string, unknown>, event: IntegrationCloudEvent): boolean {
  return Object.entries(filters).every(([path, expected]) => stableDigest(valueAtPath(event, path)) === stableDigest(expected));
}

function classificationAtOrBelow(actual: string, maximum: string): boolean {
  const order = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"];
  const actualIndex = order.indexOf(actual.toUpperCase());
  const maximumIndex = order.indexOf(maximum.toUpperCase());
  return actualIndex >= 0 && maximumIndex >= 0 ? actualIndex <= maximumIndex : actual === maximum;
}

export type ConnectorRevision = {
  connector: IntegrationConnector;
  revision: number;
  digest: string;
  createdBy: string;
  createdAt: string;
};

export type BindingRevision = {
  binding: IntegrationBinding;
  revision: number;
  connectorRevision: number;
  digest: string;
  verifiedAt: string | null;
  activatedAt: string | null;
  activationWatermark: string | null;
  updatedBy: string;
  updatedAt: string;
};

function connectorRow(row: {
  definition: unknown; revision: number; definition_digest: string; created_by: string; created_at: Date;
}): ConnectorRevision {
  return {
    connector: integrationConnectorSchema.parse(row.definition), revision: Number(row.revision),
    digest: row.definition_digest, createdBy: row.created_by, createdAt: row.created_at.toISOString(),
  };
}

function bindingRow(row: {
  definition: unknown; revision: number; connector_revision: number; definition_digest: string;
  status: IntegrationBindingStatus; verified_at: Date | null; activated_at: Date | null;
  activation_watermark: Date | null; updated_by: string; updated_at: Date;
}): BindingRevision {
  const definition = integrationBindingSchema.parse({ ...(row.definition as Record<string, unknown>), status: row.status });
  return {
    binding: definition, revision: Number(row.revision), connectorRevision: Number(row.connector_revision),
    digest: row.definition_digest, verifiedAt: row.verified_at?.toISOString() ?? null,
    activatedAt: row.activated_at?.toISOString() ?? null,
    activationWatermark: row.activation_watermark?.toISOString() ?? null,
    updatedBy: row.updated_by, updatedAt: row.updated_at.toISOString(),
  };
}

export async function createConnectorRevision(db: Database, input: {
  tenantId: string; actorId: string; connector: unknown;
}): Promise<ConnectorRevision> {
  const connector = integrationConnectorSchema.parse(input.connector);
  const client = await db.connect();
  try {
    await client.query("begin");
    await tenant(client, input.tenantId);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${input.tenantId}:connector:${connector.id}`]);
    const latest = await client.query<{ revision: number }>(`
      select revision from integration.connector_revisions
      where tenant_id=$1 and connector_id=$2 order by revision desc limit 1
    `, [input.tenantId, connector.id]);
    const revision = Number(latest.rows[0]?.revision ?? 0) + 1;
    const digest = stableDigest(connector);
    const inserted = await client.query<{
      definition: unknown; revision: number; definition_digest: string; created_by: string; created_at: Date;
    }>(`
      insert into integration.connector_revisions(
        tenant_id,connector_id,revision,definition,definition_digest,created_by)
      values($1,$2,$3,$4::jsonb,$5,$6) returning definition,revision,definition_digest,created_by,created_at
    `, [input.tenantId, connector.id, revision, JSON.stringify(connector), digest, input.actorId]);
    await client.query("commit");
    return connectorRow(inserted.rows[0]!);
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export async function listConnectors(db: Database, tenantId: string): Promise<ConnectorRevision[]> {
  const client = await db.connect();
  try {
    await client.query("begin"); await tenant(client, tenantId);
    const result = await client.query<{
      definition: unknown; revision: number; definition_digest: string; created_by: string; created_at: Date;
    }>(`
      select distinct on (connector_id) definition,revision,definition_digest,created_by,created_at
      from integration.connector_revisions where tenant_id=$1 order by connector_id,revision desc
    `, [tenantId]);
    await client.query("commit"); return result.rows.map(connectorRow);
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export async function createBindingRevision(db: Database, input: {
  tenantId: string; actorId: string; binding: unknown; connectorRevision?: number;
}): Promise<BindingRevision> {
  const binding = integrationBindingSchema.parse({ ...(input.binding as Record<string, unknown>), status: "DRAFT" });
  const client = await db.connect();
  try {
    await client.query("begin"); await tenant(client, input.tenantId);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${input.tenantId}:binding:${binding.id}`]);
    const connector = await client.query<{ revision: number; definition: unknown }>(`
      select revision,definition from integration.connector_revisions
      where tenant_id=$1 and connector_id=$2 and ($3::integer is null or revision=$3)
      order by revision desc limit 1
    `, [input.tenantId, binding.connectorId, input.connectorRevision ?? null]);
    if (!connector.rows[0]) throw new Error("integration.connector_not_found");
    const plan = await client.query<{ plan: unknown }>(`
      select plan from harness_control.plans where tenant_id=$1 and plan_digest=$2 and archived_at is null
    `, [input.tenantId, binding.planDigest]);
    const parsedPlan = plan.rows[0] ? harnessPlanV2Schema.safeParse(plan.rows[0].plan).data ?? null : null;
    if (!parsedPlan?.integrations) throw new Error("integration.plan_contracts_missing");
    const trigger = parsedPlan.integrations.triggers.find((contract) => contract.id === binding.contractId);
    const publication = parsedPlan.integrations.publications.find((contract) => contract.id === binding.contractId);
    if (!trigger && !publication) throw new Error("integration.contract_not_found");
    const connectorDefinition = integrationConnectorSchema.parse(connector.rows[0].definition);
    if (trigger?.source.kind === "external_http" && connectorDefinition.channel !== "inbound_http") {
      throw new Error("integration.binding_channel_mismatch");
    }
    if (publication && connectorDefinition.channel === "inbound_http") throw new Error("integration.binding_channel_mismatch");
    const latest = await client.query<{ revision: number }>(`
      select revision from integration.binding_revisions where tenant_id=$1 and binding_id=$2 order by revision desc limit 1
    `, [input.tenantId, binding.id]);
    const revision = Number(latest.rows[0]?.revision ?? 0) + 1;
    const definition = { ...binding, status: "DRAFT" as const };
    const digest = stableDigest({ ...definition, connectorRevision: connector.rows[0].revision });
    const inserted = await client.query<any>(`
      insert into integration.binding_revisions(
        tenant_id,binding_id,revision,route_id,connector_id,connector_revision,deployment_id,
        plan_digest,contract_id,definition,definition_digest,status,created_by,updated_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'DRAFT',$12,$12)
      returning definition,revision,connector_revision,definition_digest,status,verified_at,activated_at,
        activation_watermark,updated_by,updated_at
    `, [input.tenantId, binding.id, revision, binding.routeId, binding.connectorId, connector.rows[0].revision,
      binding.deploymentId, binding.planDigest, binding.contractId, JSON.stringify(definition), digest, input.actorId]);
    await client.query(`insert into integration.binding_events(event_id,tenant_id,binding_id,binding_revision,event_type,actor_id)
      values($1,$2,$3,$4,'binding.created',$5)`, [`int_evt_${randomUUID()}`, input.tenantId, binding.id, revision, input.actorId]);
    await client.query("commit"); return bindingRow(inserted.rows[0]!);
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export async function listBindings(db: Database, tenantId: string, deploymentId?: string): Promise<BindingRevision[]> {
  const client = await db.connect();
  try {
    await client.query("begin"); await tenant(client, tenantId);
    const result = await client.query<any>(`
      select distinct on (binding_id) definition,revision,connector_revision,definition_digest,status,
        verified_at,activated_at,activation_watermark,updated_by,updated_at
      from integration.binding_revisions where tenant_id=$1 and ($2::text is null or deployment_id=$2)
      order by binding_id,revision desc
    `, [tenantId, deploymentId ?? null]);
    await client.query("commit"); return result.rows.map(bindingRow);
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export async function transitionBinding(db: Database, input: {
  tenantId: string; bindingId: string; actorId: string; to: "VERIFIED" | "ACTIVE" | "PAUSED";
}): Promise<BindingRevision> {
  const client = await db.connect();
  try {
    await client.query("begin"); await tenant(client, input.tenantId);
    const selected = await client.query<any>(`
      select * from integration.binding_revisions where tenant_id=$1 and binding_id=$2
      order by revision desc limit 1 for update
    `, [input.tenantId, input.bindingId]);
    const row = selected.rows[0];
    if (!row) throw new Error("integration.binding_not_found");
    const allowed: Record<string, string[]> = { DRAFT: ["VERIFIED"], VERIFIED: ["ACTIVE"], ACTIVE: ["PAUSED"], PAUSED: ["ACTIVE"] };
    if (!allowed[row.status]?.includes(input.to)) throw new Error("integration.binding_transition_invalid");
    if (input.to === "ACTIVE") {
      await client.query(`update integration.binding_revisions set status='PAUSED',updated_at=now(),updated_by=$5
        where tenant_id=$1 and deployment_id=$2 and plan_digest=$3 and contract_id=$4 and status='ACTIVE'`,
      [input.tenantId, row.deployment_id, row.plan_digest, row.contract_id, input.actorId]);
    }
    const updated = await client.query<any>(`
      update integration.binding_revisions set status=$4,
        verified_at=case when $4='VERIFIED' then now() else verified_at end,
        activated_at=case when $4='ACTIVE' then now() else activated_at end,
        activation_watermark=case when $4='ACTIVE' then coalesce(activation_watermark,now()) else activation_watermark end,
        updated_at=now(),updated_by=$3
      where tenant_id=$1 and binding_id=$2 and revision=$5
      returning definition,revision,connector_revision,definition_digest,status,verified_at,activated_at,
        activation_watermark,updated_by,updated_at
    `, [input.tenantId, input.bindingId, input.actorId, input.to, row.revision]);
    await client.query(`insert into integration.binding_events(event_id,tenant_id,binding_id,binding_revision,event_type,actor_id)
      values($1,$2,$3,$4,$5,$6)`, [`int_evt_${randomUUID()}`, input.tenantId, input.bindingId, row.revision,
      `binding.${input.to.toLowerCase()}`, input.actorId]);
    await client.query("commit"); return bindingRow(updated.rows[0]!);
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export async function activeBindingByRoute(db: Database, routeId: string): Promise<BindingRevision & { tenantId: string; connector: IntegrationConnector }> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query<any>(`
      select binding.tenant_id,binding.definition,binding.revision,binding.connector_revision,binding.definition_digest,
        binding.status,binding.verified_at,binding.activated_at,binding.activation_watermark,binding.updated_by,binding.updated_at,
        connector.definition connector_definition
      from integration.binding_revisions binding
      join integration.connector_revisions connector on connector.tenant_id=binding.tenant_id
        and connector.connector_id=binding.connector_id and connector.revision=binding.connector_revision
      where binding.route_id=$1 and binding.status='ACTIVE'
    `, [routeId]);
    await client.query("commit");
    const row = result.rows[0];
    if (!row) throw new Error("integration.route_not_found");
    return { ...bindingRow(row), tenantId: row.tenant_id, connector: integrationConnectorSchema.parse(row.connector_definition) };
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export type IngressReceipt = {
  receiptId: string; tenantId: string; bindingId: string; bindingRevision: number; sourceEventId: string;
  intent: IntegrationIntent; payload: unknown; status: string; result: unknown | null; errorCode: string | null;
};

export async function acceptIngress(db: Database, input: {
  tenantId: string; bindingId: string; bindingRevision: number; sourceEventId: string;
  intent: IntegrationIntent; payload: unknown;
}): Promise<{ created: boolean; receipt: IngressReceipt }> {
  const requestDigest = stableDigest(input.payload);
  const receiptId = `ing_${randomUUID()}`;
  const client = await db.connect();
  try {
    await client.query("begin"); await tenant(client, input.tenantId);
    const existing = await client.query<any>(`select * from integration.ingress_receipts
      where tenant_id=$1 and binding_id=$2 and binding_revision=$3 and source_event_id=$4 and intent=$5`,
    [input.tenantId, input.bindingId, input.bindingRevision, input.sourceEventId, input.intent]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_digest !== requestDigest) throw new Error("integration.ingress_idempotency_conflict");
      await client.query("commit");
      return { created: false, receipt: mapIngress(existing.rows[0]) };
    }
    const inserted = await client.query<any>(`insert into integration.ingress_receipts(
      receipt_id,tenant_id,binding_id,binding_revision,source_event_id,intent,request_digest,payload,status)
      values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'ACCEPTED') returning *`,
    [receiptId,input.tenantId,input.bindingId,input.bindingRevision,input.sourceEventId,input.intent,requestDigest,JSON.stringify(input.payload)]);
    await client.query("commit"); return { created: true, receipt: mapIngress(inserted.rows[0]) };
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

function mapIngress(row: any): IngressReceipt {
  return { receiptId: row.receipt_id, tenantId: row.tenant_id, bindingId: row.binding_id,
    bindingRevision: Number(row.binding_revision), sourceEventId: row.source_event_id, intent: row.intent,
    payload: row.payload, status: row.status, result: row.result ?? null, errorCode: row.error_code ?? null };
}

export async function getIngressReceipt(db: Database, tenantId: string, receiptId: string): Promise<IngressReceipt | null> {
  const client = await db.connect();
  try { await client.query("begin"); await tenant(client, tenantId); const result = await client.query<any>(
    "select * from integration.ingress_receipts where tenant_id=$1 and receipt_id=$2", [tenantId, receiptId]);
    await client.query("commit"); return result.rows[0] ? mapIngress(result.rows[0]) : null;
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

export async function ingestCloudEvent(db: Database, event: unknown): Promise<{ created: boolean; deliveries: number; ingresses: number }> {
  const parsed = integrationCloudEventSchema.parse(event);
  const client = await db.connect();
  try {
    await client.query("begin");
    const inserted = await client.query(`insert into integration.event_inbox(tenant_id,event_id,cloud_event)
      values($1,$2,$3::jsonb) on conflict do nothing`, [parsed.data.tenantId, parsed.id, JSON.stringify(parsed)]);
    if (!(inserted.rowCount ?? 0)) { await client.query("commit"); return { created: false, deliveries: 0, ingresses: 0 }; }
    const candidates = await client.query<any>(`
      select binding.binding_id,binding.revision,binding.contract_id,binding.plan_digest,binding.deployment_id,
        binding.definition binding_definition,binding.activation_watermark,
        connector.definition connector
      from integration.binding_revisions binding
      join integration.connector_revisions connector on connector.tenant_id=binding.tenant_id
        and connector.connector_id=binding.connector_id and connector.revision=binding.connector_revision
      where binding.tenant_id=$1 and binding.status='ACTIVE' and binding.activation_watermark <= $2::timestamptz
    `, [parsed.data.tenantId, parsed.time]);
    let deliveries = 0;
    let ingresses = 0;
    for (const row of candidates.rows) {
      const connector = integrationConnectorSchema.parse(row.connector);
      const binding = integrationBindingSchema.parse({ ...(row.binding_definition as Record<string, unknown>), status: "ACTIVE" });
      if (parsed.data.deploymentId !== row.deployment_id || parsed.data.planDigest !== row.plan_digest
        || !filtersMatch(binding.filters, parsed)) continue;
      const planResult = await client.query<{ plan: unknown }>(`select plan from harness_control.plans
        where tenant_id=$1 and plan_digest=$2`, [parsed.data.tenantId, row.plan_digest]);
      // A removed v1 plan carries no integration contracts: it neither ingests nor publishes.
      const plan = planResult.rows[0] ? harnessPlanV2Schema.safeParse(planResult.rows[0].plan).data ?? null : null;
      const trigger = plan?.integrations?.triggers.find((item) => item.id === row.contract_id);
      if (trigger?.source.kind === "internal_event" && trigger.source.eventTypes.includes(parsed.type)
        && parsed.data.hop < trigger.maxHops && schemaMatches(trigger.inputSchema, parsed)) {
        const receipt = await client.query(`insert into integration.ingress_receipts(
          receipt_id,tenant_id,binding_id,binding_revision,source_event_id,intent,request_digest,payload,status)
          values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'ACCEPTED') on conflict do nothing`,
        [`ing_${randomUUID()}`,parsed.data.tenantId,row.binding_id,row.revision,parsed.id,trigger.target.intent,
          stableDigest(parsed),JSON.stringify({ ...parsed, data: { ...parsed.data, hop: parsed.data.hop + 1, causationId: parsed.id } })]);
        ingresses += receipt.rowCount ?? 0;
      }
      if (connector.channel === "inbound_http" || !connector.allowedClassifications.includes(parsed.data.classification)) continue;
      const publication = plan?.integrations?.publications.find((item) => item.id === row.contract_id);
      if (!publication?.eventTypes.includes(parsed.type)
        || !classificationAtOrBelow(parsed.data.classification, publication.maximumClassification)) continue;
      const deliveryId = `delivery_${randomUUID()}`;
      const delivery = await client.query(`insert into integration.deliveries(
        delivery_id,tenant_id,binding_id,binding_revision,event_id,cloud_event,status)
        values($1,$2,$3,$4,$5,$6::jsonb,'PENDING') on conflict do nothing`,
      [deliveryId,parsed.data.tenantId,row.binding_id,row.revision,parsed.id,JSON.stringify(parsed)]);
      deliveries += delivery.rowCount ?? 0;
    }
    await client.query(`update integration.event_inbox set processed_at=now() where tenant_id=$1 and event_id=$2`,
      [parsed.data.tenantId, parsed.id]);
    await client.query("commit"); return { created: true, deliveries, ingresses };
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export async function listDeliveries(db: Database, tenantId: string, limit = 100): Promise<any[]> {
  const client = await db.connect();
  try {
    await client.query("begin"); await tenant(client, tenantId);
    const result = await client.query<any>(`select delivery_id,binding_id,binding_revision,event_id,status,
      attempt_count,next_attempt_at,last_error,replayed_from,created_at,updated_at,delivered_at
      from integration.deliveries where tenant_id=$1 order by created_at desc limit $2`, [tenantId, Math.min(500, Math.max(1, limit))]);
    await client.query("commit"); return result.rows.map((row) => ({ deliveryId: row.delivery_id, bindingId: row.binding_id,
      bindingRevision: Number(row.binding_revision), eventId: row.event_id, status: row.status, attemptCount: Number(row.attempt_count),
      nextAttemptAt: row.next_attempt_at.toISOString(), lastError: row.last_error, replayedFrom: row.replayed_from,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), deliveredAt: row.delivered_at?.toISOString() ?? null }));
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

export async function replayDelivery(db: Database, input: { tenantId: string; deliveryId: string }): Promise<{ deliveryId: string }> {
  const client = await db.connect();
  try {
    await client.query("begin"); await tenant(client, input.tenantId);
    const source = await client.query<any>("select * from integration.deliveries where tenant_id=$1 and delivery_id=$2 for update", [input.tenantId,input.deliveryId]);
    const row = source.rows[0]; if (!row || row.status !== "DEAD_LETTER") throw new Error("integration.delivery_not_replayable");
    const deliveryId = `delivery_${randomUUID()}`;
    await client.query(`insert into integration.deliveries(delivery_id,tenant_id,binding_id,binding_revision,event_id,cloud_event,status,replayed_from)
      values($1,$2,$3,$4,$5,$6::jsonb,'PENDING',$7)`, [deliveryId,input.tenantId,row.binding_id,row.binding_revision,
      `${row.event_id}:replay:${randomUUID()}`,JSON.stringify(row.cloud_event),input.deliveryId]);
    await client.query("commit"); return { deliveryId };
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

export async function getActionReceipt(db: Database, input: {
  tenantId: string; caseId: string; actionId: string; requestId: string;
}): Promise<{ requestDigest: string; response: unknown | null } | null> {
  const client = await db.connect();
  try {
    await client.query("begin"); await tenant(client, input.tenantId);
    const result = await client.query<{ request_digest: string; response: unknown | null }>(`
      select request_digest,response from integration.action_receipts
      where tenant_id=$1 and case_id=$2 and action_id=$3 and request_id=$4
    `, [input.tenantId,input.caseId,input.actionId,input.requestId]);
    await client.query("commit"); const row = result.rows[0];
    return row ? { requestDigest: row.request_digest, response: row.response } : null;
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

export async function saveActionReceipt(db: Database, input: {
  tenantId: string; caseId: string; actionId: string; requestId: string; requestDigest: string; response: unknown;
}): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin"); await tenant(client, input.tenantId);
    await client.query(`insert into integration.action_receipts(
      tenant_id,case_id,action_id,request_id,request_digest,response)
      values($1,$2,$3,$4,$5,$6::jsonb)`, [input.tenantId,input.caseId,input.actionId,input.requestId,input.requestDigest,JSON.stringify(input.response)]);
    await client.query("commit");
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

export type IntegrationBindingContext = {
  tenantId: string;
  binding: BindingRevision;
  connector: IntegrationConnector;
  plan: HarnessPlanV2;
};

export async function getIntegrationBindingContext(db: Database, input: {
  tenantId: string; bindingId: string; revision: number;
}): Promise<IntegrationBindingContext | null> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query<any>(`
      select binding.tenant_id,binding.definition,binding.revision,binding.connector_revision,binding.definition_digest,
        binding.status,binding.verified_at,binding.activated_at,binding.activation_watermark,binding.updated_by,binding.updated_at,
        connector.definition connector_definition,plan.plan
      from integration.binding_revisions binding
      join integration.connector_revisions connector on connector.tenant_id=binding.tenant_id
        and connector.connector_id=binding.connector_id and connector.revision=binding.connector_revision
      join harness_control.plans plan on plan.tenant_id=binding.tenant_id and plan.plan_digest=binding.plan_digest
      where binding.tenant_id=$1 and binding.binding_id=$2 and binding.revision=$3
    `, [input.tenantId, input.bindingId, input.revision]);
    await client.query("commit");
    const row = result.rows[0];
    return row ? { tenantId: row.tenant_id, binding: bindingRow(row),
      connector: integrationConnectorSchema.parse(row.connector_definition), plan: parseHarnessPlan(row.plan) } : null;
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

export async function claimIngressReceipt(db: Database): Promise<(IngressReceipt & { claimId: string; attemptCount: number }) | null> {
  const client = await db.connect();
  const claimId = `claim_${randomUUID()}`;
  try {
    await client.query("begin");
    const result = await client.query<any>(`
      with candidate as (
        select receipt_id from integration.ingress_receipts
        where ((status in ('ACCEPTED','FAILED') and available_at <= now())
          or (status='PROCESSING' and claimed_at < now() - interval '5 minutes'))
        order by created_at for update skip locked limit 1
      )
      update integration.ingress_receipts receipt set status='PROCESSING',claim_id=$1,claimed_at=now(),
        attempt_count=attempt_count+1,updated_at=now()
      from candidate where receipt.receipt_id=candidate.receipt_id returning receipt.*
    `, [claimId]);
    await client.query("commit");
    const row = result.rows[0];
    return row ? { ...mapIngress(row), claimId, attemptCount: Number(row.attempt_count) } : null;
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

export async function finishIngressReceipt(db: Database, input: {
  receiptId: string; claimId: string; result?: unknown; errorCode?: string; retryable?: boolean;
}): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const selected = await client.query<{ attempt_count: number }>(`
      select attempt_count from integration.ingress_receipts where receipt_id=$1 and claim_id=$2 for update
    `, [input.receiptId, input.claimId]);
    const attempt = Number(selected.rows[0]?.attempt_count ?? 0);
    if (!selected.rows[0]) throw new Error("integration.ingress_claim_lost");
    const success = input.errorCode === undefined;
    const retry = !success && input.retryable === true && attempt < 8;
    await client.query(`update integration.ingress_receipts set status=$3,result=$4::jsonb,error_code=$5,
      available_at=case when $3='FAILED' then now() + make_interval(secs => least(300,power(2,$6)::integer)) else available_at end,
      claim_id=null,claimed_at=null,updated_at=now() where receipt_id=$1 and claim_id=$2`,
    [input.receiptId,input.claimId,success ? "COMPLETED" : retry ? "FAILED" : "DEAD_LETTER",
      input.result === undefined ? null : JSON.stringify(input.result),input.errorCode ?? null,attempt]);
    await client.query("commit");
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

export type ClaimedDelivery = {
  deliveryId: string; tenantId: string; bindingId: string; bindingRevision: number;
  cloudEvent: IntegrationCloudEvent; attemptNumber: number; connector: IntegrationConnector;
};

export async function claimDelivery(db: Database): Promise<ClaimedDelivery | null> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query<any>(`
      with candidate as (
        select delivery_id from integration.deliveries
        where ((status in ('PENDING','RETRY') and next_attempt_at <= now())
          or (status='PROCESSING' and updated_at < now() - interval '5 minutes'))
        order by created_at for update skip locked limit 1
      )
      update integration.deliveries delivery set status='PROCESSING',attempt_count=attempt_count+1,updated_at=now()
      from candidate where delivery.delivery_id=candidate.delivery_id
      returning delivery.*
    `);
    const row = result.rows[0];
    if (!row) { await client.query("commit"); return null; }
    const connector = await client.query<{ definition: unknown }>(`
      select connector.definition from integration.binding_revisions binding
      join integration.connector_revisions connector on connector.tenant_id=binding.tenant_id
        and connector.connector_id=binding.connector_id and connector.revision=binding.connector_revision
      where binding.tenant_id=$1 and binding.binding_id=$2 and binding.revision=$3
    `, [row.tenant_id,row.binding_id,row.binding_revision]);
    await client.query("commit");
    if (!connector.rows[0]) throw new Error("integration.delivery_connector_missing");
    return { deliveryId: row.delivery_id,tenantId: row.tenant_id,bindingId: row.binding_id,
      bindingRevision: Number(row.binding_revision),cloudEvent: integrationCloudEventSchema.parse(row.cloud_event),
      attemptNumber: Number(row.attempt_count),connector: integrationConnectorSchema.parse(connector.rows[0].definition) };
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

export async function finishDelivery(db: Database, input: {
  delivery: ClaimedDelivery; outcome: "DELIVERED" | "RETRY" | "DEAD_LETTER";
  httpStatus?: number; errorCode?: string;
}): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const attemptId = `attempt_${randomUUID()}`;
    await client.query(`insert into integration.delivery_attempts(
      attempt_id,tenant_id,delivery_id,attempt_number,outcome,http_status,error_code,started_at,completed_at)
      values($1,$2,$3,$4,$5,$6,$7,now(),now())`, [attemptId,input.delivery.tenantId,input.delivery.deliveryId,
      input.delivery.attemptNumber,input.outcome,input.httpStatus ?? null,input.errorCode ?? null]);
    await client.query(`update integration.deliveries set status=$2,last_error=$3,
      next_attempt_at=case when $2='RETRY' then now()+make_interval(secs => least(900,power(2,$4)::integer)) else next_attempt_at end,
      delivered_at=case when $2='DELIVERED' then now() else delivered_at end,updated_at=now()
      where delivery_id=$1 and status='PROCESSING'`, [input.delivery.deliveryId,input.outcome,input.errorCode ?? null,input.delivery.attemptNumber]);
    await client.query("commit");
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}
