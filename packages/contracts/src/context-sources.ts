import { z } from "zod";
import type { DeploymentProfile } from "./deployment.js";

const id = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/);
const field = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive();
export const contextLookupPathSchema = z
  .string()
  .max(300)
  .refine((value) => {
    const parts = value.split(".");
    return (
      parts.length <= 12 &&
      parts.every(
        (part) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) &&
          !["__proto__", "prototype", "constructor"].includes(part),
      )
    );
  }, "Use an explicit field path, such as subject.customerId; arrays and reserved paths are unavailable");
export const contextParameterSourceSchema = z.discriminatedUnion("source", [
  z
    .object({ source: z.literal("input"), path: contextLookupPathSchema })
    .strict(),
  z.object({ source: z.literal("case_id") }).strict(),
]);
export const CONTEXT_PROVIDERS = [
  "postgresql",
  "databricks",
  "fabric",
  "sqlserver",
  "openapi",
  "snowflake",
  "bigquery",
  "kafka",
  "object_store",
] as const;
export const contextProviderSchema = z.enum(CONTEXT_PROVIDERS);
export const contextEndpointSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["https:", "postgresql:", "tds:"].includes(url.protocol) &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !/%|\\|\.\./.test(url.pathname)
      );
    } catch {
      return false;
    }
  }, "Use an endpoint without credentials, query parameters or encoded paths");
export const contextConnectionSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(120),
    provider: contextProviderSchema,
    endpoint: contextEndpointSchema,
    credentialRef: z.string().regex(/^env:[A-Z][A-Z0-9_]{2,100}$/),
    identityMode: z.enum(["service", "delegated"]),
    /** SQL Server credentials remain a server-side reference, never inline values. */
    sqlServerAuth: z.enum(["sql_password", "entra_token"]).optional(),
    openapiPath: z
      .string()
      .regex(/^\/[A-Za-z0-9_./-]+$/)
      .max(500),
    resource: z
      .object({
        database: z.string().max(128),
        schema: field,
        object: field,
        warehouse: z.string().max(128),
        catalog: z.string().max(128),
        project: z.string().max(128),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    let protocol: string;
    try {
      protocol = new URL(value.endpoint).protocol;
    } catch {
      return;
    }
    const expected =
      value.provider === "postgresql"
        ? "postgresql:"
        : value.provider === "fabric" || value.provider === "sqlserver"
          ? "tds:"
          : "https:";
    if (protocol !== expected)
      ctx.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: `This provider requires ${expected}`,
      });
    if (
      ["postgresql", "fabric", "sqlserver"].includes(value.provider) &&
      !value.resource.database
    )
      ctx.addIssue({
        code: "custom",
        path: ["resource", "database"],
        message: "Database is required",
      });
    if (value.sqlServerAuth !== undefined && value.provider !== "sqlserver")
      ctx.addIssue({
        code: "custom",
        path: ["sqlServerAuth"],
        message: "Authentication mode applies only to SQL Server",
      });
    if (
      value.provider === "sqlserver" &&
      value.identityMode === "delegated" &&
      value.sqlServerAuth !== "entra_token"
    )
      ctx.addIssue({
        code: "custom",
        path: ["sqlServerAuth"],
        message:
          "Delegated SQL Server execution requires an Entra token exchange",
      });
  });
export const contextMappingSchema = z
  .object({
    source: field,
    target: field,
    required: z.boolean(),
    transform: z.enum([
      "identity",
      "trim",
      "lowercase",
      "uppercase",
      "json",
      "decimal",
      "timestamp",
    ]),
  })
  .strict();
export const contextCanonicalTypeSchema = z
  .object({
    name: z.string(),
    schemaVersion: z.string(),
    required: z.array(z.string()),
    fields: z.array(
      z
        .object({ name: z.string(), type: z.string(), required: z.boolean() })
        .strict(),
    ),
  })
  .strict();
