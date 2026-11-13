/**
 * Policy packs (agentic KYC/KYB plan phase 2, docs/implementation/policy-packs.md).
 *
 * A pack layer sets policy values for one scope: `baseline` (jurisdiction-neutral control
 * semantics), `jurisdiction` (a regulator's requirements), `institution` (one bank's risk
 * appetite), `business_line` (one of its business lines) or `product` (controls for a node of the
 * product taxonomy, from a whole domain down to one product). Layers compose in that order into one
 * **effective pack** per selection entry (jurisdiction, institution, product), and each layer may
 * only **tighten** what the layers below it set: every field has a declared tightening rule, and
 * a layer that would loosen a field refuses the composition. The effective pack is content
 * addressed; plans pin effective packs by digest, and a case is pinned to exactly one of them.
 *
 * Three consumers read an effective pack:
 * - skills, through the projection of its values to their `policy_context_fields`;
 * - pack checkpoints (`evaluatePackGate`), deterministic checks over canonical case records;
 * - the existing OPA decision-table bundles a jurisdiction pack references (`gateBundles`).
 */
import { createHash } from "node:crypto";
import {
  PARTY_PRODUCT_ROLES, productCovered, resolveRelationshipProducts,
  type InstitutionCatalog, type PartyProductRelationship, type ProductResolution,
} from "@ehf/contracts/products";

import {
  canonical, composePolicyLayers, FIELD_NAMES, normalized, POLICY_PACK_FIELDS, PolicyPackError,
  type EffectivePolicyPack, type PolicyPackField, type PolicyPackLayer, type PolicyPackSelection, type ProductLineage,
} from "./pack-composition.js";

export * from "./pack-composition.js";

export const packDigest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/**
 * Compose the effective pack for one selection entry (`composePolicyLayers` over its products).
 * Pass `lineage` to let product layers target taxonomy nodes above the legacy product ids a
 * selection names (`productLineageOf` with the taxonomy's legacy mapping).
 */
export function composeEffectivePack(layers: PolicyPackLayer[], entry: PolicyPackSelection["packs"][number], options: { lineage?: ProductLineage } = {}): EffectivePolicyPack {
  const scope = { jurisdiction: entry.jurisdiction, institution: entry.institution, ...(entry.businessLine ? { businessLine: entry.businessLine } : {}) };
  const where = `${entry.jurisdiction}/${entry.institution}/${entry.productSet}`;
  const { chosen, values, basis } = composePolicyLayers(layers, scope, entry.products, { ...options, where });
  const gateBundles: EffectivePolicyPack["gateBundles"] = {};
  const knownDifferences: EffectivePolicyPack["knownDifferences"] = [];
  // Gate bundle references and stated differences, from every layer in the pack.
  for (const layer of chosen) {
    for (const [gate, bundle] of Object.entries(layer.gateBundles)) {
      if (gateBundles[gate] && canonical(gateBundles[gate]) !== canonical(bundle)) throw new PolicyPackError(`policy_pack.gate_bundle_conflict:${gate}`);
      gateBundles[gate] = bundle;
    }
    for (const difference of layer.knownDifferences) knownDifferences.push({ layer: layer.metadata.id, ...difference });
  }
  if (values.jurisdiction !== entry.jurisdiction) throw new PolicyPackError(`policy_pack.jurisdiction_mismatch:${entry.jurisdiction}`);
  const content = {
    apiVersion: "harness.factory/policy-pack-v1" as const,
    kind: "EffectivePolicyPack" as const,
    id: `policy.pack.${entry.jurisdiction.toLowerCase()}.${entry.institution.replaceAll(".", "-")}.${entry.productSet}`,
    version: chosen.map((layer) => layer.metadata.version).join("+"),
    status: chosen.every((layer) => layer.metadata.status === "APPROVED") ? "APPROVED" as const : "CANDIDATE" as const,
    scope: { jurisdiction: entry.jurisdiction, institution: entry.institution, ...(entry.businessLine ? { businessLine: entry.businessLine } : {}),
      productSet: entry.productSet, products: [...new Set(entry.products)].sort(), customerTypes: [...entry.customerTypes].sort() },
    layers: chosen.map((layer) => ({ id: layer.metadata.id, version: layer.metadata.version, layer: layer.metadata.layer, digest: packDigest(layer) })),
    values: Object.fromEntries(FIELD_NAMES.filter((field) => field in values).map((field) => [field, normalized(field, values[field])])),
    basis: Object.fromEntries(FIELD_NAMES.filter((field) => field in basis).map((field) => [field, basis[field]])),
    gateBundles,
    knownDifferences,
  };
  return { ...content, digest: packDigest(content) };
}

