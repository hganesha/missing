import { resolveCasePolicyContract } from "./business-decisions.js";
import { documentRunScope, assertDocumentCommands, assertDocumentRecordIdentities } from "./document-extraction.js";
import type { PoolClient } from "pg";
import {
  externalActionEventType,
  isSkillForbiddenCommand,
  SKILL_PROPOSAL_COMMANDS,
  skillExecutionBindingDigest,
  stableDigest,
  type BusinessCommand,
  type CaseActor,
  type ExecutionEnvelopeClaims,
  type SkillCommitRequest,
  type SkillEffectReleaseRequest,
} from "@ehf/contracts";
import { bindRecordTenant } from "./canonical-records.js";
import { qualify } from "./config.js";
import {
  CaseStoreError,
  appendLockedCaseEvent,
  applyLockedCommand,
  assertActiveCaseExecution,
  normalizeDigest,
  writeReceipt,
  type CaseStore,
  type LockedCase,
} from "./index.js";

/**
 * The commit path for what a hosted skill returns (skill.execution.v1 §6.2–6.3).
 *
 * `commitSkillExecution` applies one node attempt's skill output atomically: the evidence link
 * for the skill computation, the commands its proposed records map to, the effects committed when
 * the skill completes, and the effects held for approval, plus one `skill.execution.committed`
 * event that attributes them to the skill execution. It is idempotent per skill execution: the
 * same request replays the original response; a different one under the same execution is a
 * conflict. `releaseSkillEffects` is the other half for approval-required effects: called by the
 * release node after the durable approval, it re-validates the binding, the case sequence and the
 * expiry, then commits (case commands), queues to the outbox (routed external actions) or keeps as
 * `NO_ROUTE` (unrouted external actions), or discards them on a rejection, each with an audit event.
 *
 * Authority is the node's execution envelope, never the request: command types must be in its
 * `case_writes`, held and released effects in its `case_writes_held`, and decision, disposition,
 * review and approval commands are refused outright. The actor is an AGENT attributed to the skill.
 */

export type SkillCommitAuthority = Pick<ExecutionEnvelopeClaims,
  "tenant_id" | "case_id" | "run_id" | "node_id" | "plan_digest" | "permission_digest" | "attempt" | "fencing_epoch"
  | "work_item_id" | "work_fencing_epoch" | "case_writes" | "case_writes_held">;

const PROPOSAL = new Set<string>(SKILL_PROPOSAL_COMMANDS);

/** Refuse a commit the node's envelope does not authorize. Pure; the case API calls it before the store. */
export function assertSkillCommitWithinEnvelope(request: SkillCommitRequest, claims: SkillCommitAuthority): void {
  if (request.tenantId !== claims.tenant_id || request.caseId !== claims.case_id) throw new CaseStoreError("authorization.execution_scope_mismatch", 403);
  const direct = new Set<string>(claims.case_writes);
  const held = new Set<string>(claims.case_writes_held ?? []);
  for (const command of request.commands) {
    if (isSkillForbiddenCommand(command.commandType)) throw new CaseStoreError("skill_commit.command_forbidden", 403, { commandType: command.commandType });
    // A record maps only to a §6.2 command, and the evidence link is only ever a link.
    if (command.localRef === "evidence" && command.commandType !== "LinkEvidence") throw new CaseStoreError("skill_commit.command_shape_invalid", 400, { localRef: command.localRef });
    if (command.localRef.startsWith("record:") && !PROPOSAL.has(command.commandType)) throw new CaseStoreError("skill_commit.command_shape_invalid", 400, { localRef: command.localRef });
    // A command the node may only hold must be held, whatever the request calls it.
    if (held.has(command.commandType)) throw new CaseStoreError("skill_commit.command_held_only", 403, { commandType: command.commandType });
    if (!direct.has(command.commandType)) throw new CaseStoreError("authorization.command_not_declared", 403, { commandType: command.commandType });
  }
  for (const effect of request.held) {
    if (effect.type !== "case_command") continue;
    if (isSkillForbiddenCommand(effect.commandType!)) throw new CaseStoreError("skill_commit.command_forbidden", 403, { commandType: effect.commandType });
    if (!held.has(effect.commandType!)) throw new CaseStoreError("authorization.command_not_declared", 403, { commandType: effect.commandType });
  }
  if (request.releaseNodeId !== null && request.releaseNodeId === claims.node_id) throw new CaseStoreError("skill_commit.release_node_invalid", 400);
}

