-- Which pinned implementation candidate served a skill-bound invocation, and why
-- ({skillId, skillVersion, selectedCapabilityId, selectedConnectorId, candidateIndex, reason}).
-- Null for invocations from nodes that are not bound to a business skill.
alter table harness_gateway.receipts add column if not exists skill_selection jsonb;
