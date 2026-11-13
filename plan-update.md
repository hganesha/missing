# Sandbox Studio plan update

Make **Process Studio → Sandbox Runs** the shared place to launch and investigate sandbox executions. A person should be able to answer three questions from one run: what the workflow collected, what each skill and capability did with it, and why the run continued, paused, or stopped.

Use the existing Sandbox Runs workspace as the foundation. Its explorer, workflow graph, timeline, and inspector already share a step selection. The next release adds inspectable evidence and calls. Later releases add run comparison, replay, and debugger controls.

## One workspace for different test types

Keep the current routes, run links, and history. Add launch type, target, fixture, revision, provider mode, status, and outcome filters as additional kinds of runs join the workspace.

| Launch type | Entry point and execution |
|---|---|
| Process flow | Start from Studio or **Run in sandbox** on a saved process draft. Pin the draft revision, plan, policy, and synthetic party. Keep the current real runtime and fresh-case behavior. |
| Draft rehearsal | Open fixture-based draft test results in the same inspector. Show which values came from fixtures and which steps actually ran. |
| Skill or capability probe | Open an isolated run from the relevant Studio or catalog view. Pin the contract and version, validate the sample input, and show the result using the same calls and payload views. Start with fixture or read-only probes. |
| Document extraction test | Link Document Studio tests to the shared inspector. Reuse the document viewer, annotations, and extraction contracts. Keep the focused extraction editor as a launch shortcut. |

Start with process runs, then adapt the other launch types as their data becomes available. Each backend keeps its own execution semantics. A run adapter supplies identity, status, evidence, and supported actions to the shared UI. The UI displays the mode and provenance on every run.

## Inspection experience

Keep the execution tree at left, graph and timeline in the center, and inspector at right. The inspector opens at run scope and narrows to the selected step, attempt, or invocation. A visible scope switch brings the user back to all activity in the run. Selecting a timeline event opens its relevant tab and highlights its step. Persist the tab and selection in the URL so a link can reopen a particular call or document version.

| Inspector tab | What to show |
|---|---|
| **Overview** | Run and policy outcomes, current or failing step, attempt, duration, reported cost, and a plain-language reason. Distinguish runtime completion from policy outcomes such as **Needs evidence**. Link each issue to the corresponding evidence, call, or gate. |
| **Context** | What the run collected, with source, time, and version. At step scope, show the exact snapshot and selectors used, records supplied, excluded or unavailable records where recorded, and the reason. Link a value to the provider receipt or source document that produced it. Label case context, step input, and the model's context pack separately. |
| **Documents & Extractions** | Track each source file and version through load, classification, OCR, extraction, validation, and promotion to case evidence. Show page or field citations, extraction status, validation issues, and expected versus observed values when the fixture supplies expectations. Make it clear when a file was loaded but a later skill produced no usable extraction. |
| **Skills** | List top-level skill steps and calls inside agent steps. Show the pinned skill version, attempt, status, validation results, declared effects, and any records or writes produced. Offer **Input**, **Output**, and **Diff** views for recorded, redacted payloads. Link dependency calls to the Capabilities tab. |
| **Capabilities** | Show gateway calls for the run or selection, including model, connector, and tool calls. Show invocation ID, actual provider or binding where recorded, latency, result, policy allow or deny reason, retry, usage and reported cost where available. Group nested calls by invocation and link to their trace. |
| **Policy & Effects** | Show the pinned pack, gate outcomes, reasons, evidence gaps, approvals, and which actions were proposed, authorized, or committed. Include the action receipt and linked case write where present. |
| **Attempts** | Show attempt and fencing epoch, event order, retries, errors, and the selected attempt's checkpoint where recorded. Let the user compare attempts without losing the selected step. |

Show four distinct states for details: **Recorded**, **Not captured**, **Unavailable** (with a reason), and **Restricted**. A digest can support verification and comparison even when the associated payload is unavailable. Keep table and keyboard alternatives for the graph. Keep **Follow live** explicit so new events preserve a user's pinned selection.

## Data to reuse and capture

| Area | Current source and change needed |
|---|---|
| Launch and timeline | Use sandbox provenance, the pinned execution graph, node attempts, and incremental events. Today the inspector infers an event's attempt from timestamps. Add explicit attempt, fencing epoch, and invocation correlation to newly recorded events. Historical entries keep their best available correlation and label uncertainty. |
| Capability receipts | Start with the existing gateway receipt feed filtered by run, node, and attempt. It already exposes decisions, IDs, digests, and result metadata. Extend the read projection for the actual provider, binding, usage, and parent invocation only where the gateway records them. |
| Context and policy | Use recorded selector snapshots, policy decision receipts, and linked `model_context` evidence where it exists. A context pack can be promoted during a case write, so coverage varies. Capture a bounded reference when context is actually supplied to a model or skill. Preserve provenance so the inspector can distinguish a historical snapshot from the current case. |
| Documents and extractions | Read from existing case evidence, the evidence pipeline, and Document Studio. Link the document ID, version, extraction result, and creating invocation. Distinguish missing source documents, failed processing, and fields missing from an otherwise successful extraction. |
| Skill and step payloads | The graph returns digests. Workflow outputs and gateway result data exist for some executions, but the current browser contract doesn't provide a complete payload history. Reuse authorized references where possible. Capture explicitly selected input and output fields at the runtime or gateway boundary for the rest. |

