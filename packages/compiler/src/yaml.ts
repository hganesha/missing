import { Alias, Document, isAlias, isMap, isScalar, isSeq, parseDocument, Scalar, type Node as YamlNode } from "yaml";
import { CompilerError } from "./errors.js";
import { F64, object, type Json } from "./json.js";

/**
 * YAML reading with the scalar rules of the compiler's original YAML library
 * (serde_yaml_ng, YAML 1.2 core resolution):
 *
 * - only a plain scalar is resolved; a quoted or block scalar is always a string;
 * - `~`, `null`, `Null`, `NULL` and the empty plain scalar are null;
 * - `true`/`True`/`TRUE` and `false`/`False`/`FALSE` are booleans (`yes`, `on` are strings);
 * - integers are decimal, `0x`, `0o` or `0b`, with an optional sign; a leading zero followed
 *   only by digits (`007`) is a string;
 * - floats follow Rust's `f64` syntax; `.inf` and `.nan` become null in a JSON value.
 *
 * Fail-closed differences: an explicit tag (`!!str`, `!custom`) and a duplicate mapping key
 * are refused, and an integer outside the u64/i64 range is refused rather than widened.
 */

export type Node = YamlNode | null;

export class YamlDocument {
  constructor(readonly document: Document.Parsed, readonly label: string) {}

  get root(): Node {
    return (this.document.contents as YamlNode | null) ?? null;
  }

  /** Follow aliases to the anchored node. */
  resolve(node: Node | undefined): Node {
    let current: Node | undefined = node;
    for (let depth = 0; current && isAlias(current); depth += 1) {
      if (depth > 64) this.fail("alias chain too deep");
      current = (current as Alias).resolve(this.document) as YamlNode | undefined;
      if (current === undefined) this.fail("unresolved alias");
    }
    return current ?? null;
  }

  fail(detail: string): never {
    throw new CompilerError(`parse ${this.label}`, `parse ${this.label}: ${detail}`);
  }
}

export function parseYaml(text: string, label: string): YamlDocument {
  const document = parseDocument(text, {
    schema: "failsafe",
    uniqueKeys: true,
    merge: false,
    version: "1.2",
    prettyErrors: false,
  });
  const wrapped = new YamlDocument(document, label);
  const [error] = document.errors;
  if (error) wrapped.fail(error.message);
  for (const warning of document.warnings) wrapped.fail(warning.message);
  refuseTags(wrapped, wrapped.root);
  return wrapped;
}

function refuseTags(document: YamlDocument, node: Node): void {
  if (!node || isAlias(node)) return;
  if (node.tag) document.fail(`tags are not supported (${node.tag})`);
  if (isMap(node)) {
    for (const pair of node.items) {
      refuseTags(document, pair.key as Node);
      refuseTags(document, pair.value as Node);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) refuseTags(document, item as Node);
  }
}

// ---- Plain scalar resolution -------------------------------------------------------------

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);

export function isNullText(text: string): boolean {
  return text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL";
}

export function parseBool(text: string): boolean | undefined {
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  return undefined;
}

export function digitsButNotNumber(text: string): boolean {
  const unsigned = text.startsWith("-") || text.startsWith("+") ? text.slice(1) : text;
  return unsigned.length > 1 && unsigned.startsWith("0") && /^[0-9]+$/.test(unsigned.slice(1));
}

const RADIX_DIGITS: Record<number, RegExp> = { 16: /^[0-9a-fA-F]+$/, 8: /^[0-7]+$/, 2: /^[01]+$/, 10: /^[0-9]+$/ };

/** Rust `from_str_radix` for an unsigned magnitude: optional single `+`, then digits. */
function fromStrRadix(text: string, radix: number): bigint | undefined {
  let negative = false;
  let digits = text;
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("-")) { negative = true; digits = digits.slice(1); }
  if (!RADIX_DIGITS[radix]!.test(digits)) return undefined;
  const prefix = radix === 16 ? "0x" : radix === 8 ? "0o" : radix === 2 ? "0b" : "";
  const magnitude = BigInt(`${prefix}${digits}`);
  return negative ? -magnitude : magnitude;
}