function skillActor(skillId: string, skillVersion: string, runId: string): CaseActor {
  return { type: "AGENT", principalId: `skills:${skillId}@${skillVersion}`, executionId: runId, roles: [] };
}

type Transaction = { client: PoolClient; executionReader: PoolClient; finish(ok: boolean): Promise<void> };

async function begin(store: CaseStore, claims: SkillCommitAuthority, tenantId: string, caseId: string): Promise<Transaction> {
  const client = await store.db.connect();
  let executionClient: PoolClient | undefined;
  try {
    if (store.executionDb) {
      executionClient = await store.executionDb.connect();
      await executionClient.query("begin");
    }
    await client.query("begin");
    // Held through commit, like every case effect: a cancelled run or a replaced lease cannot commit.
    await assertActiveCaseExecution(executionClient ?? client, claims, tenantId, caseId);
    await bindRecordTenant(client, tenantId);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    client.release();
    if (executionClient) {
      await executionClient.query("rollback").catch(() => undefined);
      executionClient.release();
    }
    throw error;
  }
  return {
    client,
    executionReader: executionClient ?? client,
    async finish(ok) {
      try {
        await client.query(ok ? "commit" : "rollback");
      } finally {
        client.release();
        if (executionClient) {
          try { await executionClient.query("rollback"); } finally { executionClient.release(); }
        }
      }
    },
  };
}

async function lockCase(client: PoolClient, store: CaseStore, tenantId: string, caseId: string): Promise<LockedCase> {
  const result = await client.query<LockedCase>(`select * from ${qualify(store.schemas.core, "cases")} where tenant_id = $1 and case_id = $2 for update`, [tenantId, caseId]);
  const current = result.rows[0];
  if (!current) throw new CaseStoreError("case.not_found", 404);
  return current;
}

async function priorReceipt(client: PoolClient, store: CaseStore, tenantId: string, caseId: string, key: string) {
  const prior = await client.query<{ request_digest: string; response: Record<string, unknown> }>(`
    select request_digest, response from ${qualify(store.schemas.ledger, "command_receipts")}
    where tenant_id = $1 and case_id = $2 and idempotency_key = $3
  `, [tenantId, caseId, key]);
  return prior.rows[0] ?? null;
}

function translate(error: unknown): unknown {
  if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "23505") {
    return new CaseStoreError("command.conflict", 409, { constraint: String((error as { constraint?: string }).constraint ?? "unique") });
  }
  return error;
}

