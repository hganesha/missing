/**
 * The stages of a KYC/KYB case, in the order an analyst reads them, with the task and agent
 * behind each. The task catalog carries neither an order nor a label, so this list is the one
 * place both are stated; the BFF and the mock derive `CaseRoom.stages` from it.
 *
 * QA comes before the decision because the decision is taken on reviewed work. Document
 * intelligence is not a stage: it is part of context hydration and resolution, feeding the
 * stages rather than being one of them. (Order and exclusion confirmed 2026-11-11.)
 */
export type CaseStageDefinition = { taskId: string; label: string; agentId: string };

export const CASE_STAGES: readonly CaseStageDefinition[] = [
  { taskId: "task.intake_profile", label: "Intake & profile", agentId: "agent.intake_profile" },
  { taskId: "task.identity_ownership", label: "Identity & ownership", agentId: "agent.identity_ownership" },
  { taskId: "task.screening", label: "Screening", agentId: "agent.screening" },
  { taskId: "task.risk_edd", label: "Risk & EDD", agentId: "agent.risk_edd" },
  { taskId: "task.qa_assurance", label: "QA & assurance", agentId: "agent.qa_assurance" },
  { taskId: "task.decision_support", label: "Decision", agentId: "agent.decision_support" },
];

/** Tasks that hydrate or resolve context for a case without being a stage of it. */
export const SUPPORTING_TASKS: readonly string[] = ["task.document_intelligence"];
