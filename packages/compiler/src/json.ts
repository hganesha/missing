import { createHash } from "node:crypto";

/**
 * The compiler's JSON value model.
 *
 * A plan is content-addressed, so the bytes of every number matter. YAML and JSON both
 * distinguish an integer (`1`) from a float (`1.0`), and the emitted plan keeps that
 * distinction (`1.0` stays `1.0`). JavaScript numbers cannot, so a float is carried as an
 * `F64` and an integer outside the safe range as a `bigint`.
 */
export class F64 {
  constructor(readonly value: number) {}
}

export type Json = null | boolean | number | bigint | string | F64 | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

/** A map with no prototype, so a `__proto__` key in authored YAML is an ordinary key. */
export function object(): JsonObject {
  return Object.create(null) as JsonObject;
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof F64);
}

export function isArray(value: Json | undefined): value is Json[] {
  return Array.isArray(value);
}

export function asString(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function has(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** `serde_json::Value::get` on an object: present (even when null) or undefined. */
export function get(value: Json | undefined, key: string): Json | undefined {
  return isObject(value) && has(value, key) ? value[key] : undefined;
}

const U64_MAX = (1n << 64n) - 1n;

/** `serde_json::Value::as_u64`: a non-negative integer (never a float). */
export function asU64(value: Json | undefined): bigint | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "bigint" && value >= 0n && value <= U64_MAX) return value;
  return undefined;
}

/** A u64 as the JSON value the compiler emits for it. */
export function u64Value(value: bigint): Json {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/**
 * Keys in UTF-8 byte order, which is code point order: the order of a Rust `BTreeMap<String, _>`.
 * (UTF-16 code unit order differs from it for supplementary-plane characters.)
 */
export function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index]!.codePointAt(0)!;
    const y = b[index]!.codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

export function sortedKeys(value: JsonObject): string[] {
  return Object.keys(value).sort(compareKeys);
}

/**
 * The shortest round-trip float text in the layout `serde_json` writes: positional
 * notation (with a trailing `.0` when integral) for decimal exponents -5..=15 and
 * scientific notation (`1e+16`, `1.5e-7`) outside them.
 */
export function formatF64(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`json.non_finite_float:${value}`);
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const exponent = Number(exponentText);
  if (exponent < -5 || exponent > 15) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
    return `${sign}${digits[0]}${fraction}e${exponent < 0 ? "-" : "+"}${Math.abs(exponent)}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const integer = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  const fraction = digits.slice(exponent + 1);
  return `${sign}${integer}.${fraction || "0"}`;
}

function scalar(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`json.number_not_integral:${value}`);
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof F64) return formatF64(value.value);
  throw new Error("json.not_scalar");
}

function keysOf(value: JsonObject, sorted: boolean): string[] {
  return sorted ? sortedKeys(value) : Object.keys(value);
}

/**
 * Compact JSON. `sorted` orders object keys by UTF-8 bytes, which is what every plan
 * document and digest uses; insertion order is only for documents that mirror a Rust struct.
 */
export function stringify(value: Json, sorted = true): string {
  if (Array.isArray(value)) return `[${value.map((item) => stringify(item, sorted)).join(",")}]`;
  if (isObject(value)) {
    return `{${keysOf(value, sorted).map((key) => `${JSON.stringify(key)}:${stringify(value[key]!, sorted)}`).join(",")}}`;
  }
  return scalar(value);
}

/** Pretty JSON with two-space indentation, laid out exactly as `serde_json::to_string_pretty`. */
export function stringifyPretty(value: Json, sorted = true, indent = ""): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `${inner}${stringifyPretty(item, sorted, inner)}`).join(",\n")}\n${indent}]`;
  }
  if (isObject(value)) {
    const keys = keysOf(value, sorted);
    if (keys.length === 0) return "{}";
    return `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${stringifyPretty(value[key]!, sorted, inner)}`).join(",\n")}\n${indent}}`;
  }
  return scalar(value);
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 of the canonical (sorted, compact) JSON: every digest a plan carries. */
export function digest(value: Json): string {
  return sha256Hex(stringify(value));
}

/**
 * Parse JSON the way `serde_json` does into a `Value`: integer syntax stays an integer
 * (a `bigint` beyond the safe range, a float beyond u64/i64) and float syntax stays a float.
 */
export function parseJson(text: string): Json {
  const I64_MIN = -(1n << 63n);
  const convert = (raw: unknown, source: string | undefined): Json => {
    if (typeof raw !== "number") return raw as Json;
    const text = source ?? String(raw);
    if (/^-?\d+$/.test(text)) {
      const integer = BigInt(text);
      if (integer >= I64_MIN && integer <= U64_MAX) {
        return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
      }
    }
    return new F64(raw);
  };
  const revive = (value: unknown): Json => {
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === "object" && !(value instanceof F64)) {
      const result = object();
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) result[key] = revive(nested);
      return result;
    }
    return value as Json;
  };
  const parsed = JSON.parse(text, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    return typeof value === "number" ? convert(value, context?.source) : value;
  }) as unknown;
  return revive(parsed);
}
