import { z } from "zod";

const jsonObject = z.record(z.string(), z.unknown());
export const draftTestSampleSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(),
  input: jsonObject, context: jsonObject, capabilityOutputs: jsonObject,
}).strict();
export const draftTestBreakpointSchema = z.object({
  nodeId: z.string().min(1).max(200),
  when: z.object({ field: z.enum(["nodeKind", "capabilityId"]), equals: z.string().min(1).max(200) }).strict().optional(),
}).strict();
export const draftTestDebugSchema = z.object({
  pauseAtStart: z.boolean(),
  breakpoints: z.array(draftTestBreakpointSchema).max(20),
}).strict();
export const draftTestControlSchema = z.object({
  action: z.enum(["pause", "continue", "step_over", "step_into", "step_out"]),
  boundary: z.number().int().positive().optional(),
}).strict();
export const draftTestForkSchema = z.object({
  checkpointId: z.string().min(1).max(128),
  scope: z.enum(["step", "downstream"]),
  overrides: z.object({ input: jsonObject.optional(), context: jsonObject.optional(), capabilityOutputs: jsonObject.optional() }).strict(),
}).strict();
export const draftTestDebugStateSchema = z.object({
  state: z.enum(["running", "paused", "finished"]),
  boundary: z.object({
    sequence: z.number().int().positive(), nodeId: z.string(), capabilityId: z.string().nullable(), reason: z.string(),
  }).nullable(),
  checkpoints: z.array(z.object({ id: z.string(), nodeId: z.string() })),
  expiresAt: z.string(),
});
export const draftTestRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  mode: z.enum(["recorded", "models"]),
  debug: draftTestDebugSchema.optional(),
  input: jsonObject, context: jsonObject, capabilityOutputs: jsonObject,
}).strict();
export const draftTestNodeSchema = z.object({
  nodeId: z.string(), name: z.string(), kind: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "skipped", "blocked"]),
  input: z.unknown(), output: z.unknown(), error: z.string().nullable(),
  startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
});
export const draftTestRunSchema = z.object({
  testRunId: z.string(), draftId: z.string(), revision: z.number().int(), planDigest: z.string(),
  mode: z.enum(["recorded", "models"]),
  status: z.enum(["running", "completed", "failed", "cancelled", "blocked"]),
  createdAt: z.string(), finishedAt: z.string().nullable(), error: z.string().nullable(),
  nodes: z.array(draftTestNodeSchema), output: z.unknown(),
  warnings: z.array(z.string()),
  fixtureDigest: z.string().optional(),
  debug: draftTestDebugStateSchema.optional(),
  fork: z.object({ parentRunId: z.string(), checkpointId: z.string(), nodeId: z.string(), scope: z.enum(["step", "downstream"]),
    overrideKeys: z.array(z.string()), overrideDigest: z.string() }).optional(),
  effects: z.array(z.object({ nodeId: z.string(), command: z.string(), conditional: z.boolean() })).optional(),
  calls: z.array(z.object({
    nodeId: z.string(), capabilityId: z.string(), provider: z.string(), costUsd: z.number().nullable(),
    latencyMs: z.number().nonnegative().optional(),
  })),
});
export type DraftTestSample = z.infer<typeof draftTestSampleSchema>;
export type DraftTestRequest = z.infer<typeof draftTestRequestSchema>;
export type DraftTestRun = z.infer<typeof draftTestRunSchema>;
export type DraftTestDebug = z.infer<typeof draftTestDebugSchema>;
export type DraftTestControl = z.infer<typeof draftTestControlSchema>;