// ---------------------------------------------------------------------------------------------
// Selection per case

export type CasePolicyContext = {
  jurisdiction: string | null | undefined;
  institution: string | null | undefined;
  products: string[] | null | undefined;
  customerType: string | null | undefined;
  /** The customer entity's canonical legal form, which the diligence matrix maps to a party type. */
  legalForm?: string | null | undefined;
  /** How each product resolved (phase G), and the customer's own products that did not. */
  productResolutions?: ProductResolution[];
  unresolvedProducts?: string[];
  /** Products the customer holds in another role, resolved, for the role requirements they bring. */
  relatedProducts?: Array<{ product: string; role: string }>;
  /** A trust (a legal form such as `trust`, `ordinary_trust`, `discretionary_trust`): a legal arrangement served by the corporate packs, with its own parties. */
  legalArrangement?: "trust" | null;
};

/**
 * The selection facts from a case's canonical BankingRelationship record: the policy jurisdiction,
 * the institution, the products, and the customer type from the customer entity's legal form.
 * Booking jurisdiction is not policy jurisdiction, and a missing fact stays missing. Products go
 * through the product resolver: a legacy type as today, else a canonical product, else an offering
 * through the institution's published catalog (`resolve`); only the customer's own products count.
 */
export function casePolicyContextFromRelationship(data: Record<string, unknown> | null | undefined,
  resolve: { catalog: Pick<InstitutionCatalog, "offerings"> | null; legacy: Readonly<Record<string, string>> } = { catalog: null, legacy: {} }): CasePolicyContext {
  const relationship = data ?? {};
  const customerId = relationship.customerEntityId;
  const entities = Array.isArray(relationship.entities) ? relationship.entities as Array<Record<string, unknown>> : [];
  const customer = entities.find((entity) => entity.entityId === customerId);
  const form = typeof customer?.legalForm === "string" ? customer.legalForm : null;
  const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
  const products = Array.isArray(relationship.products)
    ? (relationship.products as Array<Record<string, unknown>>).map((product, index) => ({
      productId: text(product.productId) ?? `product-${index + 1}`, productType: text(product.type) ?? text(product.productType),
      canonicalProductId: text(product.canonicalProductId), offeringId: text(product.offeringId),
    }))
    : [];
  const roles = Array.isArray(relationship.productRoles) ? (relationship.productRoles as Array<Record<string, unknown>>).flatMap((entry) =>
    typeof entry.entityId === "string" && typeof entry.productId === "string" && (PARTY_PRODUCT_ROLES as readonly string[]).includes(String(entry.role))
      ? [{ entityId: entry.entityId, productId: entry.productId, role: entry.role as PartyProductRelationship["role"] }] : []) : [];
  const resolved = resolveRelationshipProducts({ products, customerEntityId: typeof customerId === "string" ? customerId : "", productRoles: roles }, resolve.catalog, { legacy: resolve.legacy });
  const related = resolved.resolutions.flatMap((entry) => entry.role !== "CUSTOMER" && entry.policyProduct ? [{ product: entry.policyProduct, role: entry.role }] : [])
    .filter((entry, index, all) => all.findIndex((other) => other.product === entry.product && other.role === entry.role) === index)
    .sort((a, b) => a.role.localeCompare(b.role) || a.product.localeCompare(b.product));
  return {
    jurisdiction: typeof relationship.policyJurisdiction === "string" ? relationship.policyJurisdiction : null,
    institution: typeof relationship.institutionId === "string" ? relationship.institutionId : null,
    products: resolved.policyProducts.length ? resolved.policyProducts : null,
    customerType: form === null ? null : form === "individual" ? "individual" : "corporate",
    legalForm: form,
    ...(products.some((product) => !product.productType) || roles.length ? {
      productResolutions: resolved.resolutions,
      // A related product that does not resolve stops the gate as an own product would.
      unresolvedProducts: [...resolved.unresolved, ...resolved.resolutions.filter((entry) => entry.role !== "CUSTOMER" && entry.policyProduct === null).map((entry) => entry.productId)],
    } : {}),
    ...(related.length ? { relatedProducts: related } : {}),
    legalArrangement: form !== null && /(^|_)trust$/.test(form) ? "trust" : null,
  };
}