Use a small, versioned observation record keyed by tenant, run, node, attempt, fencing epoch, and invocation where applicable. It carries timestamps, status, digests, and typed references to artifacts. Keep large payloads out of events and load tab details on demand. Add pagination and filters at the API boundary. Start with incremental polling and stop routine polling once a run settles.

Use the existing service authorization boundaries for case, evidence, event, trace, and receipt access. Check access on every referenced artifact, including direct links and downloads. Limit payload capture to sandbox executions with a defined retention window and size budget. Redact secrets and sensitive fields before persistence. Use masked, bounded previews for JSON and document content, with an audit trail for access to sensitive artifacts. Expired or older records still open as metadata-only runs.

## Delivery order

1. **Make the current live run explain itself.** Extract the tabbed inspector. Add stable selection links, actual case and policy outcomes, capability receipts, and explicit attempt correlation for new events. Keep old run links working. Ship this as the first usable slice so a user can trace a policy hold to the step and calls that preceded it.
2. **Connect context, documents, and skill payloads.** Add the bounded observation contract and reuse stored evidence and document viewers. Add field citations, redacted JSON and copy controls, and same-attempt input/output comparison. Validate capture, access, retention, and useful empty states before enabling it by default.
3. **Bring other sandbox launch types into the workspace.** Add adapters for draft rehearsals, skill and capability probes, and document tests. Link each existing launch surface into Studio. Show the fixture and execution mode with every result. Add same-fixture run comparison, starting with outcome, changed steps, call count, latency, cost, and recorded payload diffs.
4. **Add Tracepoint-style replay controls.** Start in fixture replay with immutable inputs and a simulated effects ledger. Implement pause, continue, and step over first, then step into and out for nested invocations, conditional breakpoints over allowlisted fields, and keyboard shortcuts. Label the active breakpoint and show why it fired. Expose controls only for modes that implement the underlying runtime action.
5. **Add what-if forks and targeted reruns.** Fork from a recorded checkpoint, apply schema-validated overrides, and show the baseline and fork side by side. Support **Rerun step** as an isolated probe and **Rerun downstream** as a new branch. Record the parent run, checkpoint, overrides, and effect mode. Introduce live execution controls only after the runtime supports durable safe pauses, fencing, and idempotent resume. Start each live fork with an isolated case and explicit effect permissions.

Treat **Replay recorded trace** and **Execute with fixtures** as distinct modes. Playback moves through recorded events without execution. Fixture execution evaluates the workflow with pinned inputs and declared simulated effects. Provider-backed execution continues to use the current sandbox release and case isolation.

## Implementation status

Sandbox Runs now lists live process runs, draft rehearsals, Workbench evaluations, and
Document Studio tests. Each uses its existing backend and access checks. Comparisons match
the synthetic party, fixture digest, dataset digest, or document version and contract.
Live-run comparisons use recorded status and digests. Test comparisons include changed
payload paths where the underlying report contains both values.

The **Attempts** tab of a draft rehearsal can replay its recorded step events. The
live process timeline offers the same playback once the run settles. To execute a fixture
with controls, enable **Debug in Sandbox Studio** from the saved draft’s test form.
Pause, continue, and stepping operate on the fixture worker. Breakpoints can match a
step, node kind, or capability ID. The effects tab records suppressed declarations.

A fixture checkpoint can start a single-step probe or a downstream fork. The fork
uses its parent’s compiled plan and cloned checkpoint, validates the fixture patches,
and opens a comparison with the baseline. The report retains the parent, checkpoint,
override digest, and execution mode. Checkpoints are available on the fixture worker
for 15 minutes. Durable live pauses and forks require runtime support.

## Acceptance checks

- **H02 and H04:** Open a historical live run and see runtime completion alongside `NEEDS_EVIDENCE` at the decision-readiness gate. Follow the evidence gap to the affected skill and its recorded calls. Confirm the UI distinguishes successfully loaded documents from incomplete extraction and shows that no periodic review item was committed.
- **H06:** Explain that the corpus supplied no source documents and connect that fact to the evidence-pipeline outcome. Preserve the raw provider reason in call details.
- **Approval fixture:** A policy approval creates one periodic review item, replay preserves one item, and a case held for evidence creates zero. The inspector shows the corresponding decisions and effects.
- **History and permissions:** Refresh and share a scoped link, switch attempts with no stale payload, open an older run with partial capture, and verify a different tenant or a user without evidence access cannot fetch the artifact.
- **Replay and forks:** A breakpoint halts fixture execution at the recorded boundary. Resuming continues exactly once. A what-if fork changes only its own inputs and effects, and the comparison keeps the baseline intact.

## Starting points

- [Sandbox Runs launcher](apps/web/src/studio/sandbox/SandboxRuns.tsx) and [execution workspace](apps/web/src/studio/sandbox/SandboxExecution.tsx)
- [Sandbox run behavior and APIs](docs/implementation/draft-testing.md)
- [Gateway receipt projection](apps/experience-bff/src/platform-relay-views.ts) and [stored execution outputs](packages/persistence/src/execution-work.ts)
- [Runtime evidence capture](packages/runtime-core/src/index.ts) and [case policy evaluation](apps/case-api/src/policy-evaluator.ts)
