import { Validator } from "@cfworker/json-schema";
import { librarySkillEffectMode, skillRequestedEffectSchema, stableDigest, type SkillEffectMode, type SkillRequestedEffect } from "@ehf/contracts";
import effectCommandSchema from "./vendor/effect-command.schema.json" with { type: "json" };

/**
 * CR-5, platform side: the library's closed effect commands (`EffectCommand.schema.json`, raw
 * `state` replacements and `outbox` items) mapped to skill.execution.v1 §6.3
 * `requested_effects` — typed case commands with optimistic concurrency and named external
 * actions. The host never commits; the platform validates, routes through approval where the
 * skill is human-gated, and executes.
 *
 * | Library command (skill)                                   | Requested effect |
 * | --------------------------------------------------------- | ---------------- |
 * | state `case` `OPEN` (`case.create`)                       | absorbed: the platform creates the case before the run (case creation is not a business command) |
 * | state `case` `REVIEW` (`case.state.transition`)           | `RequestHumanReview` |
 * | state `case` `CLOSED` (`case.state.transition`, `case.close`) | `TransitionCaseStatus` → `CLOSED` |
 * | state `case` + `disposition` (`decision.disposition.record`) | `RecordReview` (`disposition`) after approval |
 * | state `assignment` (`case.tasks.assign`)                  | `ProposeWorkItem` (`assignment`) |
 * | state `escalation` (`case.escalate`)                      | `RequestHumanReview` (priority HIGH) |
 * | state `feedback` (`alert.feedback.capture`)               | `RecordReview` (`alert_feedback`) |
 * | state `schedule` (`monitor.customer.schedule`, `screening.rescreen.schedule`) | `ProposeWorkItem` with `dueAt` (the platform schedules; the host never queues) |
 * | state `screening_disposition` (`screening.alert.disposition`) | `RecordReview` (`screening_disposition`) after approval |
 * | state `review` (`monitor.review.close`)                   | `RecordReview` (`monitoring_review`) after approval |
 * | outbox `execute_skill` (`monitor.review.execute`)         | `ProposeWorkItem` (`skill_execution`, required capability `skill.<id>`) |
 * | outbox `submit_filing` (`regulatory.filing.submit`)       | external action `regulatory.filing.submit` after approval |
 * | outbox `delete_artifact` (`evidence.retention.enforce`)   | external action `evidence.retention.delete` after approval |
 */

type Json = Record<string, unknown>;
type CaseCommand = "ProposeWorkItem" | "RecordReview" | "RequestHumanReview" | "TransitionCaseStatus";

/** The library's three effect values (`skill.yaml` `effects`). */
export type LibraryEffects = "read_only" | "internal_write" | "human_gated";

export type LibrarySkillEffects = {
  libraryEffects: Exclude<LibraryEffects, "read_only">;
  /** skill.execution.v1 effect mode (§6.3) the platform registers for the skill. */
  mode: Extract<SkillEffectMode, "internal_write" | "external_write">;
  /** Case commands the skill may request; its manifest `authorization` carries `case_command:<Type>`. */
  caseCommands: CaseCommand[];
  externalActions: string[];
  /** The platform must hold an independent approval before executing the effects. */
  approval: "required" | "none";
};

/**
 * The library commands of each of the library's 15 write or gated skills (all others are
 * read_only) map to these case commands and external actions. Mode and approval are not
 * declared here: they come from the one CR-5 rule the business-skill registry uses
 * (`librarySkillEffectMode` in @ehf/contracts), so the mapping and the registry cannot disagree.
 * What the platform then lets a skill commit is the binding's pinned effects (the manifest's
 * `case_command:<Type>` authorizations); a mapped command beyond them is refused at commit.
 */
const LIBRARY_EFFECT_COMMANDS: ReadonlyArray<[string, Exclude<LibraryEffects, "read_only">, CaseCommand[], string[]]> = [
  ["case.create", "internal_write", [], []],
  ["case.state.transition", "internal_write", ["RequestHumanReview", "TransitionCaseStatus"], []],
  ["case.tasks.assign", "internal_write", ["ProposeWorkItem"], []],
  ["case.escalate", "internal_write", ["RequestHumanReview"], []],
  ["alert.feedback.capture", "internal_write", ["RecordReview"], []],
  ["monitor.customer.schedule", "internal_write", ["ProposeWorkItem"], []],
  ["screening.rescreen.schedule", "internal_write", ["ProposeWorkItem"], []],
  ["monitor.review.execute", "internal_write", ["ProposeWorkItem"], []],
  ["case.close", "human_gated", ["TransitionCaseStatus"], []],
  ["decision.human.review", "human_gated", [], []],
  ["decision.disposition.record", "human_gated", ["RecordReview"], []],
  ["screening.alert.disposition", "human_gated", ["RecordReview"], []],
  ["monitor.review.close", "human_gated", ["RecordReview"], []],
  ["regulatory.filing.submit", "human_gated", [], ["regulatory.filing.submit"]],
  ["evidence.retention.enforce", "human_gated", [], ["evidence.retention.delete"]],
];

