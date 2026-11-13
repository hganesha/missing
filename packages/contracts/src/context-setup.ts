import { z } from "zod";
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const column = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/);
const safePath = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (p) =>
      p
        .split(".")
        .every(
          (s) =>
            /^[a-zA-Z0-9_]+$/.test(s) &&
            !["__proto__", "prototype", "constructor"].includes(s),
        ),
    "context.mapping_path_invalid",
  );
export type MappingExpression =
  | { op: "field"; path: string }
  | { op: "literal"; value: unknown }
  | {
      op:
        | "trim"
        | "lower"
        | "upper"
        | "decimal"
        | "instant"
        | "integer"
        | "boolean"
        | "date"
        | "json"
        | "percent_fraction";
      value: MappingExpression;
    }
  | { op: "lookup"; value: MappingExpression; values: Record<string, string> }
  | { op: "id"; namespace: string; value: MappingExpression }
  | { op: "object"; fields: Record<string, MappingExpression> }
  | { op: "array"; items: MappingExpression[] }
  | { op: "coalesce"; values: MappingExpression[] }
  | { op: "concat"; values: MappingExpression[]; separator: string }
  | { op: "split"; value: MappingExpression; separator: string }
  | {
      op: "crosswalk";
      value: MappingExpression;
      revision: string;
      reviewedBy: string;
      values: Record<string, string>;
    };