/** Apply one node attempt's skill output atomically and idempotently (per skill execution). */
export async function commitSkillExecution(
  store: CaseStore,
  request: SkillCommitRequest,
  claims: SkillCommitAuthority,
): Promise<Record<string, unknown>> {
  assertSkillCommitWithinEnvelope(request, claims);
  const binding = request.binding;
  const bindingDigest = skillExecutionBindingDigest(binding);
  const commitKey = `skill-commit:${binding.executionId}`;
  const requestDigest = stableDigest(request);
  const tx = await begin(store, claims, request.tenantId, request.caseId);
  let ok = false;
  try {
    const { client } = tx;
    const current = await lockCase(client, store, request.tenantId, request.caseId);
    const prior = await priorReceipt(client, store, request.tenantId, request.caseId, commitKey);
    if (prior) {
      // A replayed node attempt (worker crash, checkpoint resume): the original outcome, nothing new.
      if (prior.request_digest !== requestDigest) throw new CaseStoreError("skill_commit.idempotency_conflict", 409);
      ok = true;
      return { ...prior.response, replayed: true };
    }
    if (normalizeDigest(claims.plan_digest) !== normalizeDigest(current.harness_plan_digest)) {
      const scope = await documentRunScope(store, claims, client, tx.executionReader);
      if (request.held.length) throw new CaseStoreError("document.command_not_permitted", 403);
      assertDocumentCommands(scope, request.commands);
      await assertDocumentRecordIdentities(client, store, request.tenantId, request.caseId, scope, request.commands);
    }
    if (request.expectedCaseSequence !== undefined && request.expectedCaseSequence !== Number(current.case_sequence)) {
      // Never a silent overwrite: the skill computed its effects against a case that has since changed.
      throw new CaseStoreError("skill_commit.case_sequence_stale", 409, { expected: request.expectedCaseSequence, current: Number(current.case_sequence) });
    }
    const actor = skillActor(binding.skillId, binding.skillVersion, claims.run_id);
    const authority = {
      planDigest: claims.plan_digest,
      permissionEnvelopeDigest: claims.permission_digest,
      policySnapshotDigest: normalizeDigest(current.policy_snapshot_digest),
    };
    const applied: Array<{ localRef: string; commandType: string; caseSequence: number; createdIdentifiers: Record<string, string> }> = [];
    for (const item of request.commands) {
      const command: BusinessCommand = {
        commandId: `cmd_skill_${stableDigest(`${binding.executionId}:${item.localRef}`).slice(0, 24)}`,
        commandType: item.commandType,
        commandVersion: "skill.commit.v1",
        tenantId: request.tenantId,
        caseId: request.caseId,
        actor,
        authority,
        payload: item.payload,
        preconditions: { caseSequence: Number(current.case_sequence) },
        idempotencyKey: `skill:${binding.executionId}:${item.localRef}`,
      };
      const result = await applyLockedCommand(client, store, command, current, stableDigest(command));
      applied.push({ localRef: item.localRef, commandType: item.commandType, caseSequence: Number(result.response.caseSequence), createdIdentifiers: result.identifiers });
    }
    const evidenceRefs = request.commands.filter((item) => item.localRef === "evidence").map((item) => String(item.payload.evidenceId));
    const summary = await appendLockedCaseEvent(client, store, current, {
      eventType: "skill.execution.committed",
      eventSchema: "harness.skill.execution_committed.v1",
      payload: {
        skillId: binding.skillId,
        skillVersion: binding.skillVersion,
        executionId: binding.executionId,
        receiptDigest: binding.receiptDigest,
        manifestDigest: binding.manifestDigest,
        bindingDigest,
        nodeId: claims.node_id,
        effectMode: request.effectMode,
        approval: request.approval,
        commands: applied.map((item) => ({ localRef: item.localRef, commandType: item.commandType, createdIdentifiers: item.createdIdentifiers })),
        held: request.held.map((effect) => ({ effectKey: effect.effectKey, type: effect.type, commandType: effect.commandType ?? null, action: effect.action ?? null, expiresAt: effect.expiresAt })),
        releaseNodeId: request.releaseNodeId,
        uncommitted: request.uncommitted,
      },
      evidenceRefs,
      actor,
      commandId: `skillcommit_${stableDigest(commitKey).slice(0, 24)}`,
      authority,
    });
    const effects = qualify(store.schemas.core, "skill_effects");
    for (const [index, effect] of request.held.entries()) {
      await client.query(`
        insert into ${effects}(
          tenant_id, case_id, execution_id, effect_key, effect_index, run_id, skill_node_id, approval_node_id, release_node_id,
          skill_id, skill_version, effect_type, command_type, action, payload, justification_refs, binding, binding_digest,
          held_at_sequence, expires_at, status, created_at, updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20,'HELD',$21,$21)
      `, [
        request.tenantId, request.caseId, binding.executionId, effect.effectKey, index, claims.run_id, claims.node_id,
        request.approvalNodeId, request.releaseNodeId, binding.skillId, binding.skillVersion, effect.type, effect.commandType ?? null,
        effect.action ?? null, JSON.stringify(effect.payload), JSON.stringify(effect.justificationRefs), JSON.stringify(binding), bindingDigest,
        summary.sequence, effect.expiresAt, summary.recordedAt,
      ]);
    }
    const response = {
      outcome: "ACCEPTED",
      caseId: request.caseId,
      caseSequence: summary.sequence,
      executionId: binding.executionId,
      bindingDigest,
      eventId: summary.eventId,
      commands: applied,
      held: request.held.map((effect) => ({ effectKey: effect.effectKey, type: effect.type, status: "HELD", expiresAt: effect.expiresAt })),
    };
    await writeReceipt(client, store, {
      tenantId: request.tenantId, caseId: request.caseId, commandId: `skillcommit_${stableDigest(commitKey).slice(0, 24)}`,
      commandType: "SkillCommit", idempotencyKey: commitKey, requestDigest, sequence: summary.sequence,
      identifiers: { executionId: binding.executionId }, response, createdAt: summary.recordedAt,
    });
    ok = true;
    return response;
  } catch (error) {
    throw translate(error);
  } finally {
    await tx.finish(ok);
  }
}

