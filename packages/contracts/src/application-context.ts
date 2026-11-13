import { z } from "zod";

const id = z.string().trim().min(1).max(512);
const instant = z.iso.datetime({ offset: true });
const ref = (type: string) =>
  z
    .object({
      tenant_id: id,
      object_type: z.literal(type),
      object_id: id,
      version_id: id,
    })
    .strict();
const interval = { effective_from: instant, effective_to: instant.nullable() };
/** Platform contracts are independently versioned. Library skills must opt in explicitly. */
export const applicationContextSchema = z
  .object({
    contract_version: z.literal("1.0.0"),
    source_application_id: id,
    applicants: z
      .array(
        z
          .object({
            party_ref: ref("Party"),
            role: z.enum([
              "PRIMARY",
              "JOINT",
              "GUARANTOR",
              "AUTHORIZED_REPRESENTATIVE",
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    requested_products: z.array(ref("Product")).min(1).max(32),
    channel: id,
    status: z.enum([
      "DRAFT",
      "SUBMITTED",
      "UNDER_REVIEW",
      "APPROVED",
      "DECLINED",
      "WITHDRAWN",
      "EXPIRED",
      "FULFILLED",
    ]),
    submitted_at: instant.nullable(),
    ...interval,
    previous_application_ref: ref("Application").optional(),
    evidence_refs: z.array(ref("Evidence")).max(100),
    // These are attributed source observations, never platform approvals or authority to act.
    historical_decisions: z
      .array(
        z
          .object({
            source_decision_id: id,
            decision: z.enum(["APPROVED", "DECLINED", "REFERRED", "WITHDRAWN"]),
            actor_ref: id,
            decided_at: instant,
            source_ref: ref("SourceRecord"),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const productHoldingContextSchema = z
  .object({
    contract_version: z.literal("1.0.0"),
    party_ref: ref("Party"),
    product_ref: ref("Product"),
    account_ref: ref("Account"),
    role: z.enum([
      "SOLE_HOLDER",
      "JOINT_HOLDER",
      "BENEFICIARY",
      "AUTHORIZED_USER",
    ]),
    status: z.enum(["ACTIVE", "SUSPENDED", "CLOSED"]),
    ...interval,
    evidence_refs: z.array(ref("Evidence")).min(1).max(100),
  })
  .strict();
export const applicationAccountLinkContextSchema = z
  .object({
    contract_version: z.literal("1.0.0"),
    application_ref: ref("Application"),
    account_ref: ref("Account"),
    relation: z.enum(["ORIGINATED", "REFINANCED", "CONVERTED"]),
    linked_at: instant,
    evidence_refs: z.array(ref("Evidence")).min(1).max(100),
  })
  .strict();
export const APPLICATION_CONTEXT_CONTRACTS = {
  Application: applicationContextSchema,
  ProductHolding: productHoldingContextSchema,
  ApplicationAccountLink: applicationAccountLinkContextSchema,
} as const;
export const APPLICATION_CONTEXT_SCHEMAS = Object.fromEntries(
  Object.entries(APPLICATION_CONTEXT_CONTRACTS).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema),
  ]),
);

export function validateApplicationContext(
  type: string,
  data: unknown,
): string[] {
  const schema =
    APPLICATION_CONTEXT_CONTRACTS[
      type as keyof typeof APPLICATION_CONTEXT_CONTRACTS
    ];
  if (!schema) return [];
  const result = schema.safeParse(data);
  if (!result.success)
    return result.error.issues.map((i) => `${i.path.join(".")} ${i.code}`);
  const d = result.data;
  const errors: string[] = [];
  if (
    "effective_to" in d &&
    d.effective_to &&
    Date.parse(d.effective_to) <= Date.parse(d.effective_from)
  )
    errors.push("effective_to must follow effective_from");
  if ("applicants" in d) {
    const keys = d.applicants.map(
      (a) => `${a.party_ref.tenant_id}:${a.party_ref.object_id}:${a.role}`,
    );
    if (new Set(keys).size !== keys.length)
      errors.push("applicants contains duplicate party/role");
    if (d.applicants.filter((a) => a.role === "PRIMARY").length !== 1)
      errors.push("applicants requires exactly one primary applicant");
    if (d.status !== "DRAFT" && !d.submitted_at)
      errors.push("submitted_at required after draft");
  }
  return errors;
}

/** Exact versioned references declared by these three contracts. */
export function applicationContextReferences(
  type: string,
  data: unknown,
): Array<{
  tenant_id: string;
  object_type: string;
  object_id: string;
  version_id: string;
}> {
  if (!Object.hasOwn(APPLICATION_CONTEXT_CONTRACTS, type)) return [];
  const refs: Array<{
    tenant_id: string;
    object_type: string;
    object_id: string;
    version_id: string;
  }> = [];
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const r = v as Record<string, unknown>;
    if (
      typeof r.tenant_id === "string" &&
      typeof r.object_type === "string" &&
      typeof r.object_id === "string" &&
      typeof r.version_id === "string"
    )
      refs.push(r as (typeof refs)[number]);
    else for (const child of Object.values(r)) visit(child);
  };
  visit(data);
  return refs;
}