export const mappingExpressionSchema: z.ZodType<MappingExpression> = z.lazy(
  () =>
    z.discriminatedUnion("op", [
      z.object({ op: z.literal("field"), path: safePath }).strict(),
      z
        .object({
          op: z.literal("coalesce"),
          values: z.array(mappingExpressionSchema).min(1).max(16),
        })
        .strict(),
      z
        .object({
          op: z.literal("concat"),
          values: z.array(mappingExpressionSchema).min(1).max(16),
          separator: z.string().max(32),
        })
        .strict(),
      z
        .object({
          op: z.literal("split"),
          value: mappingExpressionSchema,
          separator: z.string().min(1).max(32),
        })
        .strict(),
      z
        .object({
          op: z.literal("crosswalk"),
          value: mappingExpressionSchema,
          revision: hash,
          reviewedBy: id,
          values: z.record(
            z.string().min(1).max(256),
            z.string().min(1).max(256),
          ),
        })
        .strict(),
      z.object({ op: z.literal("literal"), value: z.unknown() }).strict(),
      z
        .object({
          op: z.enum([
            "trim",
            "lower",
            "upper",
            "decimal",
            "instant",
            "integer",
            "boolean",
            "date",
            "json",
            "percent_fraction",
          ]),
          value: mappingExpressionSchema,
        })
        .strict(),
      z
        .object({
          op: z.literal("lookup"),
          value: mappingExpressionSchema,
          values: z.record(z.string().max(128), z.string().max(512)),
        })
        .strict(),
      z
        .object({
          op: z.literal("id"),
          namespace: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/),
          value: mappingExpressionSchema,
        })
        .strict(),
      z
        .object({
          op: z.literal("object"),
          fields: z.record(column, mappingExpressionSchema),
        })
        .strict(),
      z
        .object({
          op: z.literal("array"),
          items: z.array(mappingExpressionSchema).max(64),
        })
        .strict(),
    ]),
);
export const postgresContextConnectionSchema = z
  .object({
    kind: z.literal("connection"),
    id,
    name: z.string().trim().min(1).max(120),
    connectorId: id,
    credentialRef: z.string().regex(/^CONTEXT_SOURCE_[A-Z0-9_]{1,70}$/),
    credentialGeneration: id,
    identityMode: z.literal("service"),
    resources: z
      .array(
        z
          .object({
            schema: column,
            table: column,
            columns: z.array(column).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export const postgresContextResourceBindingSchema = z
  .object({
    kind: z.literal("resource"),
    id,
    connectionId: id,
    connectionDigest: hash,
    schema: column,
    table: column,
    columns: z.array(column).min(1).max(100),
    subjectColumn: column,
    observedAtColumn: column,
    schemaFingerprint: hash.nullable(),
    maxRows: z.number().int().min(1).max(100).default(100),
  })
  .strict();
const apiPath = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/);
const httpsOrigin = z
  .url()
  .max(500)
  .refine((value) => {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/"
    );
  }, "context.api_origin_invalid");
export const apiContextConnectionSchema = z
  .object({
    kind: z.literal("connection"),
    id,
    name: z.string().trim().min(1).max(120),
    connectorId: id,
    credentialRef: z.string().regex(/^CONTEXT_SOURCE_[A-Z0-9_]{1,70}$/),
    credentialGeneration: id,
    identityMode: z.literal("service"),
    api: z
      .object({
        kind: z.enum(["salesforce", "fenergo"]),
        baseUrl: httpsOrigin,
        tokenUrl: z
          .url()
          .max(500)
          .refine((v) => {
            const u = new URL(v);
            return (
              u.protocol === "https:" &&
              !u.username &&
              !u.password &&
              !u.search &&
              !u.hash
            );
          }),
        instanceId: id,
        scope: z.string().max(300).optional(),
        apiVersion: z
          .string()
          .regex(/^v[0-9]{2,3}\.0$/)
          .optional(),
      })
      .strict(),
    resources: z
      .array(
        z
          .object({ datasetId: id, fields: z.array(apiPath).min(1).max(100) })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
const fenergoPath = z
  .string()
  .max(500)
  .regex(
    /^\/(entitydataquery|associationquery|journeyquery|documentmanagementquery|screeningquery)\/api\/[A-Za-z0-9_./-]*\{subject\}[A-Za-z0-9_./-]*$/,
  )
  .refine((v) => !v.includes("..") && !v.includes("//"));
export const apiContextResourceSchema = z
  .object({
    kind: z.literal("resource"),
    id,
    connectionId: id,
    connectionDigest: hash,
    datasetId: id,
    columns: z.array(column).min(1).max(100),
    subjectColumn: column,
    observedAtColumn: column,
    schemaFingerprint: hash.nullable(),
    maxRows: z.number().int().min(1).max(100).default(100),
    api: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("salesforce"),
          object: column,
          subjectField: apiPath,
          fields: z.record(column, apiPath),
        })
        .strict(),
      z
        .object({
          kind: z.literal("fenergo"),
          path: fenergoPath,
          schemaPath: z
            .string()
            .regex(
              /^\/(entitydataquery|associationquery|journeyquery|documentmanagementquery|screeningquery)\/swagger\/[A-Za-z0-9._/-]+\.json$/,
            )
            .refine((v) => !v.includes("..") && !v.includes("//")),
          recordsPath: apiPath.optional(),
          nextPath: apiPath.optional(),
          fields: z.record(column, apiPath),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((r, ctx) => {
    const aliases = Object.keys(r.api.fields);
    if (
      new Set(r.columns).size !== r.columns.length ||
      aliases.length !== r.columns.length ||
      !r.columns.every((c) => aliases.includes(c)) ||
      !r.columns.includes(r.subjectColumn) ||
      !r.columns.includes(r.observedAtColumn)
    )
      ctx.addIssue({ code: "custom", message: "context.api_fields_invalid" });
    if (
      r.api.kind === "salesforce" &&
      r.api.fields[r.subjectColumn] !== r.api.subjectField
    )
      ctx.addIssue({
        code: "custom",
        message: "context.api_subject_field_invalid",
      });
  });
export const contextConnectionSchema = z.union([
  postgresContextConnectionSchema,
  apiContextConnectionSchema,
]);
export const contextResourceBindingSchema = z.union([
  postgresContextResourceBindingSchema,
  apiContextResourceSchema,
]);
/** API sources may supply observations, never platform execution or decision authority. */
export const BANK_CONTEXT_RECORD_TYPES: ReadonlySet<string> = new Set([
  "Entity",
  "Party",
  "CustomerRelationship",
  "IdentityIdentifier",
  "Identity",
  "Address",
  "Alias",
  "Relationship",
  "OwnershipInterest",
  "OwnershipRange",
  "OfficerRole",
  "ControlRight",
  "BeneficialOwner",
  "OwnershipGraph",
  "Account",
  "Product",
  "Counterparty",
  "ExpectedActivity",
  "GeographyExposure",
  "RiskAssessment",
  "RiskFactor",
  "SourceOfFunds",
  "SourceOfWealth",
  "ScreeningExecution",
  "ScreeningHit",
  "WatchlistEntry",
  "PEPRelationship",
  "AdverseMediaEvent",
  "SourceRecord",
  "Evidence",
  "VerificationRecord",
  "TimelineEvent",
  "RegistryRecord",
  "Registration",
  "License",
]);
export const contextCaseBindingSchema = z
  .object({
    kind: z.literal("case-binding"),
    id,
    caseId: id,
    mappingId: id,
    mappingDigest: hash,
    enablementRevision: z.number().int().positive(),
    planDigest: hash,
    nodeId: id,
    sourceContextDigest: hash,
    subjects: z
      .array(
        z
          .object({
            subjectId: z.string().min(1).max(256),
            sourceKey: z.string().min(1).max(256),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (
      new Set(b.subjects.map((s) => s.subjectId)).size !== b.subjects.length ||
      new Set(b.subjects.map((s) => s.sourceKey)).size !== b.subjects.length
    )
      ctx.addIssue({
        code: "custom",
        message: "context.case_subjects_duplicate",
      });
  });
export const contextCaseBindingSaveSchema = z
  .object({
    binding: contextCaseBindingSchema,
    expectedRevision: z.number().int().min(0),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const contextPullRequestSchema = z
  .object({
    bindingId: id,
    expectedBindingDigest: hash,
    subjects: z.array(z.string().min(1).max(256)).min(1).max(20),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();
export type PostgresContextConnection = z.infer<
  typeof postgresContextConnectionSchema
>;
export type PostgresContextResource = z.infer<
  typeof postgresContextResourceBindingSchema
>;
export type ApiContextConnection = z.infer<typeof apiContextConnectionSchema>;
export type ApiContextResource = z.infer<typeof apiContextResourceSchema>;
export type ContextCaseBinding = z.infer<typeof contextCaseBindingSchema>;
export function contextDatasetId(resource: ContextResourceBinding): string {
  return "api" in resource
    ? resource.datasetId
    : `${resource.schema}.${resource.table}`;
}
export function contextSourceFields(
  resource: ContextResourceBinding,
): string[] {
  return "api" in resource
    ? [...new Set(Object.values(resource.api.fields))]
    : resource.columns;
}
export const canonicalMappingSchema = z
  .object({
    kind: z.literal("mapping"),
    id,
    name: z.string().trim().min(1).max(120),
    productId: id,
    resourceId: id,
    resourceDigest: hash,
    schemaVersion: z.string().min(1).max(32),
    catalogDigest: hash,
    subject: mappingExpressionSchema,
    outputs: z
      .array(
        z
          .object({
            objectType: id,
            collection: safePath.optional(),
            identity: mappingExpressionSchema,
            fields: z.record(column, mappingExpressionSchema),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export const contextDefinitionSchema = z.union([
  contextConnectionSchema,
  contextResourceBindingSchema,
  canonicalMappingSchema,
  contextCaseBindingSchema,
]);
export const saveContextDefinitionSchema = z
  .object({
    definition: contextDefinitionSchema,
    expectedRevision: z.number().int().min(0),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const contextAuthoritySchema = z
  .object({
    planDigest: hash,
    contextDigest: hash,
    capabilityId: id,
    connectorId: id,
  })
  .strict();
export const contextSampleRequestSchema = z
  .object({
    mappingId: id,
    expectedDigest: hash,
    origin: z.enum(["uploaded", "fixture", "live"]),
    rows: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
    observedAt: z.iso.datetime({ offset: true }).optional(),
    subjects: z.array(z.string().min(1).max(256)).min(1).max(20).optional(),
    authority: contextAuthoritySchema.optional(),
    consumer: z.object({ agentId: id, taskId: id }).strict().optional(),
  })
  .strict();
export type ContextDefinition = z.infer<typeof contextDefinitionSchema>;
export type ContextSetupConnection = z.infer<typeof contextConnectionSchema>;
export type ContextResourceBinding = z.infer<
  typeof contextResourceBindingSchema
>;
export type CanonicalMapping = z.infer<typeof canonicalMappingSchema>;
export type ContextAuthority = z.infer<typeof contextAuthoritySchema>;
export type ContextDefinitionRevision = {
  definition: ContextDefinition;
  revision: number;
  digest: string;
  createdAt: string;
  createdBy: string;
};
export type ContextMappingIssue = {
  code: string;
  row: number | null;
  objectType: string | null;
  field: string | null;
  message: string;
  action: string;
};
export type ContextCandidate = {
  object_type: string;
  object_id: string;
  version_id: string;
  schema_version: string;
  data: Record<string, unknown>;
  subject_ids: string[];
  observed_at: string;
  row: number;
};
export type ContextSampleReport = {
  id: string;
  mappingId: string;
  mappingDigest: string;
  resourceDigest: string;
  connectionDigest: string;
  compilationDigest: string;
  schemaVersion: string;
  catalogDigest: string;
  origin: "uploaded" | "fixture" | "live";
  createdAt: string;
  expiresAt: string;
  actor: string;
  inputDigest: string;
  schemaFingerprint: string | null;
  counts: {
    rows: number;
    acceptedRows: number;
    rejectedRows: number;
    duplicateRecords: number;
    candidates: number;
    subjects: number;
  };
  stages: Array<{
    stage:
      | "fetch"
      | "transform"
      | "validate"
      | "relationships"
      | "assess"
      | "packet";
    status: "passed" | "attention" | "unavailable";
    detail: string;
  }>;
  issues: ContextMappingIssue[];
  candidates: ContextCandidate[];
  lineage: Array<{
    row: number;
    objectId: string;
    field: string;
    sourcePaths: string[];
  }>;
  limitations: string[];
  authority: ContextAuthority | null;
  sourceDecision: unknown | null;
  parameters?: { subjects: string[] | null; observedAt: string | null };
  assessment?: {
    agentId: string;
    taskId: string;
    gaps: Array<{
      subjectId: string;
      skillId: string;
      objectType: string;
      code: string;
      message: string;
    }>;
    limitations: string[];
  };
};
export class ContextSetupError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