/** Effect declaration of each of the library's 15 write or gated skills (all others are read_only). */
export const LIBRARY_SKILL_EFFECTS: Readonly<Record<string, LibrarySkillEffects>> = Object.freeze(Object.fromEntries(
  LIBRARY_EFFECT_COMMANDS.map(([skillId, libraryEffects, caseCommands, externalActions]) => {
    const { mode, approval } = librarySkillEffectMode(skillId, libraryEffects);
    if (mode !== "internal_write" && mode !== "external_write") throw new Error(`library.effect_mode_unexpected:${skillId}:${mode}`);
    return [skillId, { libraryEffects, mode, caseCommands, externalActions, approval }];
  }),
));

/** `case_command:<Type>` authorization entries for a skill's platform manifest. */
export function caseCommandAuthorizations(skillId: string): string[] {
  return (LIBRARY_SKILL_EFFECTS[skillId]?.caseCommands ?? []).map((command) => `case_command:${command}`);
}

export type EffectMapping = {
  effects: SkillRequestedEffect[];
  /** Library commands the platform already satisfies (with why); nothing to execute. */
  absorbed: Array<{ id: string; reason: string }>;
  approval: "required" | "none";
};

export type EffectMappingErrorCode = "effect.command_invalid" | "effect.skill_not_permitted" | "effect.command_unmapped";