export const contextBindingSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(120),
    productId: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/),
    connectionId: id,
    connectionRevision: revision,
    query: z.string().trim().max(16000),
    operationPath: z
      .string()
      .max(500)
      .regex(/^$|^\/[A-Za-z0-9_./{}-]*$/),
    responsePath: z.string().regex(/^$|^[A-Za-z_][A-Za-z0-9_]*$/),
    parameters: z
      .array(
        z
          .object({
            name: field,
            type: z.enum(["string", "number", "boolean"]),
            required: z.boolean(),
            /** Omitted means the workflow already supplies this named parameter. */
            valueFrom: contextParameterSourceSchema.optional(),
          })
          .strict(),
      )
      .max(32),
    objectType: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/),
    canonicalSchemaVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    keyField: field,
    observedAtField: field,
    /**
     * The source column holding the id of the case subject a row is about. A skill admits a record
     * only when it shares a subject with the invocation, so rows without a subject reach no skill.
     */
    subjectField: field.optional(),
    /** The purposes the records may be used for (`onboarding`, `review`, ...); none means no skill purpose. */
    purposes: z
      .array(z.string().regex(/^[a-z][a-z_]{1,31}$/))
      .max(16)
      .optional(),
    mapping: z.array(contextMappingSchema).min(1).max(100),
    datasetId: z.string().trim().min(1).max(200),
    maximumRows: z.number().int().min(1).max(200),
    timeoutMs: z.number().int().min(100).max(60000),
    maxAgeSeconds: z.number().int().min(1).max(31536000),
    refresh: z
      .object({
        intervalMinutes: z.number().int().min(1).max(525600),
        enabled: z.boolean(),
        planDigest: digest.nullable(),
        sourceContextDigest: digest.nullable(),
        input: z.object({ caseId: z.string().max(200).default("") }).strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [key, items] of [
      ["parameters", value.parameters.map((p) => p.name)],
      ["mapping", value.mapping.map((m) => m.target)],
    ] as const) {
      if (new Set(items).size !== items.length)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Names must be unique",
        });
    }
    if (
      value.parameters.some(
        (p) => p.valueFrom?.source === "case_id" && p.type !== "string",
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["parameters"],
        message: "The signed case ID requires a string parameter",
      });
    if (
      value.mapping.some((m) =>
        ["__proto__", "constructor", "prototype"].some(
          (name) => name === m.target || name === m.source,
        ),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["mapping"],
        message: "Reserved field name",
      });
    if (value.refresh.enabled && !value.refresh.planDigest)
      ctx.addIssue({
        code: "custom",
        path: ["refresh"],
        message: "Refresh requires a published process-flow plan",
      });
    if (
      value.refresh.enabled &&
      (!value.refresh.sourceContextDigest ||
        typeof value.refresh.input.caseId !== "string" ||
        !value.refresh.input.caseId)
    )
      ctx.addIssue({
        code: "custom",
        path: ["refresh"],
        message: "Refresh requires case identity and approved source context",
      });
  });
export const contextConnectionSaveSchema = z
  .object({
    definition: contextConnectionSchema,
    expectedRevision: revision.nullable(),
  })
  .strict();
export const contextBindingSaveSchema = z
  .object({
    definition: contextBindingSchema,
    expectedRevision: revision.nullable(),
  })
  .strict();
export const contextCheckRequestSchema = z
  .object({
    expectedRevision: revision,
    kind: z.enum(["discover", "preview", "qualify"]),
    parameters: z.record(
      z.string(),
      z.union([z.string().max(1000), z.number().finite(), z.boolean()]),
    ),
  })
  .strict();
export const contextActivationSchema = z
  .object({
    expectedRevision: revision,
    revision,
    action: z.enum(["activate", "disable"]),
    reason: z.string().trim().min(5).max(1000),
  })
  .strict();
