import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as ajvFormats from "ajv-formats";
import bundle from "../vendor/bundle.json" with { type: "json" };

/**
 * Response and schema validators compiled from the bundled Experience API. Used by the mock
 * in dev and tests, and by contract tests, so every payload the UI sees matches the
 * contract (BUILD-SPEC v2 §6.3).
 */
const BUNDLE_ID = "urn:ehf:experience-api";

type Ajv = Ajv2020;
// ajv-formats is CommonJS: depending on the resolver its plugin is `default` or `default.default`.
type FormatsPlugin = (ajv: Ajv) => Ajv;
const formatsDefault = (ajvFormats as unknown as { default: unknown }).default;
const addFormats = (typeof formatsDefault === "function" ? formatsDefault : (formatsDefault as { default: unknown }).default) as FormatsPlugin;

type JsonObject = { [key: string]: unknown };

/** Nested `$schema`/`$id` keys from exported upstream schemas would collide in one Ajv instance. */
function stripNested(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((item) => stripNested(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value as JsonObject)) {
    if (depth > 0 && (key === "$schema" || key === "$id")) continue;
    out[key] = stripNested(child, depth + 1);
  }
  return out;
}

const spec = stripNested(bundle) as JsonObject & {
  paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>;
  components: { schemas: Record<string, unknown> };
};

let ajv: Ajv | undefined;

function instance(): Ajv {
  if (ajv) return ajv;
  ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  for (const keyword of ["discriminator", "example", "xml", "externalDocs"]) ajv.addKeyword(keyword);
  ajv.addSchema({ $id: BUNDLE_ID, components: spec.components }, BUNDLE_ID);
  return ajv;
}

/** Point local `#/components/...` refs at the registered bundle. */
function anchor(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema).replaceAll('"$ref":"#/', `"$ref":"${BUNDLE_ID}#/`));
}

const responseCache = new Map<string, ValidateFunction | null>();
const schemaCache = new Map<string, ValidateFunction>();

export type ValidationResult = { valid: true } | { valid: false; errors: ErrorObject[]; message: string };

function summarize(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).slice(0, 5).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
}

/** Validator for a named component schema, e.g. `validatorFor("Session")`. */
export function validatorFor(name: string): ValidateFunction {
  const cached = schemaCache.get(name);
  if (cached) return cached;
  if (!(name in spec.components.schemas)) throw new Error(`ui-contracts: unknown schema ${name}`);
  const validate = instance().compile({ $ref: `${BUNDLE_ID}#/components/schemas/${name}` });
  schemaCache.set(name, validate);
  return validate;
}

function responseSchema(operationId: string, status: number): unknown | null {
  for (const item of Object.values(spec.paths)) {
    for (const op of Object.values(item)) {
      if (op?.operationId !== operationId) continue;
      const responses = op.responses ?? {};
      const response = responses[String(status)] ?? responses[`${String(status)[0]}XX`] ?? responses.default;
      if (!response) throw new Error(`ui-contracts: ${operationId} declares no response for ${status}`);
      return response.content?.["application/json"]?.schema ?? null;
    }
  }
  throw new Error(`ui-contracts: unknown operation ${operationId}`);
}

/** Validate a JSON response body against the operation's declared response for `status`. */
export function validateResponse(operationId: string, status: number, body: unknown): ValidationResult {
  const key = `${operationId}:${status}`;
  let validate: ValidateFunction | null | undefined = responseCache.get(key);
  if (validate === undefined) {
    const schema = responseSchema(operationId, status);
    validate = schema === null ? null : instance().compile(anchor(schema) as object);
    responseCache.set(key, validate);
  }
  const check = validate;
  if (check === null) return { valid: true };
  if (check(body)) return { valid: true };
  return { valid: false, errors: check.errors ?? [], message: summarize(check.errors) };
}

/** Every declared (operationId, status) pair with a JSON body; used by coverage tests. */
export function declaredResponses(): Array<{ operationId: string; status: string }> {
  return Object.values(spec.paths).flatMap((item) => Object.values(item).flatMap((op) =>
    Object.entries(op?.responses ?? {})
      .filter(([, response]) => response.content?.["application/json"]?.schema)
      .map(([status]) => ({ operationId: op.operationId!, status }))));
}

/** Reason codes the contract declares, grouped by category (session, authorization, workflow, ...). */
export const reasonCodes: Readonly<Record<string, readonly string[]>> =
  (bundle as { "x-reason-codes"?: Record<string, string[]> })["x-reason-codes"] ?? {};
