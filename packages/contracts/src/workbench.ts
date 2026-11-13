import { z } from "zod";

export const sourcePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !/[\x00-\x1f\x7f]/.test(path) &&
      path
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            ![".git", "__proto__", "constructor", "prototype"].includes(part),
        ),
    "Use a relative file path without traversal or reserved segments.",
  );
export const workspaceFilesSchema = z
  .record(sourcePathSchema, z.string().max(1_000_000))
  .refine(
    (files) =>
      Object.keys(files).length > 0 &&
      Object.keys(files).length <= 1500 &&
      Object.values(files).reduce(
        (size, text) => size + new TextEncoder().encode(text).length,
        0,
      ) <= 8_000_000,
    "A workspace supports up to 1,500 files and 8 MB.",
  )
  .refine(
    (files) =>
      Object.keys(files).every((path) =>
        path
          .split("/")
          .slice(0, -1)
          .every(
            (_part, index, parts) =>
              !Object.hasOwn(files, parts.slice(0, index + 1).join("/")),
          ),
      ),
    "A file cannot also be a folder.",
  );
const jsonObject = z.record(z.string(), z.unknown());
export const workbenchConfigSchema = z
  .object({
    kind: z.enum(["skill", "agent"]),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).default(""),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
    engine: z.enum(["python", "javascript", "library-skill", "agent"]),
    entrypoint: z.string().min(1).max(240),
    inputSchema: jsonObject.default({ type: "object" }),
    outputSchema: jsonObject.default({ type: "object" }),
    modelProfileId: z.string().nullable().default(null),
    skillRefs: z
      .array(
        z
          .object({
            id: z.string(),
            version: z.string(),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type WorkbenchConfig = z.infer<typeof workbenchConfigSchema>;
export function workspaceConfig(
  files: Record<string, string>,
): WorkbenchConfig {
  const config = workbenchConfigSchema.parse(
    JSON.parse(files["workbench.json"] ?? "null"),
  );
  if (config.engine === "agent") {
    sourcePathSchema.parse(config.entrypoint);
    if (config.kind !== "agent" || !Object.hasOwn(files, config.entrypoint))
      throw new Error("workbench.agent_prompt_required");
  } else {
    const [module, name, ...extra] = config.entrypoint.split(":");
    if (extra.length || !module || !name || !/^[a-zA-Z_]\w*$/.test(name))
      throw new Error("workbench.entrypoint_invalid");
    const path =
      config.engine === "javascript"
        ? module
        : module.replaceAll(".", "/") + ".py";
    sourcePathSchema.parse(path);
    if (!Object.hasOwn(files, path) && !Object.hasOwn(files, "src/" + path))
      throw new Error("workbench.entrypoint_missing");
  }
  if (
    new Set(config.skillRefs.map((ref) => ref.id)).size !==
    config.skillRefs.length
  )
    throw new Error("workbench.duplicate_skill_reference");
  return config;
}
export const datasetSchema = z
  .object({
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(60),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            input: z.json(),
            expected: z.json().optional(),
            assertions: z
              .array(
                z
                  .object({
                    path: z.string().max(300),
                    operator: z.enum(["equals", "contains", "exists"]),
                    value: z.unknown().optional(),
                  })
                  .strict(),
              )
              .max(50)
              .default([]),
          })
          .strict()
          .refine(
            (row) => row.expected !== undefined || row.assertions.length > 0,
            "Each test needs an expected output or assertion.",
          ),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (data) =>
      new Set(data.cases.map((row) => row.id)).size === data.cases.length,
    "Test IDs must be unique.",
  );
export type WorkbenchDataset = z.infer<typeof datasetSchema>;
export const createWorkspaceSchema = z
  .object({
    kind: z.enum(["skill", "agent"]),
    name: z.string().min(1).max(120),
    files: workspaceFilesSchema.optional(),
    sourceId: z.string().min(1).max(160).optional(),
  })
  .strict();
export const saveWorkspaceSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    message: z.string().trim().min(1).max(500),
    files: workspaceFilesSchema,
  })
  .strict();
export const evaluateWorkspaceSchema = z
  .object({
    revision: z.number().int().positive(),
    dataset: datasetSchema,
    modelProfileId: z.string().nullable().default(null),
    maxCostUsd: z.number().min(0).max(100).default(1),
  })
  .strict();
export type WorkspaceRevision = {
  workspaceId: string;
  revision: number;
  digest: string;
  files: Record<string, string>;
  config: WorkbenchConfig;
  message: string;
  actor: string;
  createdAt: string;
};
export type WorkspaceSummary = {
  workspaceId: string;
  kind: "skill" | "agent";
  name: string;
  revision: number;
  publishedRevision: number | null;
  createdBy: string;
  updatedAt: string;
};
export type ToolReceipt = {
  skillId: string;
  sourceDigest: string;
  input: unknown;
  output: unknown;
  durationMs: number;
};
export type EvaluationCase = {
  id: string;
  status: "passed" | "failed" | "error";
  actual: unknown;
  expected: unknown;
  failures: string[];
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  traceId: string | null;
  receipts: ToolReceipt[];
};
export type WorkbenchEvaluation = {
  evaluationId: string;
  workspaceId: string;
  revision: number;
  sourceDigest: string;
  datasetDigest: string;
  dataset: WorkbenchDataset;
  modelProfileId: string | null;
  modelProfileDigest: string | null;
  modelProfileRevision: number | null;
  status: "queued" | "running" | "passed" | "failed" | "error" | "cancelled";
  cases: EvaluationCase[];
  error: string | null;
  actor: string;
  createdAt: string;
  completedAt: string | null;
  maxCostUsd: number;
};