export const contextRefreshSaveSchema = z
  .object({
    expectedRevision: revision,
    revision,
    configuration: contextBindingSchema.shape.refresh,
    reason: z.string().trim().min(5).max(1000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.configuration.enabled &&
      (!value.configuration.planDigest ||
        !value.configuration.sourceContextDigest ||
        typeof value.configuration.input.caseId !== "string" ||
        !value.configuration.input.caseId)
    )
      ctx.addIssue({
        code: "custom",
        path: ["configuration"],
        message:
          "A published plan, approved source context and case identity are required",
      });
  });
export const contextRefreshViewSchema = z
  .object({
    bindingId: id,
    revision,
    enabled: z.boolean(),
    dueAt: z.iso.datetime(),
    runId: z.string().nullable(),
    lastSuccessAt: z.iso.datetime().nullable(),
    lastError: z.string().nullable(),
    failures: z.number().int().nonnegative(),
  })
  .strict();
export const contextFieldSchema = z
  .object({ name: field, type: z.string().max(100), nullable: z.boolean() })
  .strict();
export const contextCheckSchema = z
  .object({
    id: z.string(),
    bindingId: id,
    revision,
    connectionDigest: digest,
    bindingDigest: digest,
    kind: z.enum(["discover", "preview", "qualify"]),
    status: z.enum(["passed", "failed"]),
    schemaFingerprint: digest.nullable(),
    fields: z.array(contextFieldSchema).max(500),
    rowCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    error: z.string().nullable(),
    checkedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    actor: z.string(),
  })
  .strict();
export type ContextConnection = z.infer<typeof contextConnectionSchema>;
export type ContextBinding = z.infer<typeof contextBindingSchema>;
export type ContextCheck = z.infer<typeof contextCheckSchema>;
export type ContextField = z.infer<typeof contextFieldSchema>;
export type ContextRevision<T> = {
  definition: T;
  revision: number;
  digest: string;
  actor: string;
  createdAt: string;
};
export type ContextBindingHead = ContextRevision<ContextBinding> & {
  activeRevision: number | null;
  disabled: boolean;
  connectorId: string;
};
export type ContextSourceIndex = {
  connections: ContextRevision<ContextConnection>[];
  bindings: ContextBindingHead[];
  checks: ContextCheck[];
  refreshes: z.infer<typeof contextRefreshViewSchema>[];
  canonicalTypes: z.infer<typeof contextCanonicalTypeSchema>[];
};

const revisionFields = {
  revision,
  digest,
  actor: z.string(),
  createdAt: z.iso.datetime(),
};
export const contextConnectionRevisionSchema = z
  .object({ definition: contextConnectionSchema, ...revisionFields })
  .strict();
export const contextBindingRevisionSchema = z
  .object({ definition: contextBindingSchema, ...revisionFields })
  .strict();
export const contextBindingHeadSchema = contextBindingRevisionSchema.extend({
  activeRevision: revision.nullable(),
  disabled: z.boolean(),
  connectorId: z.string(),
});
export const contextSourceIndexSchema = z
  .object({
    connections: z.array(contextConnectionRevisionSchema),
    bindings: z.array(contextBindingHeadSchema),
    checks: z.array(contextCheckSchema),
    refreshes: z.array(contextRefreshViewSchema),
    canonicalTypes: z.array(contextCanonicalTypeSchema),
  })
  .strict();
export const contextActivationResultSchema = z
  .object({ activeRevision: revision.nullable(), disabled: z.boolean() })
  .strict();
export const contextSourceApiSchemas = {
  ContextConnection: contextConnectionSchema,
  ContextBinding: contextBindingSchema,
  ContextConnectionRevision: contextConnectionRevisionSchema,
  ContextBindingRevision: contextBindingRevisionSchema,
  ContextBindingHead: contextBindingHeadSchema,
  ContextSourceIndex: contextSourceIndexSchema,
  ContextConnectionSave: contextConnectionSaveSchema,
  ContextBindingSave: contextBindingSaveSchema,
  ContextCheckRequest: contextCheckRequestSchema,
  ContextSourceCheck: contextCheckSchema,
  ContextSourceActivation: contextActivationSchema,
  ContextSourceActivationResult: contextActivationResultSchema,
  ContextRefreshSave: contextRefreshSaveSchema,
  ContextRefreshView: contextRefreshViewSchema,
};

