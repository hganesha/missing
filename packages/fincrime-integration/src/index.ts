import { createHash } from "node:crypto";
import { z } from "zod";
import { agentRegistrationSchema, skillRegistrationSchema, canonicalJson, stableDigest,
  businessCommandSchema, type BusinessCommand, type AgentRegistration, type SkillRegistration } from "@ehf/contracts";

const object = z.record(z.string(), z.unknown());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(512);
const exactArtifact = z.object({ value: object, canonical: z.string(), sha256: hash });
const sourceSkill = exactArtifact.extend({ instructionContent: z.string().min(1) });
const catalogSchema = z.object({ apiVersion: z.literal("fincrime.ehf/catalog-v1"), sourceRelease: id,
  contextSchemaVersion: id, bundleCodeHash: hash, skills: z.array(sourceSkill).min(1),
  agents: z.array(exactArtifact), tasks: z.array(exactArtifact), contextProducts: z.array(object) }).strict();
const manifestSchema = z.object({ id, semver: id, description: z.string(), entrypoint: id,
  input_schema: object, output_schema: object, instruction_hash: hash, bundle_code_hash: hash,
  required_context: z.array(object), optional_context: z.array(object), policy_context_fields: z.array(id),
  dependencies: z.object({ skills: z.array(id), capabilities: z.array(id), libraries: z.array(id) }),
  permitted_capabilities: z.array(id), effects: z.enum(["read_only", "internal_write", "human_gated"]),
}).passthrough();
export type CanonicalCatalog = z.infer<typeof catalogSchema>;

function verifyArtifact(artifact: z.infer<typeof exactArtifact>): void {
  if (createHash("sha256").update(artifact.canonical).digest("hex") !== artifact.sha256
    || canonicalJson(JSON.parse(artifact.canonical)) !== canonicalJson(artifact.value)) {
    throw new Error("fincrime.artifact_digest_mismatch");
  }
}

/** Verify a catalog for read-only authoring views without registering executable skills. */
export function readCanonicalCatalog(raw: unknown, expectedDigest: string): CanonicalCatalog {
  const envelope = z.object({ apiVersion: z.literal("fincrime.ehf/catalog-artifact-v1"), content: z.string(), sha256: hash }).strict().parse(raw);
  if (envelope.sha256 !== expectedDigest || createHash("sha256").update(envelope.content).digest("hex") !== expectedDigest) throw new Error("fincrime.catalog_digest_mismatch");
  const catalog = catalogSchema.parse(JSON.parse(envelope.content));
  for (const artifact of [...catalog.skills, ...catalog.agents, ...catalog.tasks]) verifyArtifact(artifact);
  return catalog;
}

