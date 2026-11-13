import { Validator } from "@cfworker/json-schema";
import effectCommandSchema from "./vendor/effect-command.schema.json" with { type: "json" };
import lockFile from "./vendor/lock.json" with { type: "json" };
import ontologySchema from "./vendor/ontology.schema.json" with { type: "json" };
import relationships from "./vendor/context-relationships.json" with { type: "json" };
import { PROVIDER_SCHEMAS } from "./providers.js";
import { APPLICATION_CONTEXT_SCHEMAS, validateApplicationContext, bankingRelationshipJsonSchema, controlAssessmentJsonSchema } from "@ehf/contracts";

/**
 * The financial-crime skill library's executable contracts, vendored byte for byte by
 * `scripts/sync-library-contracts.mjs` (see docs/implementation/library-contracts.md):
 *
 * - the closed canonical context ontology (89 record types, context schema 2.0.0),
 * - the closed effect-command variants a skill may return (mapped in `./effects.ts`),
 * - the request/response schemas of the twelve provider capabilities (nine canonical, three for the EHF document wrappers) (`./providers.ts`).
 *
 * The platform validates canonical record `data` against these before it is committed, so a
 * record a library skill cannot ingest never reaches the case store.
 */

type JsonSchema = Record<string, unknown>;
type Json = Record<string, unknown>;

export type LibraryContractsLock = {
  library: string;
  version: string;
  context_schema_version: string;
  catalog_source_hash: string;
  bundle_code_hash: string;
  synthetic: boolean;
  files: Record<string, { source: string; sha256: string }>;
};

export const LIBRARY_CONTRACTS_LOCK = lockFile as LibraryContractsLock;
/** The context schema version canonical records are written in (`Record.schema_version`). */
export const LIBRARY_CONTEXT_SCHEMA_VERSION = LIBRARY_CONTRACTS_LOCK.context_schema_version;

const ontology = ontologySchema as unknown as { $id: string; $defs: Record<string, JsonSchema>; "x-context-types": string[] };
/** The 89 canonical context types the library ingests. */
export const LIBRARY_CONTEXT_TYPES: readonly string[] = Object.freeze([...ontology["x-context-types"]]);

/**
 * Record types the platform produces that are **not** library context types. The library never
 * ingests them; they are validated against the platform's own closed schema (built from the
 * ontology's shared definitions) and never sent to a skill as a library record.
 */
export const PLATFORM_RECORD_SCHEMAS: Readonly<Record<string, JsonSchema>> = Object.freeze({
  ...APPLICATION_CONTEXT_SCHEMAS,
  BankingRelationship: bankingRelationshipJsonSchema,
  ControlAssessment: controlAssessmentJsonSchema,
  /**
   * A completed provider search that returned no candidate. A provider search is not a list
   * capture, so this is never a `WatchlistEntry` and never "clear": the library's screening
   * skills consume the accompanying ScreeningExecution instead. Kept as platform
   * evidence of the negative search scope.
   */
  NegativeSearchEvidence: {
    type: "object",
    additionalProperties: false,
    required: ["capability", "provider", "subject", "dataset_versions", "scope", "truncated", "total_candidates", "coverage", "query_time", "limitations"],
    properties: {
      capability: { $ref: "#/$defs/Id" },
      provider: { $ref: "#/$defs/Id" },
      subject: { anyOf: [{ $ref: "#/$defs/Id" }, { type: "null" }] },
      dataset_versions: { type: "array", items: { $ref: "#/$defs/Id" } },
      scope: { type: "array", items: { $ref: "#/$defs/Id" } },
      truncated: { $ref: "#/$defs/Bool" },
      total_candidates: { $ref: "#/$defs/Count" },
      coverage: { $ref: "#/$defs/Coverage" },
      query_time: { $ref: "#/$defs/Timestamp" },
      limitations: { type: "array", items: { $ref: "#/$defs/Text" } },
      extensions: { $ref: "#/$defs/Extensions" },
    },
  },
});

export type RecordContract = "library" | "platform" | "unknown";
export type RecordDataValidation = { valid: boolean; contract: RecordContract; errors: string[] };

const validators = new Map<string, Validator>();

// cfworker reports every enclosing schema that failed ($ref, properties, …) as well as the
// keyword that actually failed; keep the latter.
const COMPOSITE_KEYWORDS = new Set(["$ref", "properties", "allOf", "anyOf", "oneOf", "items", "if", "then"]);
function leafErrors(errors: Array<{ keyword: string; instanceLocation: string; error: string }>): string[] {
  const leaves = errors.filter((error) => !COMPOSITE_KEYWORDS.has(error.keyword));
  return [...new Set((leaves.length ? leaves : errors).map((error) => `${error.instanceLocation} ${error.error}`))];
}

function validatorFor(objectType: string): { validator: Validator; contract: RecordContract } | null {
  const contract: RecordContract | null = LIBRARY_CONTEXT_TYPES.includes(objectType) ? "library"
    : Object.hasOwn(PLATFORM_RECORD_SCHEMAS, objectType) ? "platform" : null;
  if (!contract) return null;
  let validator = validators.get(objectType);
  if (!validator) {
    const root = contract === "library" ? { $ref: `#/$defs/${objectType}` } : PLATFORM_RECORD_SCHEMAS[objectType]!;
    validator = new Validator({ $id: `${ontology.$id}#data/${objectType}`, $defs: ontology.$defs, ...root } as never, "2020-12", false);
    validators.set(objectType, validator);
  }
  return { validator, contract };
}

/**
 * The fields the library's contract requires on every record of a library context type. The
 * library validates each record it is handed against that type's closed schema, so a record
 * trimmed below these fields is rejected before any skill reads it. Empty for a platform-only or
 * unknown type: the library never ingests those.
 */