export type PackSelection =
  | { status: "selected"; pack: EffectivePolicyPack }
  | { status: "none" | "ambiguous" | "context_incomplete"; reason: string; candidates: string[] };

/**
 * The one effective pack a case falls under, among the packs a plan pinned. Every context fact is
 * required: a missing fact never defaults to a pack. No match, or more than one, is a reason to
 * stop for a person, not to pick one.
 */
export function selectPolicyPack(pinned: EffectivePolicyPack[], context: CasePolicyContext, legacy: Readonly<Record<string, string>> = {}): PackSelection {
  const missing = (["jurisdiction", "institution", "products", "customerType"] as const).filter((key) => !context[key] || (key === "products" && !context.products!.length));
  if (missing.length) return { status: "context_incomplete", reason: `missing ${missing.join(", ")}`, candidates: [] };
  // A pack covers the case only when every product of the relationship is in its product set.
  const matches = pinned.filter((pack) => pack.scope.jurisdiction === context.jurisdiction && pack.scope.institution === context.institution
    && context.products!.every((product) => productCovered(product, pack.scope.products, legacy)) && (pack.scope.customerTypes as string[]).includes(context.customerType!));
  if (matches.length === 1) return { status: "selected", pack: matches[0]! };
  return matches.length === 0
    ? { status: "none", reason: `no pinned pack for ${context.jurisdiction}/${context.institution}/${context.products!.join("+")}/${context.customerType}`, candidates: [] }
    : { status: "ambiguous", reason: "more than one pinned pack applies", candidates: matches.map((pack) => pack.id) };
}

// ---------------------------------------------------------------------------------------------
// Skill projection

/**
 * A skill's `policy` section from an effective pack, in the shape of a skill node's
 * `config.skillPolicy` (context-plane `skillPolicyConfigSchema`). Fields the pack does not set are
 * listed as `unresolved`, never defaulted; `permissions` and `version` are the plan's to supply.
 */
export function projectPackForSkill(pack: EffectivePolicyPack, fields: string[], extra: { permissions?: string[] } = {}) {
  const wanted = [...new Set(fields)].sort();
  const values: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  for (const field of wanted) {
    if (field === "permissions" && extra.permissions) { values.permissions = extra.permissions; sources.permissions = "plan skill bindings (scoped to this execution)"; continue; }
    if (field === "version") { values.version = pack.version; sources.version = `${pack.id} version`; continue; }
    const spec = POLICY_PACK_FIELDS[field as PolicyPackField];
    if (spec?.projected && field in pack.values) {
      values[field] = pack.values[field as PolicyPackField];
      const basis = pack.basis[field as PolicyPackField];
      sources[field] = basis ? `${basis.layer}: ${basis.text}` : pack.id;
    }
  }
  return {
    policyRef: pack.id, policyVersion: pack.version, bundleDigest: pack.digest,
    fields: wanted, values, sources, unresolved: wanted.filter((field) => !(field in values)),
  };
}

