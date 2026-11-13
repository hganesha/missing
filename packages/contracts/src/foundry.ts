import { z } from "zod";

export const FOUNDRY_AGENT_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
export const foundryAgentNameSchema = z.string().regex(FOUNDRY_AGENT_NAME_PATTERN);
export const foundryAgentVersionSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const foundryResponseIdSchema = z.string().regex(/^resp_[a-zA-Z0-9_-]{1,191}$/);

export const foundryProjectEndpointSchema = z.string().regex(
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.services\.ai\.azure\.com\/api\/projects\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/?$/i,
).transform(value => value.replace(/\/$/, ""));

export const foundryTraceResourceIdSchema = z.string().max(512).regex(
  /^\/subscriptions\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/resourceGroups\/[\w.()-]+\/providers\/Microsoft\.Insights\/components\/[\w.-]+$/i,
);

export const foundryProjectTraceSchema = z.object({
  projectEndpoint: foundryProjectEndpointSchema,
  agentName: foundryAgentNameSchema,
  agentVersion: foundryAgentVersionSchema,
  applicationInsightsResourceId: foundryTraceResourceIdSchema,
}).strict();

export const foundryTraceBindingSchema = foundryProjectTraceSchema.extend({
  tenantId: z.string().min(1).max(256),
  contentIsolation: z.enum(["verified", "synthetic_only"]),
  qualificationExpiresAt: z.iso.datetime({ offset: true }).optional(),
}).strict().refine(
  value => value.contentIsolation !== "verified" || value.qualificationExpiresAt !== undefined,
  "Verified Foundry trace bindings require a qualification expiration.",
);

export type FoundryTraceBinding = z.infer<typeof foundryTraceBindingSchema>;

export function isFoundryTraceBindingQualified(binding: FoundryTraceBinding, production: boolean, now = Date.now()): boolean {
  if (binding.contentIsolation === "synthetic_only") return !production;
  return binding.qualificationExpiresAt !== undefined && Date.parse(binding.qualificationExpiresAt) > now;
}

export type FoundryInvocationLink = z.infer<typeof foundryProjectTraceSchema> & {
  traceId: string;
  parentSpanId: string;
  responseId: string;
  startedAt: string;
  completedAt: string;
};