export class EffectMappingError extends Error {
  readonly code: EffectMappingErrorCode;
  constructor(code: EffectMappingErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

const commandValidator = new Validator(effectCommandSchema as never, "2020-12", false);

function idempotencyKey(skillId: string, command: Json): string {
  return `lib:${skillId}:${stableDigest(command).slice(0, 40)}`;
}

function caseCommand(skillId: string, command: Json, commandType: CaseCommand, payload: Json, justification: string[]): SkillRequestedEffect {
  return skillRequestedEffectSchema.parse({ type: "case_command", command_type: commandType, idempotency_key: idempotencyKey(skillId, command), payload, justification_refs: justification });
}

function externalAction(skillId: string, command: Json, action: string, payload: Json, justification: string[]): SkillRequestedEffect {
  return skillRequestedEffectSchema.parse({ type: "external_action", action, idempotency_key: idempotencyKey(skillId, command), payload, justification_refs: justification });
}

/**
 * Map the effect commands one library execution returned. Every command must validate against
 * the vendored `EffectCommand` schema and be one the skill is declared to emit; anything else
 * refuses the whole execution (`EffectMappingError`) rather than dropping a command.
 *
 * `justificationRefs` (for example the execution id and the context hash) are attached to every
 * effect. A case-level state command carries the library's `expected_revision` as
 * `payload.expected_case_sequence`: the platform rejects a stale sequence and re-runs the skill
 * on fresh context.
 */
export function mapLibraryEffects(input: { skillId: string; commands: unknown[]; justificationRefs?: string[] }): EffectMapping {
  const declared = LIBRARY_SKILL_EFFECTS[input.skillId];
  const justification = input.justificationRefs ?? [];
  if (!declared) {
    if (input.commands.length) throw new EffectMappingError("effect.skill_not_permitted", `${input.skillId} is read_only and returned ${input.commands.length} command(s).`);
    return { effects: [], absorbed: [], approval: "none" };
  }
  const effects: SkillRequestedEffect[] = [];
  const absorbed: EffectMapping["absorbed"] = [];
  for (const raw of input.commands) {
    const check = commandValidator.validate(raw);
    if (!check.valid) throw new EffectMappingError("effect.command_invalid", `${input.skillId}: ${check.errors.map((error) => `${error.instanceLocation} ${error.error}`).slice(-3).join("; ")}`);
    const command = raw as Json;
    const id = String(command.id);
    const data = (command.data ?? {}) as Json;
    const sequence = typeof command.expected_revision === "number" ? { expected_case_sequence: command.expected_revision } : {};
    const kind = command.kind === "state" ? `state:${String(command.type)}` : `outbox:${String(command.action)}`;
    let effect: SkillRequestedEffect | null = null;
    switch (`${input.skillId}|${kind}`) {
      case "case.create|state:case":
        absorbed.push({ id, reason: "The platform creates the case before the run starts; case creation is not a business command." });
        continue;
      case "case.state.transition|state:case":
      case "case.close|state:case":
        effect = data.state === "CLOSED"
          ? caseCommand(input.skillId, command, "TransitionCaseStatus", { toStatus: "CLOSED", reason: `Library ${input.skillId} closed the case.`, ...sequence }, justification)
          : data.state === "REVIEW"
            ? caseCommand(input.skillId, command, "RequestHumanReview", { objectRef: `case:${id}`, reason: `Library ${input.skillId} moved the case to review.`, ...sequence }, justification)
            : null;
        break;
      case "decision.disposition.record|state:case":
        effect = typeof data.disposition === "string"
          ? caseCommand(input.skillId, command, "RecordReview", { reviewType: "disposition", outcome: data.disposition, objectRef: `case:${id}`, rationale: `Library decision.disposition.record: ${data.disposition}.`, ...sequence }, justification)
          : null;
        break;
      case "case.tasks.assign|state:assignment":
        effect = caseCommand(input.skillId, command, "ProposeWorkItem", { workItemId: String(data.task_id), workType: "assignment", assignedTo: { actor: data.actor, role: data.role } }, justification);
        break;
      case "case.escalate|state:escalation":
        effect = caseCommand(input.skillId, command, "RequestHumanReview", { objectRef: `escalation:${id}`, reason: `${String(data.reason)} (escalate to role ${String(data.role)})`, priority: "HIGH" }, justification);
        break;
      case "alert.feedback.capture|state:feedback":
        effect = caseCommand(input.skillId, command, "RecordReview", { reviewId: id, reviewType: "alert_feedback", outcome: String(data.label), objectRef: `alert:${String(data.alert_id)}`, rationale: String(data.reason) }, justification);
        break;
      case "monitor.customer.schedule|state:schedule":
      case "screening.rescreen.schedule|state:schedule":
        effect = caseCommand(input.skillId, command, "ProposeWorkItem", { workItemId: id, workType: `scheduled_${String(data.action)}`, dueAt: String(data.due_at) }, justification);
        break;
      case "screening.alert.disposition|state:screening_disposition": {
        const hits = Array.isArray(data.hit_ids) ? data.hit_ids.map(String) : [];
        effect = caseCommand(input.skillId, command, "RecordReview", {
          reviewType: "screening_disposition", outcome: String(data.disposition), objectRef: `screening-disposition:${id}`,
          rationale: `Library screening.alert.disposition: ${String(data.disposition)} for ${hits.length} hit(s).`, viewedEvidenceRefs: hits.map((hit) => `ScreeningHit:${hit}`),
        }, justification);
        break;
      }
      case "monitor.review.close|state:review":
        effect = caseCommand(input.skillId, command, "RecordReview", { reviewType: "monitoring_review", outcome: String(data.status), objectRef: `review:${id}`, rationale: "Library monitor.review.close closed the periodic review." }, justification);
        break;
      case "monitor.review.execute|outbox:execute_skill":
        effect = caseCommand(input.skillId, command, "ProposeWorkItem", { workItemId: id, workType: "skill_execution", requiredCapability: `skill.${String(command.skill_id)}`, parameters: command.parameters, parentExecutionId: command.parent_execution_id }, justification);
        break;
      case "regulatory.filing.submit|outbox:submit_filing":
        effect = externalAction(input.skillId, command, "regulatory.filing.submit", { submissionId: id, filing: command.filing, synthetic: command.synthetic }, justification);
        break;
      case "evidence.retention.enforce|outbox:delete_artifact":
        effect = externalAction(input.skillId, command, "evidence.retention.delete", { objectId: String(command.object_id) }, justification);
        break;
      default:
        throw new EffectMappingError("effect.skill_not_permitted", `${input.skillId} may not emit ${kind}.`);
    }
    if (!effect) throw new EffectMappingError("effect.command_unmapped", `${input.skillId} ${kind} with data ${JSON.stringify(data)} has no platform effect.`);
    const allowed = effect.type === "case_command" ? declared.caseCommands.includes(effect.command_type as CaseCommand) : declared.externalActions.includes(effect.action!);
    if (!allowed) throw new EffectMappingError("effect.skill_not_permitted", `${input.skillId} is not declared to request ${effect.command_type ?? effect.action}.`);
    effects.push(effect);
  }
  return { effects, absorbed, approval: declared.approval };
}
