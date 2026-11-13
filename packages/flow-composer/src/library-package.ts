// The v2 domain-package builder for financial-crime skill library workflows, shared by every package
// generator (scripts/lib/library-package.mjs re-exports it) and by run-time flow composition.
// Pure: no file or network access; every input is an argument.
// @ts-nocheck -- a line-for-line port of the generator's JavaScript; its outputs are pinned byte for
// byte by the generated domain packages (CI drift checks), which is the test of this module.
import { stringify } from "yaml";
import { businessSkillCaseCommands, businessSkillManifestDigest, skillGrantsFor } from "@ehf/contracts";

export const nodeId = (stepId: string) => stepId.replaceAll("_", "-");
const majorOf = (semver: string) => semver.split(".")[0];
export const capabilityFor = (skillId: string, semver: string) => `skill.${skillId}.v${majorOf(semver)}`;
// Capability effect class from the registry entry's effect mode (CR-5): case commands are
// reversible, an external action (regulatory filing, retention deletion) is irreversible.
const EFFECT_CLASS = { read_only: "read", proposal: "reversible", internal_write: "reversible", external_write: "irreversible" };
const GATE_OUTCOMES = ["ALLOW", "BLOCK", "REVIEW", "UNKNOWN", "ERROR"];
const strip = (schema) => {
  const { $schema: _schema, ...rest } = schema;
  return rest;
};


/**
 * A skill binding's pinned write authority (skill.execution.v1 §6.2–6.3): the registry entry's
 * effect mode and approval, and the case commands its manifest authorizes (`case_command:<Type>`).
 * harnessc refuses node grants that exceed it.
 */
export function bindingEffects(entry) {
  const caseCommands = entry.effects.mode === "internal_write" || entry.effects.mode === "external_write" ? businessSkillCaseCommands(entry.manifest) : [];
  return { mode: entry.effects.mode, approval: entry.effects.approval, caseCommands };
}

/** The skill grants a node needs for a binding's pinned effects (`config.caseWrites` entries). */
export function skillGrantEntries(effects) {
  const grants = skillGrantsFor(effects);
  return [
    ...grants.proposal.map((commandType) => ({ commandType, skillGrant: "proposal" })),
    ...grants.effect.map((commandType) => ({ commandType, skillGrant: "effect" })),
    ...grants.held.map((commandType) => ({ commandType, skillGrant: "held" })),
  ];
}

/**
 * Record selectors for one skill's declared context, owned by `ownerId` (a node), as the
 * generator makes them for skill nodes: `rec<ObjectType>-<ownerId>`. An agent loop's skills pass
 * a per-skill `ownerId` (`<node>-<skill>`), so two skills reading one type keep their own fields.
 */
export function recordSelectorsFor(manifest, ownerId, purpose) {
  return [...(manifest.required_context ?? []), ...(manifest.optional_context ?? [])].map((requirement) => ({
    id: `rec${requirement.object_type}-${ownerId}`, source: "case", path: `records.${requirement.object_type}`, purpose, classification: "CONFIDENTIAL",
    required: requirement.optional !== true,
    record: { objectType: requirement.object_type, fields: requirement.fields,
      ...(requirement.nullable_fields?.length ? { nullableFields: requirement.nullable_fields } : {}),
      minCount: requirement.min_count ?? 1, maxAgeSeconds: requirement.max_age_seconds ?? null },
  }));
}


/**
 * Build the package and workflow documents. Pure: the registry (config/business-skills.json entries keyed
 * `skill_id@semver`) and everything else come from the arguments.
 *
 * overlay fields:
 *   purpose, subjectsSelectorId, contextSelectors (base selectors), connectors[], inserts[]
 *   ({ before: stepId, stage } | { before: stepId, gate: node, continueOn: [outcomes] } |
 *   { before: stepId, node }),
 *   preNodes[] (after intake, before the first step), connectorNode(connector) -> node,
 *   skillNode(step, manifest, node) -> node (add config/selectors), approval { config,
 *   contextSelectorIds }, stop, result, packageDocument(base) -> doc, workflowDocument(base) -> doc,
 *   skillBindingPolicy, extraSelectors(step, manifest) -> selectors,
 *   extraSkills[] (skill ids an agent loop may run: capability and binding, no node)
 */