/** Explicit handoff from setup proposals into the same revisioned registry. This creates
 * an editable draft; imported endpoint names never grant egress or source authorization. */
export function contextConnectionFromDeployment(
  input: DeploymentProfile["connections"][number],
): ContextConnection | null {
  if (!(CONTEXT_PROVIDERS as readonly string[]).includes(input.template))
    return null;
  const parts = input.resource.split(/[./]/).filter(Boolean);
  const url = new URL(input.endpoint);
  const database =
    decodeURIComponent(url.pathname.slice(1)) || parts.at(-3) || "";
  const provider = input.template as ContextConnection["provider"];
  if (provider === "fabric") {
    // Setup's older Fabric proposals used HTTPS; the native SQL endpoint is explicit here.
    const host = url.hostname;
    const port = url.port || "1433";
    url.href = `tds://${host}:${port}/${database}`;
  }
  return {
    id: input.id.slice(0, 64),
    name: input.name,
    provider,
    endpoint: url.toString().replace(/\/$/, ""),
    credentialRef: input.credentialRef.startsWith("env:")
      ? input.credentialRef
      : `env:CONTEXT_${input.id.replaceAll(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`,
    identityMode: input.identityMode,
    ...(provider === "sqlserver"
      ? {
          sqlServerAuth:
            input.identityMode === "delegated"
              ? ("entra_token" as const)
              : ("sql_password" as const),
        }
      : {}),
    openapiPath: "/openapi.json",
    resource: {
      database,
      schema: parts.at(-2) || (provider === "sqlserver" ? "dbo" : "public"),
      object: parts.at(-1) || "unconfigured",
      catalog: provider === "databricks" ? parts.at(-3) || "" : "",
      project: provider === "bigquery" ? parts.at(-3) || "" : "",
      warehouse: "",
    },
  };
}

export function contextSourceJsonSchemas() {
  return Object.fromEntries(
    Object.entries(contextSourceApiSchemas).map(([name, schema]) => {
      const { $schema: _, ...definition } = z.toJSONSchema(schema, {
        target: "draft-7",
        unrepresentable: "any",
      });
      return [name, definition];
    }),
  );
}

/** Resolve only declared values. Field paths read this invocation's selected input;
 * they never fetch additional case data or grant access. Case ID comes from the verified
 * execution envelope, never a caller-supplied caseId field. Legacy inputs stay strict. */
export function resolveContextSourceParameters(
  binding: Pick<ContextBinding, "parameters">,
  input: unknown,
  authority: { caseId?: string } = {},
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("context_source.parameter_invalid");
  if (!binding.parameters.some((p) => p.valueFrom))
    return input as Record<string, unknown>;
  const values: Record<string, unknown> = Object.create(null);
  for (const parameter of binding.parameters) {
    let value: unknown;
    const source = parameter.valueFrom;
    if (source?.source === "case_id") {
      value = authority.caseId;
      if (!value) throw new Error("context_source.case_authority_required");
    } else if (source?.source === "input") {
      if (!contextLookupPathSchema.safeParse(source.path).success)
        throw new Error("context_source.lookup_path_invalid");
      value = input;
      for (const segment of source.path.split(".")) {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          !Object.hasOwn(value, segment)
        ) {
          value = undefined;
          break;
        }
        value = (value as Record<string, unknown>)[segment];
      }
    } else
      value = Object.hasOwn(input, parameter.name)
        ? (input as Record<string, unknown>)[parameter.name]
        : undefined;
    if (value === undefined && !parameter.required) continue;
    if (value === undefined || value === null)
      throw new Error("context_source.lookup_value_missing");
    if (
      typeof value !== parameter.type ||
      (typeof value === "string" && (!value.trim() || value.length > 1000)) ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error("context_source.lookup_value_invalid");
    values[parameter.name] = value;
  }
  return values;
}