/** Never runs source code or pip installs from a manifest. The runtime bundle is preinstalled. */
export function importCanonicalCatalog(raw: unknown, expectedDigest: string): {
  catalog: CanonicalCatalog; skills: SkillRegistration[]; agents: AgentRegistration[];
} {
  const envelope = z.object({ apiVersion: z.literal("fincrime.ehf/catalog-artifact-v1"), content: z.string(), sha256: hash }).strict().parse(raw);
  if (envelope.sha256 !== expectedDigest || createHash("sha256").update(envelope.content).digest("hex") !== expectedDigest) {
    throw new Error("fincrime.catalog_digest_mismatch");
  }
  const catalog = catalogSchema.parse(JSON.parse(envelope.content));
  const identities = new Set<string>();
  const skills = catalog.skills.map((artifact) => {
    verifyArtifact(artifact);
    const m = manifestSchema.parse(artifact.value);
    if (identities.has(m.id)) throw new Error("fincrime.duplicate_skill");
    identities.add(m.id);
    if (m.bundle_code_hash !== catalog.bundleCodeHash || stableDigest(artifact.instructionContent) !== m.instruction_hash) {
      throw new Error("fincrime.skill_integrity_mismatch");
    }
    return skillRegistrationSchema.parse({ id: m.id, name: m.id, description: m.description,
      instructions: artifact.instructionContent, allowedCapabilityIds: m.permitted_capabilities,
      version: m.semver, status: "draft", source: { type: "manual", path: m.entrypoint, revision: catalog.bundleCodeHash },
      implementation: { language: "python", entrypoint: m.entrypoint, inputSchema: m.input_schema,
        outputSchema: m.output_schema, dependencies: m.dependencies, requiredContext: m.required_context,
        optionalContext: m.optional_context, policyContextFields: m.policy_context_fields, effects: m.effects,
        bundleCodeHash: m.bundle_code_hash, instructionHash: m.instruction_hash,
        manifestDigest: artifact.sha256, canonicalManifest: artifact.canonical } });
  });
  const agentIds = new Set<string>();
  const agents = catalog.agents.map((artifact) => {
    verifyArtifact(artifact);
    const p = z.object({ id, version: id, mandate: z.string(), task_ids: z.array(id),
      execution: z.object({ allowed_skills: z.record(z.string(), id), instructions: z.string() }).passthrough() }).passthrough().parse(artifact.value);
    if (agentIds.has(p.id)) throw new Error("fincrime.duplicate_agent");
    agentIds.add(p.id);
    for (const [sid, version] of Object.entries(p.execution.allowed_skills)) {
      if (!skills.some(s => s.id === sid && s.version === version)) throw new Error("fincrime.profile_skill_version_missing");
    }
    return agentRegistrationSchema.parse({ id: p.id, name: p.id, description: p.mandate, role: p.mandate,
      prompt: p.execution.instructions, version: p.version, skillIds: Object.keys(p.execution.allowed_skills), status: "draft",
      canonicalProfile: { canonical: artifact.canonical, sha256: artifact.sha256, taskIds: p.task_ids } });
  });
  const taskIds = new Set<string>();
  for (const task of catalog.tasks) {
    verifyArtifact(task);
    const t = z.object({ id, version: id, agent_profile: id, steps: z.array(z.object({ id, skill_id: id, skill_version: id }).passthrough()) }).passthrough().parse(task.value);
    if (taskIds.has(t.id) || !agentIds.has(t.agent_profile)) throw new Error("fincrime.task_assignment_invalid");
    taskIds.add(t.id);
    for (const step of t.steps) if (!skills.some(s => s.id === step.skill_id && s.version === step.skill_version)) {
      throw new Error("fincrime.task_skill_missing");
    }
  }
  for (const agent of agents) for (const tid of agent.canonicalProfile!.taskIds) {
    if (!taskIds.has(tid)) throw new Error("fincrime.profile_task_missing");
  }
  return { catalog, skills, agents };
}

export const assignmentScopeSchema = z.object({
  tenant_id: id, case_id: id, run_id: id, node_id: id, work_item_id: id, execution_id: id,
  work_fencing_epoch: z.number().int().positive(), run_fencing_epoch: z.number().int().positive(), case_sequence: z.number().int().nonnegative(),
  plan_digest: hash, snapshot_digest: hash, task_id: id, task_version: id, profile_id: id, profile_hash: hash,
  skill_id: id, skill_version: id, bundle_code_hash: hash, instruction_hash: hash,
}).strict();
export type AssignmentScope = z.infer<typeof assignmentScopeSchema>;
export const bridgeRequestSchema = z.object({ api_version: z.literal("fincrime.ehf/assignment-v1"),
  scope: assignmentScopeSchema, parameters: object }).strict();
export const bridgeOutcomeSchema = z.object({ api_version: z.literal("fincrime.ehf/outcome-v1"), scope: assignmentScopeSchema,
  status: z.enum(["COMPLETED", "PARTIAL", "NEEDS_EVIDENCE", "NEEDS_REVIEW", "BLOCKED", "FAILED"]),
  payload: object, context_manifest: object.nullable(), context_hash: hash.nullable(), evidence_refs: z.array(object),
  proposed_commands: z.array(object), provider_captures: z.array(object), unresolved_items: z.array(object),
  error_code: z.string().nullable(), effects_committed: z.literal(false), synthetic: z.boolean(),
}).strict();
export type BridgeOutcome = z.infer<typeof bridgeOutcomeSchema>;
export const taskPlanSchema=z.object({task_id:id,task_version:id,profile_id:id,profile_hash:hash,task_hash:hash,input_hash:hash,
  steps:z.array(z.object({id,skill_id:id,skill_version:id,parameters:object,dependencies:z.array(id),requirements_hash:hash}).strict())}).strict();
export type CanonicalTaskPlan=z.infer<typeof taskPlanSchema>;