// ---------------------------------------------------------------------------------------------
// Pack checkpoints

export type PackGateId = "intake-ready" | "decision-ready" | "disposition";
export type PackGateOutcome = "ALLOW" | "REVIEW" | "BLOCK" | "UNKNOWN";
export type PackGateResult = { gateId: PackGateId; outcome: PackGateOutcome; reasonCodes: string[]; packId: string; packDigest: string; details: Record<string, unknown> };

/** A canonical record as a checkpoint reads it (records are already grouped by type). */
export type PackGateRecord = { object_type?: string; object_id?: string; id?: string; data: Record<string, unknown>; observed_at?: string };
type Record_ = PackGateRecord;

export type PackGateInput = {
  /** The case's policy pin: it must name this pack, by id and digest. */
  authority: { policyId?: string | null; policyBundleDigest?: string | null } | null | undefined;
  customerType: "individual" | "corporate" | null | undefined;
  /** A trust customer: its required parties are the pack's `trust` roles, and it has no shareholding to resolve. */
  legalArrangement?: "trust" | null;
  /** Canonical records by object type, as the case snapshot carries them. */
  records: Record<string, Record_[]>;
  /** The case's as-of time (snapshot capture), for freshness. */
  asOf: string;
  /** Case-level facts other checkpoints and agents produced (e.g. task outcomes). */
  facts?: { eddRequired?: boolean | null; eddScoped?: boolean | null; openTaskOutcomes?: string[];
    /** The screening types the case's diligence decision requires (`outputs.diligence.screeningTypes`); added to the pack's. */
    screeningTypes?: string[] };
};

const recordId = (record: Record_) => record.object_id ?? record.id ?? "";
const bare = (digest: string | null | undefined) => (digest ?? "").replace(/^sha256:/, "");

/**
 * A deterministic checkpoint over canonical case records against an effective pack (the same
 * pattern as the banking-product readiness checkpoint). Outcomes:
 * - `UNKNOWN` when the case is not pinned to this pack or the inputs to decide are absent;
 * - `REVIEW` with reason codes when a requirement is not met;
 * - `ALLOW` when every requirement of the gate holds;
 * - `disposition` never allows an automatic decision: it is `REVIEW` (a person decides), unless
 *   an earlier requirement is unknown.
 * Absence is never read as satisfaction.
 */
