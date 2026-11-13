import { z } from "zod";
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const contextRefreshScheduleSchema = z
  .object({
    id,
    mappingId: id,
    mappingDigest: hash,
    enablementRevision: z.number().int().positive(),
    caseId: id,
    nodeId: id,
    planDigest: hash,
    sourceContextDigest: hash,
    subjects: z.array(z.string().trim().min(1).max(256)).min(1).max(20),
    intervalMinutes: z.number().int().min(5).max(43200),
    startsAt: z.iso.datetime({ offset: true }),
    maxAttempts: z.number().int().min(1).max(3),
    enabled: z.boolean(),
  })
  .strict();
export const saveContextRefreshScheduleSchema = z
  .object({
    schedule: contextRefreshScheduleSchema,
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type ContextRefreshSchedule = z.infer<
  typeof contextRefreshScheduleSchema
>;