type EffectRow = {
  execution_id: string; effect_key: string; effect_index: number; run_id: string; skill_node_id: string; approval_node_id: string;
  release_node_id: string; skill_id: string; skill_version: string; effect_type: "case_command" | "external_action";
  command_type: string | null; action: string | null; payload: Record<string, unknown>; binding_digest: string;
  held_at_sequence: string | number; expires_at: Date | string; status: string;
};

export type SkillReleaseResult = { httpStatus: number; body: Record<string, unknown> };

/**
 * Release (APPROVE) or discard (REJECT) the effects held for one skill execution, from the release
 * node after the durable approval. A refusal that changes state (a passed expiry, a changed case)
 * marks the effects EXPIRED or STALE with an audit event and answers 409; the skill must be re-run.
 */
export async function releaseSkillEffects(
  store: CaseStore,
  request: SkillEffectReleaseRequest,
  claims: SkillCommitAuthority,
  now: () => number = Date.now,
): Promise<SkillReleaseResult> {
  if (request.tenantId !== claims.tenant_id || request.caseId !== claims.case_id) throw new CaseStoreError("authorization.execution_scope_mismatch", 403);
  const releaseKey = `skill-release:${request.executionId}`;
  const requestDigest = stableDigest(request);
  const tx = await begin(store, claims, request.tenantId, request.caseId);
  let ok = false;
  try {
    const { client } = tx;
    const current = await lockCase(client, store, request.tenantId, request.caseId);
    const prior = await priorReceipt(client, store, request.tenantId, request.caseId, releaseKey);
    if (prior) {
      if (prior.request_digest !== requestDigest) throw new CaseStoreError("skill_release.idempotency_conflict", 409);
      ok = true;
      return { httpStatus: 200, body: { ...prior.response, replayed: true } };
    }
    const effectsTable = qualify(store.schemas.core, "skill_effects");
    const rows = (await client.query<EffectRow>(`
      select * from ${effectsTable} where tenant_id = $1 and case_id = $2 and execution_id = $3 order by effect_index for update
    `, [request.tenantId, request.caseId, request.executionId])).rows;
    if (!rows.length) {
      ok = true;
      return { httpStatus: 200, body: { outcome: "NOTHING_HELD", executionId: request.executionId, caseSequence: Number(current.case_sequence) } };
    }
    if (rows.some((row) => row.status !== "HELD")) throw new CaseStoreError("skill_release.effects_not_held", 409, { statuses: [...new Set(rows.map((row) => row.status))] });
    for (const row of rows) {
      // Only the node the plan put after the approval may release, for the run that held them.
      if (row.run_id !== claims.run_id || row.release_node_id !== claims.node_id) throw new CaseStoreError("authorization.skill_release_node_mismatch", 403);
      if (row.skill_node_id !== request.skillNodeId || row.approval_node_id !== request.approvalNodeId) throw new CaseStoreError("skill_release.node_mismatch", 409);
      if (row.binding_digest !== request.bindingDigest) throw new CaseStoreError("skill_release.binding_mismatch", 409);
    }
    const first = rows[0]!;
    const actor = skillActor(first.skill_id, first.skill_version, claims.run_id);
    const authority = {
      planDigest: claims.plan_digest,
      permissionEnvelopeDigest: claims.permission_digest,
      policySnapshotDigest: normalizeDigest(current.policy_snapshot_digest),
    };
    const decision = request.decision;
    const approval = {
      approvalNodeId: request.approvalNodeId, decision: decision.decision, authority: decision.authority,
      decisionIds: decision.decisionIds, reviewerPrincipalIds: decision.reviewerPrincipalIds, reasonCode: decision.reasonCode ?? null,
    };
    const commandId = (suffix: string) => `skillrelease_${stableDigest(`${releaseKey}:${suffix}`).slice(0, 24)}`;
    const mark = async (status: string, outcome: (row: EffectRow) => Record<string, unknown> | null) => {
      for (const row of rows) {
        await client.query(`update ${effectsTable} set status = $5, decision = $6::jsonb, outcome = $7::jsonb, updated_at = now()
          where tenant_id = $1 and case_id = $2 and execution_id = $3 and effect_key = $4`,
        [request.tenantId, request.caseId, request.executionId, row.effect_key, status, JSON.stringify(approval), JSON.stringify(outcome(row))]);
      }
    };
    const audit = (eventType: string, payload: Record<string, unknown>) => appendLockedCaseEvent(client, store, current, {
      eventType, eventSchema: `harness.${eventType}.v1`, evidenceRefs: [], actor, authority, commandId: commandId(eventType),
      payload: { executionId: request.executionId, skillId: first.skill_id, skillVersion: first.skill_version, skillNodeId: request.skillNodeId,
        approval, effects: rows.map((row) => ({ effectKey: row.effect_key, type: row.effect_type, commandType: row.command_type, action: row.action })), ...payload },
    });
    const finish = async (httpStatus: number, body: Record<string, unknown>, sequence: number, recordedAt: string) => {
      await writeReceipt(client, store, {
        tenantId: request.tenantId, caseId: request.caseId, commandId: commandId("receipt"), commandType: "SkillRelease",
        idempotencyKey: releaseKey, requestDigest, sequence, identifiers: { executionId: request.executionId }, response: body, createdAt: recordedAt,
      });
      ok = true;
      return { httpStatus, body };
    };

    if (decision.decision === "REJECT") {
      await mark("DISCARDED", () => null);
      const event = await audit("skill.effects.discarded", {});
      return await finish(200, { outcome: "DISCARDED", executionId: request.executionId, caseSequence: event.sequence, discarded: rows.map((row) => row.effect_key) }, event.sequence, event.recordedAt);
    }
    if (current.decision_contract_version === 2 || await resolveCasePolicyContract(store,current.tenant_id,current.harness_plan_digest) === 2) {
      throw new CaseStoreError("policy.skill_effect_gate_required",403);
    }
    // An approval must name its human reviewers; the requester of the case cannot approve its effects.
    if (!decision.reviewerPrincipalIds.length) throw new CaseStoreError("skill_release.approval_unverifiable", 409);
    const requester = current.created_by;
    if (requester?.type === "HUMAN" && decision.reviewerPrincipalIds.includes(requester.principalId)) {
      throw new CaseStoreError("skill_release.approval_not_independent", 403);
    }
    if (rows.some((row) => Date.parse(new Date(row.expires_at).toISOString()) <= now())) {
      await mark("EXPIRED", () => null);
      const event = await audit("skill.effects.expired", {});
      await writeReceipt(client, store, {
        tenantId: request.tenantId, caseId: request.caseId, commandId: commandId("receipt"), commandType: "SkillRelease",
        idempotencyKey: releaseKey, requestDigest, sequence: event.sequence, identifiers: { executionId: request.executionId },
        response: { error: "skill_release.approval_expired" }, createdAt: event.recordedAt,
      });
      ok = true;
      return { httpStatus: 409, body: { error: "skill_release.approval_expired", executionId: request.executionId } };
    }
    const heldAt = Number(first.held_at_sequence);
    if (rows.some((row) => Number(row.held_at_sequence) !== Number(current.case_sequence))) {
      // The reviewers approved effects computed against a case that has since changed.
      const at = Number(current.case_sequence);
      await mark("STALE", () => ({ heldAtSequence: heldAt, currentSequence: at }));
      const event = await audit("skill.effects.stale", { heldAtSequence: heldAt, currentSequence: at });
      await writeReceipt(client, store, {
        tenantId: request.tenantId, caseId: request.caseId, commandId: commandId("receipt"), commandType: "SkillRelease",
        idempotencyKey: releaseKey, requestDigest, sequence: event.sequence, identifiers: { executionId: request.executionId },
        response: { error: "skill_release.case_sequence_stale" }, createdAt: event.recordedAt,
      });
      ok = true;
      return { httpStatus: 409, body: { error: "skill_release.case_sequence_stale", executionId: request.executionId, expected: heldAt, current: at } };
    }
    const held = new Set<string>(claims.case_writes_held ?? []);
    const routed = new Set(request.routedActions);
    const outcomes = new Map<string, Record<string, unknown>>();
    const statuses = new Map<string, string>();
    for (const row of rows) {
      if (row.effect_type === "case_command") {
        const commandType = row.command_type!;
        if (isSkillForbiddenCommand(commandType)) throw new CaseStoreError("skill_commit.command_forbidden", 403, { commandType });
        if (!held.has(commandType)) throw new CaseStoreError("authorization.command_not_declared", 403, { commandType });
        const command = {
          commandId: `cmd_skill_${stableDigest(`${request.executionId}:effect:${row.effect_key}`).slice(0, 24)}`,
          commandType, commandVersion: "skill.commit.v1", tenantId: request.tenantId, caseId: request.caseId, actor, authority,
          payload: row.payload, preconditions: { caseSequence: Number(current.case_sequence) },
          idempotencyKey: `skill:${request.executionId}:effect:${row.effect_key}`,
        } as BusinessCommand;
        const result = await applyLockedCommand(client, store, command, current, stableDigest(command));
        statuses.set(row.effect_key, "COMMITTED");
        outcomes.set(row.effect_key, { caseSequence: Number(result.response.caseSequence), createdIdentifiers: result.identifiers });
      } else if (routed.has(row.action!)) {
        // The outbox row is written with the event, in this transaction; delivery is the relay's.
        const event = await appendLockedCaseEvent(client, store, current, {
          eventType: externalActionEventType(row.action!), eventSchema: "harness.external_action.requested.v1", evidenceRefs: [], actor, authority,
          commandId: commandId(`external:${row.effect_key}`),
          payload: { action: row.action, idempotencyKey: `${request.executionId}:${row.effect_key}`, executionId: request.executionId,
            effectKey: row.effect_key, skillId: row.skill_id, skillVersion: row.skill_version, payloadDigest: stableDigest(row.payload), approval },
        });
        statuses.set(row.effect_key, "QUEUED");
        outcomes.set(row.effect_key, { eventId: event.eventId, caseSequence: event.sequence, delivery: "outbox" });
      } else {
        // No outbound route for this action: an intent that stays pending and visible, never "delivered".
        statuses.set(row.effect_key, "NO_ROUTE");
        outcomes.set(row.effect_key, { reason: "no_outbound_route" });
      }
    }
    for (const row of rows) {
      await client.query(`update ${effectsTable} set status = $5, decision = $6::jsonb, outcome = $7::jsonb, updated_at = now()
        where tenant_id = $1 and case_id = $2 and execution_id = $3 and effect_key = $4`,
      [request.tenantId, request.caseId, request.executionId, row.effect_key, statuses.get(row.effect_key), JSON.stringify(approval), JSON.stringify(outcomes.get(row.effect_key) ?? null)]);
    }
    const results = rows.map((row) => ({ effectKey: row.effect_key, type: row.effect_type, commandType: row.command_type, action: row.action, status: statuses.get(row.effect_key)!, ...outcomes.get(row.effect_key) }));
    const event = await audit("skill.effects.released", { results });
    return await finish(200, { outcome: "RELEASED", executionId: request.executionId, caseSequence: event.sequence, effects: results }, event.sequence, event.recordedAt);
  } catch (error) {
    throw translate(error);
  } finally {
    await tx.finish(ok);
  }
}

/** Held and settled skill effects of a case, newest first (for reviewers: what waits, what had no route). */
export async function listSkillEffects(store: CaseStore, tenantId: string, caseId: string): Promise<Array<Record<string, unknown>>> {
  const client = await store.db.connect();
  try {
    await client.query("begin");
    await bindRecordTenant(client, tenantId);
    const result = await client.query<EffectRow & { decision: unknown; outcome: unknown; created_at: Date; updated_at: Date }>(`
      select * from ${qualify(store.schemas.core, "skill_effects")} where tenant_id = $1 and case_id = $2
      order by created_at desc, execution_id, effect_index
    `, [tenantId, caseId]);
    await client.query("commit");
    return result.rows.map((row) => ({
      executionId: row.execution_id, effectKey: row.effect_key, type: row.effect_type, commandType: row.command_type, action: row.action,
      skillId: row.skill_id, skillVersion: row.skill_version, skillNodeId: row.skill_node_id, releaseNodeId: row.release_node_id,
      status: row.status, heldAtSequence: Number(row.held_at_sequence), expiresAt: new Date(row.expires_at).toISOString(),
      decision: row.decision, outcome: row.outcome,
    }));
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