export function evaluatePackGate(pack: EffectivePolicyPack, gateId: PackGateId, input: PackGateInput): PackGateResult {
  const result = (outcome: PackGateOutcome, reasonCodes: string[], details: Record<string, unknown> = {}): PackGateResult =>
    ({ gateId, outcome, reasonCodes, packId: pack.id, packDigest: pack.digest, details });
  if (input.authority?.policyId !== pack.id || bare(input.authority?.policyBundleDigest) !== pack.digest) {
    return result("UNKNOWN", ["POLICY_PACK_NOT_PINNED"]);
  }
  if (!input.customerType || !(pack.scope.customerTypes as string[]).includes(input.customerType)) return result("UNKNOWN", ["CUSTOMER_TYPE_OUT_OF_SCOPE"]);
  const reasons: string[] = [];
  const relationships = input.records.BankingRelationship ?? [];
  const parties = relationships.length === 1 ? ((relationships[0]!.data.parties as Array<{ entityId?: string; entity_id?: string; role?: string; roles?: string[] }> | undefined) ?? []) : [];
  const roleOf = (party: (typeof parties)[number]) => party.roles ?? (party.role ? [party.role] : []);
  const partyEntity = (party: (typeof parties)[number]) => party.entityId ?? party.entity_id ?? "";

  // intake-ready: one relationship, required roles present.
  if (relationships.length !== 1) reasons.push("RELATIONSHIP_UNRESOLVED");
  const roleTable = (pack.values.required_party_roles as Record<string, string[]> | undefined) ?? {};
  const requiredRoles = (input.legalArrangement === "trust" ? roleTable.trust : undefined) ?? roleTable[input.customerType] ?? [];
  const missingRoles = requiredRoles.filter((role) => !parties.some((party) => roleOf(party).includes(role)));
  if (relationships.length === 1 && missingRoles.length) reasons.push(...missingRoles.map((role) => `PARTY_ROLE_MISSING:${role}`));
  if (gateId === "intake-ready") return reasons.length ? result("REVIEW", reasons, { missingRoles }) : result("ALLOW", []);

  // decision-ready: every party in a screening role screened for every required type, against the
  // required lists, and every verification current.
  const screeningRoles = (pack.values.screening_roles as string[] | undefined) ?? [];
  const subjects = [...new Set(parties.filter((party) => roleOf(party).some((role) => screeningRoles.includes(role))).map(partyEntity).filter(Boolean))].sort();
  if (relationships.length === 1 && subjects.length === 0) reasons.push("NO_SCREENING_SUBJECTS");
  const executions = input.records.ScreeningExecution ?? [];
  const types = [...new Set([...((pack.values.required_screening_types as string[] | undefined) ?? []), ...(input.facts?.screeningTypes ?? [])])].sort();
  const lists = (pack.values.required_screening_lists as string[] | undefined) ?? [];
  const gaps: string[] = [];
  for (const subject of subjects) {
    for (const type of types) {
      const done = executions.filter((execution) => execution.data.subject === subject && execution.data.screening_type === type && execution.data.status === "COMPLETED" && execution.data.truncated !== true);
      if (!done.length) { gaps.push(`${type}:${subject}`); continue; }
      if (type === "sanctions" && lists.length) {
        const covered = new Set(done.flatMap((execution) => [...((execution.data.scope as string[] | undefined) ?? []), ...((execution.data.dataset_versions as string[] | undefined) ?? []).map((version) => version.split("@")[0]!)]));
        for (const list of lists) if (!covered.has(list)) gaps.push(`list:${list}:${subject}`);
      }
    }
  }
  if (gaps.length) reasons.push("SCREENING_INCOMPLETE");
  const freshness = (pack.values.freshness_seconds as Record<string, number> | undefined) ?? {};
  const asOf = Date.parse(input.asOf);
  const stale: string[] = [];
  for (const [type, seconds] of Object.entries(freshness)) {
    for (const record of input.records[type] ?? []) {
      const observed = Date.parse(String(record.observed_at ?? ""));
      if (!Number.isFinite(observed) || asOf - observed > seconds * 1000) stale.push(`${type}:${recordId(record)}`);
    }
  }
  if (stale.length) reasons.push("EVIDENCE_STALE");
  // A trust's beneficial owners are its parties (settlor, trustees, protector, beneficiaries), which
  // the required roles above name; it has no shareholding to resolve.
  if (input.customerType === "corporate" && input.legalArrangement !== "trust" && !(input.records.OwnershipInterest ?? []).length && !(input.records.BeneficialOwner ?? []).length) reasons.push("OWNERSHIP_UNRESOLVED");
  if (input.facts?.eddRequired === true && input.facts.eddScoped !== true) reasons.push("EDD_NOT_SCOPED");
  for (const outcome of input.facts?.openTaskOutcomes ?? []) if (outcome !== "COMPLETED") reasons.push(`TASK_${outcome}`);
  const details = { subjects, screeningTypes: types, screeningGaps: gaps, staleRecords: stale };
  if (gateId === "decision-ready") return reasons.length ? result("REVIEW", [...new Set(reasons)], details) : result("ALLOW", [], details);

  // disposition: never automatic. A person decides, with dual control where the pack requires it.
  const humanDecision = { dualControlRequired: pack.values.dual_control_required === true, automaticApproval: false, automaticDecline: false };
  return result("REVIEW", [...new Set(["HUMAN_DECISION_REQUIRED", ...reasons])], { ...details, ...humanDecision });
}