/** `parse_unsigned_int` (u64). */
export function parseUnsignedInt(text: string): bigint | undefined {
  const unpositive = text.startsWith("+") ? text.slice(1) : text;
  for (const [prefix, radix] of [["0x", 16], ["0o", 8], ["0b", 2]] as const) {
    if (unpositive.startsWith(prefix)) {
      const rest = unpositive.slice(2);
      if (rest.startsWith("+") || rest.startsWith("-")) return undefined;
      const value = fromStrRadix(rest, radix);
      if (value !== undefined && value >= 0n && value <= U64_MAX) return value;
    }
  }
  if (unpositive.startsWith("+") || unpositive.startsWith("-")) return undefined;
  if (digitsButNotNumber(text)) return undefined;
  const value = fromStrRadix(unpositive, 10);
  return value !== undefined && value >= 0n && value <= U64_MAX ? value : undefined;
}

/** `parse_negative_int` (i64). */
function parseNegativeInt(text: string): bigint | undefined {
  for (const [prefix, radix] of [["-0x", 16], ["-0o", 8], ["-0b", 2]] as const) {
    if (text.startsWith(prefix)) {
      const value = fromStrRadix(`-${text.slice(3)}`, radix);
      if (value !== undefined && value >= I64_MIN && value <= 0n) return value;
    }
  }
  if (digitsButNotNumber(text)) return undefined;
  const value = fromStrRadix(text, 10);
  return value !== undefined && value >= I64_MIN && value <= (1n << 63n) - 1n ? value : undefined;
}

/** Rust `str::parse::<f64>` syntax (finite values only). */
const RUST_F64 = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/** `parse_f64`: a finite float, or Infinity/NaN for `.inf`/`.nan` spellings. */
export function parseF64(text: string): number | undefined {
  let unpositive = text;
  if (text.startsWith("+")) {
    unpositive = text.slice(1);
    if (unpositive.startsWith("+") || unpositive.startsWith("-")) return undefined;
  }
  if ([".inf", ".Inf", ".INF"].includes(unpositive)) return Number.POSITIVE_INFINITY;
  if (["-.inf", "-.Inf", "-.INF"].includes(text)) return Number.NEGATIVE_INFINITY;
  if ([".nan", ".NaN", ".NAN"].includes(text)) return Number.NaN;
  if (!RUST_F64.test(unpositive)) return undefined;
  const value = Number(unpositive);
  return Number.isFinite(value) ? value : undefined;
}