export function assignmentFor(catalog: CanonicalCatalog, input: {
  taskId: string; skillId: string; scope: Omit<AssignmentScope, "task_id" | "task_version" | "profile_id" | "profile_hash" | "skill_id" | "skill_version" | "bundle_code_hash" | "instruction_hash">;
}): AssignmentScope {
  const task = catalog.tasks.find(t => t.value.id === input.taskId);
  const agent = catalog.agents.find(a => a.value.id === task?.value.agent_profile);
  const skill = catalog.skills.find(s => s.value.id === input.skillId);
  if (!task || !agent || !skill || !(task.value.steps as Array<{ skill_id: string }>).some(s => s.skill_id === input.skillId)) {
    throw new Error("fincrime.assignment_not_declared");
  }
  return assignmentScopeSchema.parse({ ...input.scope, task_id: task.value.id, task_version: task.value.version,
    profile_id: agent.value.id, profile_hash: agent.sha256, skill_id: skill.value.id, skill_version: skill.value.semver,
    bundle_code_hash: catalog.bundleCodeHash, instruction_hash: skill.value.instruction_hash });
}

export class FinancialCrimeClient {
  constructor(private readonly options: { endpoint: string; token: () => Promise<string>; fetch?: typeof globalThis.fetch; allowLoopback?: boolean }) {
    const u = new URL(options.endpoint);
    if (u.username || u.password || u.search || u.hash || !(u.protocol === "https:" || options.allowLoopback
      && u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))) throw new Error("fincrime.endpoint_invalid");
  }
  async plan(catalog:CanonicalCatalog,taskId:string,inputs:Record<string,unknown>):Promise<CanonicalTaskPlan> {
    const task=catalog.tasks.find(t=>t.value.id===taskId),agent=catalog.agents.find(a=>a.value.id===task?.value.agent_profile);
    if(!task || !agent) throw new Error('fincrime.task_not_found');
    const response=await (this.options.fetch??fetch)(this.options.endpoint,{method:'POST',redirect:'error',
      headers:{authorization:`Bearer ${await this.options.token()}`,'content-type':'application/json'},
      body:JSON.stringify({api_version:'fincrime.ehf/plan-request-v1',task_id:taskId,task_hash:task.sha256,profile_hash:agent.sha256,inputs}),signal:AbortSignal.timeout(10_000)});
    if(!response.ok) throw new Error(`fincrime.plan_http_${response.status}`);
    const plan=taskPlanSchema.parse(await response.json());
    if(plan.task_id!==taskId || plan.task_hash!==task.sha256 || plan.profile_hash!==agent.sha256 || plan.profile_id!==agent.value.id) throw new Error('fincrime.plan_binding_invalid');
    return plan;
  }
  async execute(scope: AssignmentScope, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeOutcome> {
    const request = bridgeRequestSchema.parse({ api_version: "fincrime.ehf/assignment-v1", scope, parameters });
    const response = await (this.options.fetch ?? fetch)(this.options.endpoint, { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${await this.options.token()}`, "content-type": "application/json" },
      body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`fincrime.http_${response.status}`);
    const output = bridgeOutcomeSchema.parse(await response.json());
    if (canonicalJson(output.scope) !== canonicalJson(scope)) throw new Error("fincrime.response_scope_mismatch");
    if(!output.error_code && (!output.context_manifest || !output.context_hash)) throw new Error('fincrime.context_manifest_missing');
    return output;
  }
}

/** A successful HTTP call is not a completed business task. Controller must retain this classification. */
export function classifyOutcome(outcome: BridgeOutcome): "complete" | "human" | "evidence" | "blocked" | "failed" {
  if (outcome.status === "COMPLETED") return outcome.proposed_commands.length ? "human" : "complete";
  if (outcome.status === "NEEDS_REVIEW") return "human";
  if (outcome.status === "NEEDS_EVIDENCE" || outcome.status === "PARTIAL") return "evidence";
  return outcome.status === "BLOCKED" ? "blocked" : "failed";
}

/** Persist an execution observation; this command never promotes facts or executes proposed actions. */
export function outcomeCaseCommand(outcome:BridgeOutcome,input:Pick<BusinessCommand,'actor'|'authority'|'preconditions'>):BusinessCommand {
  return businessCommandSchema.parse({commandId:`FC-${stableDigest(outcome).slice(0,40)}`,commandType:'RecordFinancialCrimeOutcome',
    commandVersion:'1.0.0',tenantId:outcome.scope.tenant_id,caseId:outcome.scope.case_id,...input,payload:{outcome},
    idempotencyKey:`fincrime:${outcome.scope.work_item_id}:${outcome.scope.execution_id}`});
}