/** What a policy checkpoint transform may return (pack-gate.ts PackGateOutcome). */
const CHECKPOINT_OUTCOMES = ["ALLOW", "REVIEW", "BLOCK", "UNKNOWN"];

export function buildLibraryPackage({ workflow, library, overlay, registry }: { workflow: any; library: any; overlay: any; registry: Map<string, any> }): { packageDocument: any; workflowDocument: any; manifests: Map<string, any> } {
  const manifests = new Map(library.skills.map((skill) => [skill.id, skill]));
  const effectsOf = (manifest) => {
    const entry = registry.get(`${manifest.id}@${manifest.semver}`);
    if (!entry) throw new Error(`library.registry_entry_missing:${manifest.id}@${manifest.semver}`);
    return bindingEffects(entry);
  };
  const steps = workflow.steps;
  for (const step of steps) {
    if (!manifests.has(step.skill_id)) throw new Error(`library.manifest_missing:${step.skill_id}`);
  }
  const capabilities = [];
  const skillBindings = [];
  const contextSelectors = [...overlay.contextSelectors];
  for (const connector of overlay.connectors) {
    capabilities.push({
      id: connector.capability, kind: "tool", effect: "read", adapterBindingId: connector.connector,
      inputSchema: connector.input, outputSchema: connector.output, timeoutMs: connector.timeoutMs, maxAttempts: 1, idempotent: true,
    });
  }

  const bindSkill = (manifest) => {
    const semver = manifest.semver;
    const capabilityId = capabilityFor(manifest.id, semver);
    if (!capabilities.some((capability) => capability.id === capabilityId)) {
      capabilities.push({
        id: capabilityId,
        kind: "tool",
        effect: EFFECT_CLASS[effectsOf(manifest).mode] ?? (() => { throw new Error(`library.effect_unmapped:${manifest.id}:${effectsOf(manifest).mode}`); })(),
        adapterBindingId: `skills:${manifest.id}`,
        // SkillCapabilityInput.v1 / SkillCapabilityOutput.v1 with the manifest's own schemas inside.
        inputSchema: { type: "object", required: ["input", "context"], properties: { input: { type: "object", required: ["parameters"], properties: { parameters: strip(manifest.input_schema) } }, context: { type: "object" } } },
        outputSchema: { type: "object", required: ["contract_version", "skill_id", "skill_version", "lifecycle"], properties: { lifecycle: { type: "string" }, computation: { type: ["object", "null"], properties: { payload: strip(manifest.output_schema) } } } },
        timeoutMs: (manifest.timeout ?? manifest.cost_latency_budget?.timeout_seconds ?? 30) * 1000,
        maxAttempts: 1,
        idempotent: true,
      });
      skillBindings.push({
        skillId: manifest.id,
        semver,
        manifestDigest: `sha256:${businessSkillManifestDigest(manifest)}`,
        bundleDigest: `sha256:${library.source.bundleCodeHash}`,
        candidates: [capabilityId],
        policy: overlay.skillBindingPolicy,
        effects: effectsOf(manifest),
      });
    }
  };
  const recordSelectorsBySkill = new Map();
  for (const step of steps) {
    const manifest = manifests.get(step.skill_id);
    bindSkill(manifest);
    const selectors = [];
    for (const requirement of [...(manifest.required_context ?? []), ...(manifest.optional_context ?? [])]) {
      const id = `rec${requirement.object_type}-${nodeId(step.id)}`;
      contextSelectors.push({
        id, source: "case", path: `records.${requirement.object_type}`, purpose: overlay.purpose, classification: "CONFIDENTIAL",
        required: requirement.optional !== true,
        record: { objectType: requirement.object_type, fields: requirement.fields,
      ...(requirement.nullable_fields?.length ? { nullableFields: requirement.nullable_fields } : {}),
      minCount: requirement.min_count ?? 1, maxAgeSeconds: requirement.max_age_seconds ?? null },
      });
      selectors.push(id);
    }
    recordSelectorsBySkill.set(step.id, selectors);
  }
  for (const skillId of overlay.extraSkills ?? []) {
    const manifest = manifests.get(skillId);
    if (!manifest) throw new Error(`library.manifest_missing:${skillId}`);
    bindSkill(manifest);
  }

  // Graph. `pending` holds the edges still waiting for the next node: each entry is a source
  // node plus the edge extras (a library success condition, a gate outcome, an approval
  // decision), and the stop edges to emit right after the continuing ones.
  const nodes = [overlay.intake];
  const edges = [];
  let edgeCount = 0;
  const edge = (from, to, extra = {}) => edges.push({ id: `e${String(++edgeCount).padStart(2, "0")}`, from, to, kind: extra.condition ? "control" : "data", ...extra });
  let pending = [{ from: overlay.intake.id, extras: [{}], stops: [] }];
  const connect = (targets) => {
    for (const entry of pending) {
      for (const extra of entry.extras) for (const target of targets) edge(entry.from, target, extra);
      for (const stop of entry.stops) edge(entry.from, overlay.stop.id, stop);
    }
  };
  const add = (node) => {
    nodes.push(node);
    connect([node.id]);
    pending = [{ from: node.id, extras: [{}], stops: [] }];
  };
  const condition = (field, op, value) => `${field} ${op} ${JSON.stringify(value)}`;

  for (const node of overlay.preNodes ?? []) add(node);

  for (const [index, step] of steps.entries()) {
    if (step.dependencies.length > 1) throw new Error(`library.dependencies_unsupported:${step.id}`);
    if (index > 0 && step.dependencies[0] !== steps[index - 1].id) throw new Error(`library.order_unsupported:${step.id}`);
    if (index === 0 && step.dependencies.length) throw new Error(`library.order_unsupported:${step.id}`);
    for (const insert of overlay.inserts.filter((item) => item.before === step.id)) {
      if (insert.stage) {
        const stageConnectors = overlay.connectors.filter((connector) => connector.stage === insert.stage);
        if (!stageConnectors.length) throw new Error(`library.stage_empty:${insert.stage}`);
        const connectorNodes = stageConnectors.map((connector) => overlay.connectorNode(connector));
        nodes.push(...connectorNodes);
        connect(connectorNodes.map((node) => node.id));
        // One acquisition needs no barrier (a join takes at least two inputs): continue from it.
        if (connectorNodes.length === 1) {
          pending = [{ from: connectorNodes[0].id, extras: [{}], stops: [] }];
          continue;
        }
        const join = `${insert.stage}-acquired`;
        nodes.push({ id: join, kind: "join", name: `${insert.stage[0].toUpperCase()}${insert.stage.slice(1)} acquisition barrier`, summary: "Wait for every acquisition; a failed provider stays visible as a rejected settlement and its records are simply absent (the skill then reports CONTEXT_MISSING).", contextSelectorIds: [], config: { join: "allSettled", mode: "allSettled" } });
        for (const connector of stageConnectors) edge(connector.id, join);
        pending = [{ from: join, extras: [{}], stops: [] }];
      } else if (insert.checkpoint) {
        add(insert.checkpoint);
        // A checkpoint continues on the outcomes it names (default ALLOW only) and stops on the rest.
        // With only ALLOW, one `!=` edge stops everything else; otherwise one stop edge per outcome.
        const outcome = `${insert.checkpoint.id}.outcome`;
        const continueOn = insert.continueOn ?? ["ALLOW"];
        pending = [{ from: insert.checkpoint.id,
          extras: continueOn.map((value) => ({ condition: condition(outcome, "==", value) })),
          stops: continueOn.length === 1 && continueOn[0] === "ALLOW"
            ? [{ condition: condition(outcome, "!=", "ALLOW") }]
            : CHECKPOINT_OUTCOMES.filter((value) => !continueOn.includes(value)).map((value) => ({ condition: condition(outcome, "==", value) })) }];
      } else if (insert.node) {
        // A plain platform node (an advisory agent loop): it runs in sequence and always
        // continues; it carries no authority to stop or route the workflow.
        add(insert.node);
      } else if (insert.gate) {
        add(insert.gate);
        const continueOn = insert.continueOn ?? ["ALLOW"];
        const outcomes = insert.gate.config?.businessDecision === "v2" ? ["DECIDED", "NEEDS_EVIDENCE", "NEEDS_HUMAN", "NOT_APPLICABLE", "UNRESOLVED"] : GATE_OUTCOMES;
        // An OPA gate continues only on the outcomes it names; every other outcome ends the
        // run at the stop node, so an unknown or blocked case never reaches the next stage.
        pending = [{
          from: insert.gate.id,
          extras: continueOn.map((outcome) => ({ outcome })),
          stops: outcomes.filter((outcome) => !continueOn.includes(outcome)).map((outcome) => ({ outcome })),
        }];
      } else {
        throw new Error(`library.insert_invalid:${step.id}`);
      }
    }

    const manifest = manifests.get(step.skill_id);
    const bindings = Object.fromEntries(Object.entries(step.bindings ?? {}).map(([target, source]) => {
      const [from, ...rest] = source.split(".");
      if (!steps.slice(0, index).some((candidate) => candidate.id === from)) throw new Error(`library.binding_source_invalid:${step.id}:${source}`);
      return [target, [nodeId(from), ...rest].join(".")];
    }));
    const base = {
      id: nodeId(step.id), kind: "tool", name: step.skill_id,
      summary: manifest.description,
      contextSelectorIds: [overlay.subjectsSelectorId, ...recordSelectorsBySkill.get(step.id)],
      config: {
        skillId: step.skill_id,
        skillParameters: step.parameters ?? {},
        ...(Object.keys(bindings).length ? { skillParameterBindings: bindings } : {}),
        skillPurpose: overlay.skillPurpose ?? "onboarding",
        libraryStep: step.id,
        libraryEffects: manifest.effects,
      },
    };
    const authored = overlay.skillNode ? overlay.skillNode(step, manifest, base) : base;
    // A stopped EDD path and a review date must create durable human work, not just
    // an informational payload. Completing work never satisfies a control by itself.
    const lifecycleWrite = step.skill_id === "edd.trigger.evaluate" ? {
      commandType: "ProposeWorkItem", when: "output.computation.payload.required == true",
      payload: { workItemId: "edd_{{ run.runId }}", workType: "EDD_REVIEW", priority: "HIGH",
        description: "Scope EDD under the pinned policy, collect and review supporting evidence, obtain the required acceptance approval and record current control assessments before resuming." },
      payloadSchema: { type: "object", required: ["workItemId", "workType", "description"] },
    } : step.skill_id === "monitor.customer.schedule" ? {
      commandType: "ProposeWorkItem", when: "output.computation.payload.due_at",
      payload: { workItemId: "review_{{ output.computation.payload.schedule_id }}", workType: "PERIODIC_CDD_REVIEW", priority: "NORMAL",
        dueAt: "{{ output.computation.payload.due_at }}", description: "Perform the policy-scoped periodic CDD review; reassess material changes and retain the evidence and authorized outcome." },
      payloadSchema: { type: "object", required: ["workItemId", "workType", "dueAt"] },
    } : null;
    if (lifecycleWrite && !overlay.policyOwnedActions) authored.config = { ...authored.config, caseWrites: [...(authored.config.caseWrites ?? []), lifecycleWrite] };
    // Grants to commit what the skill returns, exactly what its registry entry allows (and no
    // more: harnessc refuses a grant beyond the binding's pinned effects).
    const grants = skillGrantEntries(effectsOf(manifest));
    const node = grants.length
      ? { ...authored, config: { ...authored.config, caseWrites: [...(authored.config.caseWrites ?? []), ...grants] } }
      : authored;
    add(node);
    if (step.success_condition) {
      const { field, op, value } = step.success_condition;
      if (op !== "eq" || manifest.effects === "human_gated") throw new Error(`library.condition_unsupported:${step.id}`);
      // Library success gates: continue only when the skill's payload says so; otherwise stop for handoff.
      const path = `${node.id}.computation.${field}`;
      pending = [{ from: node.id, extras: [{ condition: condition(path, "==", value) }], stops: [{ condition: condition(path, "!=", value) }] }];
    }
    if (manifest.effects === "human_gated") {
      const approval = `${node.id}-approval`;
      if (overlay.approval.requireCompletedSkill) {
        // Only a proposal the skill actually computed goes to the reviewers; NEEDS_EVIDENCE (the
        // skill was not called) or a failed execution ends the run instead.
        const path = `${node.id}.lifecycle`;
        pending = [{ from: node.id, extras: [{ condition: condition(path, "==", "COMPLETED_EXECUTION") }], stops: [{ condition: condition(path, "!=", "COMPLETED_EXECUTION") }] }];
      }
      add({ id: approval, kind: "approval", name: `Independent approval: ${step.skill_id}`, summary: overlay.approval.summary, contextSelectorIds: overlay.approval.contextSelectorIds, config: overlay.approval.config });
      // The skill's requested effects are held until this approval; the release node commits them
      // on APPROVE and discards them (with an audit event) on REJECT, then routes on the decision.
      const release = `${node.id}-effects`;
      add({
        id: release, kind: "transform", name: `Release approved effects: ${step.skill_id}`,
        summary: "Commit the skill's held effects after an approval (re-validating case sequence and expiry), or discard them after a rejection; an external action without an outbound route stays a pending intent.",
        contextSelectorIds: [],
        config: {
          operation: "select", path: "/",
          skillEffectRelease: { skillNodeId: node.id, approvalNodeId: approval },
          caseWrites: skillGrantsFor(effectsOf(manifest)).held.map((commandType) => ({ commandType, skillGrant: "release" })),
        },
      });
      pending = [{ from: release, extras: [{ condition: condition(`${release}.decision`, "==", "APPROVE") }], stops: [{ condition: condition(`${release}.decision`, "!=", "APPROVE") }] }];
    }
  }
  for (const node of overlay.postNodes ?? []) add(node);
  for (const gate of overlay.postGates ?? []) {
    add(gate);
    pending = [{ from: gate.id, extras: [{outcome:"DECIDED"}],
      stops: ["NEEDS_EVIDENCE","NEEDS_HUMAN","NOT_APPLICABLE","UNRESOLVED"].map(outcome=>({outcome})) }];
  }
  nodes.push(overlay.stop);
  nodes.push(overlay.result);
  connect([overlay.result.id]);

  const packageDocument = overlay.packageDocument({
    capabilities,
    skillBindings,
    contextSelectors,
    connectorBindings: Object.fromEntries(overlay.connectors.map((connector) => [connector.id, connector.capability])),
    stepCount: steps.length,
  });
  const workflowDocument = overlay.workflowDocument({ nodes, edges });
  return { packageDocument, workflowDocument, manifests };
}


export const yamlOptions = { lineWidth: 0, aliasDuplicateObjects: false };
export const toYaml = (value: unknown) => stringify(value, yamlOptions);
