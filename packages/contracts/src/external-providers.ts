import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const text = (max: number) => z.string().trim().max(max);

/** Configuration proposals only. These records are never consulted by invocation routing. */
export const externalProviderDraftSchema = z.object({
  id, name: text(120).min(1), description: text(2000),
}).strict();

export const externalConnectionDraftSchema = z.object({
  id, name: text(120).min(1), environment: z.enum(["sandbox", "production"]),
  adapterId: z.string().regex(/^[a-z][a-z0-9_-]*$/).nullable(),
  binding: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/).nullable(),
  endpoint: z.url().max(2048).refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "external_provider.endpoint_invalid").nullable(),
  authentication: z.enum(["workload_identity", "oauth2", "api_key", "none"]),
  credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{2,64}$/).nullable(),
  capabilityIds: z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/)).max(30),
  jurisdiction: z.string().regex(/^([a-z]{2}(_[a-z0-9]+)?|global|unresolved)$/),
  coverageNote: text(2000),
}).strict();

export const externalConnectionSaveSchema = z.object({
  connection: externalConnectionDraftSchema,
  expectedRevision: z.number().int().positive().nullable(),
}).strict();

export type ExternalProviderDraft = z.infer<typeof externalProviderDraftSchema>;
export type ExternalConnectionDraft = z.infer<typeof externalConnectionDraftSchema>;