function integerValue(value: bigint): Json {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/** A plain scalar as a JSON value (`visit_untagged_scalar` into `serde_json::Value`). */
export function resolvePlain(text: string, document: YamlDocument): Json {
  if (isNullText(text)) return null;
  const boolean = parseBool(text);
  if (boolean !== undefined) return boolean;
  const unsigned = parseUnsignedInt(text);
  if (unsigned !== undefined) return integerValue(unsigned);
  const negative = parseNegativeInt(text);
  if (negative !== undefined) return integerValue(negative);
  if (looksLikeWideInteger(text)) document.fail(`integer out of range: ${text}`);
  if (!digitsButNotNumber(text)) {
    const float = parseF64(text);
    // serde_json has no NaN or infinity: such a float becomes null.
    if (float !== undefined) return Number.isFinite(float) ? new F64(float) : null;
  }
  return text;
}

/** An integer the original library would widen to 128 bits; refused here. */
function looksLikeWideInteger(text: string): boolean {
  const unsigned = text.replace(/^[+-]/, "");
  if (digitsButNotNumber(text)) return false;
  return /^(?:[0-9]+|0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/.test(unsigned);
}

// ---- Untyped conversion (`serde_json::Value`) ---------------------------------------------

/** A mapping key as a string: any scalar, by its text. */
export function keyText(document: YamlDocument, node: Node | undefined): string {
  const key = document.resolve(node);
  if (key === null) return "";
  if (isScalar(key)) return String(key.value);
  return document.fail("a mapping key must be a scalar");
}

/** Upper bound on values produced from one document, so aliases cannot expand without limit. */
const MAX_EXPANDED_NODES = 2_000_000;

export function toJson(document: YamlDocument, node: Node | undefined): Json {
  const budget = { remaining: MAX_EXPANDED_NODES };
  return convert(document, node, budget);
}

function convert(document: YamlDocument, node: Node | undefined, budget: { remaining: number }): Json {
  budget.remaining -= 1;
  if (budget.remaining < 0) document.fail("document expands to too many values");
  const resolved = document.resolve(node);
  if (resolved === null) return null;
  if (isScalar(resolved)) {
    const text = String(resolved.value);
    return resolved.type === Scalar.PLAIN ? resolvePlain(text, document) : text;
  }
  if (isSeq(resolved)) return resolved.items.map((item) => convert(document, item as Node, budget));
  if (isMap(resolved)) {
    const result = object();
    for (const pair of resolved.items) {
      const key = keyText(document, pair.key as Node);
      if (Object.prototype.hasOwnProperty.call(result, key)) document.fail(`duplicate mapping key: ${key}`);
      result[key] = convert(document, pair.value as Node, budget);
    }
    return result;
  }
  return document.fail("unsupported YAML node");
}

// ---- Typed reading with the original library's leniency ------------------------------------

/**
 * Reads one typed field of a YAML mapping the way a derived serde struct does: a string field
 * accepts any scalar by its text (`version: 1.0` is "1.0"), an optional field treats a plain
 * null as absent, and a list field treats an empty plain scalar as empty.
 */
export class TypedReader {
  constructor(readonly document: YamlDocument) {}

  /** The pairs of a struct-typed node; an empty plain scalar is an empty struct. */
  struct(node: Node | undefined, path: string): Map<string, Node> {
    const resolved = this.document.resolve(node);
    const fields = new Map<string, Node>();
    if (resolved === null || (isScalar(resolved) && resolved.type === Scalar.PLAIN && resolved.value === "")) return fields;
    if (!isMap(resolved)) this.invalid(path, "a mapping");
    for (const pair of resolved.items) {
      const key = keyText(this.document, pair.key as Node);
      if (fields.has(key)) this.document.fail(`duplicate field \`${key}\` at ${path}`);
      fields.set(key, (pair.value as Node) ?? null);
    }
    return fields;
  }

  required(fields: Map<string, Node>, key: string, path: string): Node {
    if (!fields.has(key)) this.document.fail(`missing field \`${key}\` at ${path}`);
    return fields.get(key)!;
  }

  string(node: Node | undefined, path: string): string {
    const resolved = this.document.resolve(node);
    if (resolved === null) return "";
    if (isScalar(resolved)) return String(resolved.value);
    return this.invalid(path, "a string");
  }

  /** `Option<String>`: a plain null (or empty) scalar is `None`. */
  optionalString(node: Node | undefined, path: string): string | undefined {
    if (this.isNone(node)) return undefined;
    return this.string(node, path);
  }

  /** A sequence; an empty plain scalar is an empty sequence. */
  sequence(node: Node | undefined, path: string): Node[] {
    const resolved = this.document.resolve(node);
    if (resolved === null) return [];
    if (isScalar(resolved) && resolved.type === Scalar.PLAIN && resolved.value === "") return [];
    if (!isSeq(resolved)) this.invalid(path, "a sequence");
    return resolved.items.map((item) => (item as Node) ?? null);
  }

  /** `Option<Vec<_>>`: a plain null is `None`. */
  optionalSequence(node: Node | undefined, path: string): Node[] | undefined {
    if (this.isNone(node)) return undefined;
    return this.sequence(node, path);
  }

  /** `BTreeMap<String, String>`. */
  stringMap(node: Node | undefined, path: string): Map<string, string> {
    const fields = this.struct(node, path);
    const result = new Map<string, string>();
    for (const [key, value] of fields) result.set(key, this.string(value, `${path}.${key}`));
    return result;
  }

  /** `u64`: a plain scalar integer. */
  u64(node: Node | undefined, path: string): bigint {
    const resolved = this.document.resolve(node);
    if (resolved && isScalar(resolved) && resolved.type === Scalar.PLAIN) {
      const value = parseUnsignedInt(String(resolved.value));
      if (value !== undefined) return value;
    }
    return this.invalid(path, "an unsigned integer");
  }

  bool(node: Node | undefined, path: string): boolean {
    const resolved = this.document.resolve(node);
    if (resolved && isScalar(resolved) && resolved.type === Scalar.PLAIN) {
      const value = parseBool(String(resolved.value));
      if (value !== undefined) return value;
    }
    return this.invalid(path, "a boolean");
  }

  json(node: Node | undefined): Json {
    return toJson(this.document, node);
  }

  /** `Option<serde_json::Value>`: a plain null is `None`. */
  optionalJson(node: Node | undefined): Json | undefined {
    if (this.isNone(node)) return undefined;
    return this.json(node);
  }

  private isNone(node: Node | undefined): boolean {
    const resolved = this.document.resolve(node);
    if (resolved === null) return true;
    return isScalar(resolved) && resolved.type === Scalar.PLAIN && isNullText(String(resolved.value));
  }

  private invalid(path: string, expected: string): never {
    return this.document.fail(`invalid type at ${path}: expected ${expected}`);
  }
}
