import type { CanonicalMapping, MappingExpression } from "@ehf/contracts";
export const CONTEXT_MAPPING_TEMPLATES = [
  "customer",
  "identity",
  "source-evidence",
  "transaction",
  "risk",
  "application",
  "holding",
] as const;
export function createContextMappingTemplate(
  kind: (typeof CONTEXT_MAPPING_TEMPLATES)[number],
  base: Omit<CanonicalMapping, "subject" | "outputs">,
  namespace: string,
  subjectColumn: string,
  sourceColumns: string[] = [],
): CanonicalMapping {
  const field = (path: string): MappingExpression => ({ op: "field", path });
  const id = (type: string, path: string): MappingExpression => ({
    op: "id",
    namespace: `${namespace}.${type.toLowerCase()}`,
    value: field(path),
  });
  const literal = (value: unknown): MappingExpression => ({
    op: "literal",
    value,
  });
  const common = { ...base, subject: field("canonical_subject_id") };
  if (kind === "identity")
    return {
      ...base,
      subject: id("entity", subjectColumn),
      outputs: [
        {
          objectType: "Entity",
          identity: id("entity", subjectColumn),
          fields: {
            name: { op: "trim", value: field("name") },
            identifiers: { op: "array", items: [field(subjectColumn)] },
            entity_type: field("kind"),
          },
        },
      ],
    };
  if (kind === "source-evidence")
    return {
      ...base,
      subject: id("entity", subjectColumn),
      outputs: [
        {
          objectType: "SourceRecord",
          identity: id("source", subjectColumn),
          fields: {
            source: literal(namespace),
            content: {
              op: "json",
              value: {
                op: "object",
                fields: Object.fromEntries(
                  sourceColumns.map((c) => [c, field(c)]),
                ),
              },
            },
            coverage: literal({
              complete: false,
              limitations: [
                "Selected source observation; does not establish a complete assessment or workflow history.",
              ],
            }),
          },
        },
      ],
    };
  if (kind === "customer")
    return {
      ...base,
      subject: id("entity", subjectColumn),
      outputs: [
        {
          objectType: "Entity",
          identity: id("entity", subjectColumn),
          fields: {
            name: { op: "trim", value: field("legal_name") },
            identifiers: field("identifiers"),
            entity_type: field("kind"),
          },
        },
        {
          objectType: "Party",
          identity: id("party", subjectColumn),
          fields: {
            entity_id: id("entity", subjectColumn),
            role: field("role"),
            customer_type: field("customer_type"),
            profile: field("profile"),
          },
        },
      ],
    };
  if (kind === "transaction")
    return {
      ...common,
      outputs: [
        {
          objectType: "Transaction",
          identity: id("transaction", "event_id"),
          fields: {
            source: field("canonical_source_entity_id"),
            target: field("canonical_target_entity_id"),
            event_id: field("event_id"),
            amount: { op: "decimal", value: field("amount") },
            currency: { op: "upper", value: field("currency") },
            timestamp: { op: "instant", value: field("transaction_time") },
            status: {
              op: "lookup",
              value: field("status"),
              values: {
                SETTLED: "settled",
                PENDING: "pending",
                REVERSED: "reversed",
                CANCELLED: "cancelled",
              },
            },
          },
        },
      ],
    };
  if (kind === "risk")
    return {
      ...common,
      outputs: [
        {
          objectType: "RiskAssessment",
          identity: id("risk", "assessment_id"),
          fields: {
            tier: field("tier"),
            score: { op: "decimal", value: field("score") },
            contributions: field("contributions"),
            model_version: field("model_version"),
          },
        },
      ],
    };
  if (kind === "application")
    return {
      ...common,
      outputs: [
        {
          objectType: "Application",
          identity: id("application", "application_id"),
          fields: {
            contract_version: literal("1.0.0"),
            source_application_id: field("application_id"),
            applicants: field("applicants"),
            requested_products: field("requested_products"),
            channel: field("channel"),
            status: field("status"),
            submitted_at: field("submitted_at"),
            effective_from: { op: "instant", value: field("effective_from") },
            effective_to: field("effective_to"),
            evidence_refs: field("evidence_refs"),
            historical_decisions: field("historical_decisions"),
          },
        },
      ],
    };
  return {
    ...common,
    outputs: [
      {
        objectType: "ProductHolding",
        identity: id("holding", "holding_id"),
        fields: {
          contract_version: literal("1.0.0"),
          party_ref: field("party_ref"),
          product_ref: field("product_ref"),
          account_ref: field("account_ref"),
          role: field("holding_role"),
          status: field("status"),
          effective_from: { op: "instant", value: field("effective_from") },
          effective_to: field("effective_to"),
          evidence_refs: field("evidence_refs"),
        },
      },
    ],
  };
}