export function requiredRecordFields(objectType: string): readonly string[] {
  if (!LIBRARY_CONTEXT_TYPES.includes(objectType)) return [];
  const required = (ontology.$defs[objectType] as { required?: unknown } | undefined)?.required;
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === "string") : [];
}

/**
 * Validate a canonical record's `data` against its object type's closed contract: the library
 * ontology for library context types, `PLATFORM_RECORD_SCHEMAS` for platform-only types. An
 * object type in neither is invalid (`contract: "unknown"`): it would be silently ignored.
 */
export function validateRecordData(objectType: string, data: unknown): RecordDataValidation {
  const entry = validatorFor(objectType);
  if (!entry) return { valid: false, contract: "unknown", errors: [`${objectType} is neither a library context type (${LIBRARY_CONTEXT_SCHEMA_VERSION}) nor a platform record type.`] };
  const result = entry.validator.validate(data);
  if (result.valid) {
    const errors = validateApplicationContext(objectType, data);
    return { valid: errors.length === 0, contract: entry.contract, errors };
  }
  return { valid: false, contract: entry.contract, errors: leafErrors(result.errors) };
}

export class RecordContractError extends Error {
  readonly objectType: string;
  readonly errors: string[];
  constructor(objectType: string, errors: string[]) {
    super(`record.data_invalid:${objectType}: ${errors.slice(0, 5).join("; ")}`);
    this.objectType = objectType;
    this.errors = errors;
  }
}

/** `validateRecordData`, throwing `RecordContractError` when the data does not conform. */
export function assertRecordData(objectType: string, data: unknown): void {
  const result = validateRecordData(objectType, data);
  if (!result.valid) throw new RecordContractError(objectType, result.errors);
}

/** Namespace key pattern of the ontology's `Extensions` map. */
export const EXTENSION_NAMESPACE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/**
 * A versioned, namespaced extension block (`data.extensions`): where source fields that have no
 * canonical field live. Existing skill declarations never consume extension values; empty
 * values are dropped so a record carries no meaningless extension.
 */
export function extensionBlock(namespace: string, schemaVersion: string, value: Json): Json | undefined {
  if (!EXTENSION_NAMESPACE.test(namespace)) throw new Error(`record.extension_namespace_invalid:${namespace}`);
  const kept = Object.fromEntries(Object.entries(value).filter(([, item]) =>
    item !== undefined && item !== null && !(Array.isArray(item) && item.length === 0)
    && !(typeof item === "object" && !Array.isArray(item) && Object.keys(item as Json).length === 0)));
  return Object.keys(kept).length ? { [namespace]: { schema_version: schemaVersion, value: kept } } : undefined;
}

// ---------------------------------------------------------------------------
// Provider capability payloads
// ---------------------------------------------------------------------------

export { LIBRARY_CAPABILITIES, PROVIDER_SCHEMAS, type LibraryCapability } from "./providers.js";

const providerValidators = new Map<string, Validator>();

/** Validate a provider request or response against the library's schema for that capability. */
export function validateProviderPayload(capability: string, direction: "request" | "response", payload: unknown): { valid: boolean; errors: string[] } {
  const schema = PROVIDER_SCHEMAS[capability]?.[direction];
  if (!schema) return { valid: false, errors: [`No library ${direction} schema for capability ${capability}.`] };
  const key = `${capability}:${direction}`;
  let validator = providerValidators.get(key);
  if (!validator) {
    validator = new Validator(schema as never, "2020-12", false);
    providerValidators.set(key, validator);
  }
  const result = validator.validate(payload);
  return { valid: result.valid, errors: result.valid ? [] : leafErrors(result.errors) };
}

// ---------------------------------------------------------------------------
// Effect commands
// ---------------------------------------------------------------------------

export const EFFECT_COMMAND_SCHEMA = effectCommandSchema as unknown as JsonSchema;
export * from "./effects.js";

/** Pinned, closed canonical data schemas for mapping authoring. No separate UI ontology. */
export function canonicalSchemaMetadata() {
  return { schemaVersion: LIBRARY_CONTEXT_SCHEMA_VERSION, lock: LIBRARY_CONTRACTS_LOCK,
    objectTypes: [...LIBRARY_CONTEXT_TYPES, ...Object.keys(APPLICATION_CONTEXT_SCHEMAS)],
    platformContracts: Object.fromEntries(Object.keys(APPLICATION_CONTEXT_SCHEMAS).map(type => [type, { version: "1.0.0", consumer: "platform", librarySkills: false }])),
    definitions: { ...ontology.$defs, ...APPLICATION_CONTEXT_SCHEMAS } };
}

/** Semantic links are versioned with the library; JSON Schema value refs are not links. */
export function canonicalRelationships() { return relationships; }
/** UI metadata derived from the pinned, closed record contracts; never a second ontology. */
export function canonicalTypeDescriptors() {
  return [...LIBRARY_CONTEXT_TYPES, ...Object.keys(PLATFORM_RECORD_SCHEMAS)]
    .sort()
    .map((name) => {
      const schema = ontology.$defs[name] ?? PLATFORM_RECORD_SCHEMAS[name]!;
      const required = Array.isArray(schema.required)
        ? schema.required.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const properties =
        schema.properties && typeof schema.properties === "object"
          ? (schema.properties as Record<string, JsonSchema>)
          : {};
      return {
        name,
        schemaVersion: LIBRARY_CONTEXT_SCHEMA_VERSION,
        required,
        fields: Object.entries(properties).map(([field, value]) => ({
          name: field,
          type:
            typeof value.$ref === "string"
              ? value.$ref.split("/").at(-1)!
              : String(value.type ?? "value"),
          required: required.includes(field),
        })),
      };
    });
}
