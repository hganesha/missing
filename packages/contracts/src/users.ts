import { z } from "zod";

export const platformUserInputSchema = z.object({
  subjectId: z.string().trim().min(1).max(255).regex(/^[^\s\u0000-\u001f\u007f]+$/),
  displayName: z.string().trim().min(1).max(160),
  email: z.string().trim().email().toLowerCase().max(254),
  roles: z.array(z.string().min(1).max(80)).min(1).max(9).refine(roles => new Set(roles).size === roles.length, "Choose each role only once"),
}).strict();

/** Browser input identifies a directory result. The server resolves the actual identity. */
export const createPlatformUserSchema = z.object({
  directoryUserId: z.uuid(),
  roles: platformUserInputSchema.shape.roles,
  reason: z.string().trim().min(1).max(600),
}).strict();
export const resolvedCreatePlatformUserSchema = platformUserInputSchema.extend({ reason: z.string().trim().min(1).max(600) });
export const updatePlatformUserSchema = platformUserInputSchema.omit({ subjectId: true }).extend({
  expectedRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(600),
});
export type PlatformUserInput = z.infer<typeof platformUserInputSchema>;
export type PlatformUser = PlatformUserInput & { userId: string; revision: number; createdAt: string; updatedAt: string; updatedBy: string };
