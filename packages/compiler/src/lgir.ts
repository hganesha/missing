/**
 * Ladder Graph IR (LGIR) validation: the structural rules of `lgir-core` at the pinned
 * revision (`LGIR_CORE_REVISION`), ported so the compiler runs in-process.
 *
 * The compiler hands LGIR the authored workflow after one transform (gate and fanout nodes
 * analysed as `transform`s). The original implementation re-serialized that document to YAML
 * and parsed it again; this port works on the document directly and reproduces the effects of
 * that round trip: the textual refusals (size, anchors and aliases, external `$ref`s) are
 * evaluated against the YAML the document serializes to, and the typed parse applies the same
 * field defaults and type strictness.
 */
import { compareKeys, F64, isObject, object, sha256Hex, sortedKeys, stringify, stringifyPretty, type Json, type JsonObject } from "./json.js";

export const LGIR_CORE_REVISION = "fec01bf0fa5ff259c071439d63ad71c9979668f9";
const API_VERSION = "ladder.dev/v1alpha1";

export interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  path: string;
  nodeId?: string;
  edgeId?: string;
  message: string;
  capability?: string;
  fix?: { label: string; path: string; value: Json };
}

export interface Branch { label: string; when: string }
export interface SubgraphConfig { ref: string; inputMap: Map<string, string>; outputMap: Map<string, string>; checkpointer: string }
export interface NodeConfig {
  operation: string; expression: string; branches: Branch[]; join: string; aggregation: string;
  teacherModel: string; feedbackMode: string; workingDirectory: string; body: string[];
  exitCondition: string; maxIterations: number; onExhausted: string; carry: Map<string, string>;
  threshold: number | undefined; members: string[]; execution: string; exit: string; router: string;
  defaultBranch: string; entry: string; exitNode: string; subgraph: SubgraphConfig | undefined;
}
export interface WorkflowNode {
  id: string; kind: string; name: string; templateRef: string; inlineRole: boolean; summary: string;
  icon: { set: string; name: string } | undefined; role: string; prompt: string;
  inputSchema: Json; outputSchema: Json; contractRefs: { ref: string; usage: string }[]; formRefs: string[];
  capabilities: {
    skills: string[]; tools: string[]; connectors: string[]; permissions: string[];
    customizations: Map<string, { template: string; instructions: string }>;
  };
  config: NodeConfig; position: { x: number; y: number };
}
export interface WorkflowEdge {
  id: string; from: string; to: string; kind: string; contract: string; condition: string;
  sourcePath: string; targetPath: string;
}
export interface Workflow {
  apiVersion: string; kind: string;
  metadata: { name: string; title: string; description: string; version: string };
  spec: {
    objective: string; inputs: Map<string, Json>; outputs: Map<string, Json>;
    policies: { maxConcurrency: number; onFailure: string; requireApprovalFor: string[] };
    nodes: WorkflowNode[]; edges: WorkflowEdge[];
  };
}

export interface Stats { nodes: number; edges: number; agents: number; loops: number; maxParallelism: number }
export interface AnalysisResult {
  ok: boolean;
  sourceHash: string;
  diagnostics: Diagnostic[];
  normalized: Workflow | undefined;
  nodeOrder: string[];
  stats: Stats;
}

function diag(code: string, severity: Diagnostic["severity"], path: string, message: string): Diagnostic {
  return { code, severity, path, message };
}

// ---- Textual refusals, evaluated against the serialized YAML ------------------------------

const IS_BREAK = (code: number) => code === 0x0a || code === 0x0d || code === 0x85 || code === 0x2028 || code === 0x2029;

/** libyaml's IS_PRINTABLE (with the emitter's unicode output enabled). */
function printable(code: number): boolean {
  return code === 0x0a || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd && code !== 0xfeff) || code >= 0x10000;
}

interface ScalarShape {
  multiline: boolean;
  /** Plain or quoted on one line when false; a literal block when true. */
  literal: boolean;
  /** Written with double quotes (escape sequences replace non-printable characters). */
  doubleQuoted: boolean;
  quoted: boolean;
}

/** How the YAML serializer lays out a string (serde_yaml_ng over libyaml, block context). */
function scalarShape(value: string): ScalarShape {
  const chars = [...value];
  let special = false;
  let lineBreaks = false;
  let leadingSpace = false;
  let leadingBreak = false;
  let trailingSpace = false;
  let trailingBreak = false;
  let breakSpace = false;
  let spaceBreak = false;
  let previousSpace = false;
  let previousBreak = false;
  let blockIndicators = value.startsWith("---") || value.startsWith("...");
  chars.forEach((char, index) => {
    const code = char.codePointAt(0)!;
    const next = chars[index + 1];
    const followedByWhitespace = next === undefined || next === " " || next === "\t" || IS_BREAK(next.codePointAt(0)!);
    const precededByWhitespace = index === 0 || [" ", "\t"].includes(chars[index - 1]!) || IS_BREAK(chars[index - 1]!.codePointAt(0)!);
    if (index === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(char)) blockIndicators = true;
      if ((char === "?" || char === ":") && followedByWhitespace) blockIndicators = true;
      if (char === "-" && followedByWhitespace) blockIndicators = true;
    } else {
      if (char === ":" && followedByWhitespace) blockIndicators = true;
      if (char === "#" && precededByWhitespace) blockIndicators = true;
    }
    if (!printable(code)) special = true;
    if (IS_BREAK(code)) lineBreaks = true;
    if (char === " ") {
      if (index === 0) leadingSpace = true;
      if (index === chars.length - 1) trailingSpace = true;
      if (previousBreak) breakSpace = true;
      previousSpace = true;
      previousBreak = false;
    } else if (IS_BREAK(code)) {
      if (index === 0) leadingBreak = true;
      if (index === chars.length - 1) trailingBreak = true;
      if (previousSpace) spaceBreak = true;
      previousSpace = false;
      previousBreak = true;
    } else {
      previousSpace = false;
      previousBreak = false;
    }
  });
  let plainAllowed = value.length > 0;
  let singleAllowed = true;
  let blockAllowed = value.length > 0;
  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) plainAllowed = false;
  if (trailingSpace) blockAllowed = false;
  if (breakSpace) { plainAllowed = false; singleAllowed = false; }
  if (spaceBreak || special) { plainAllowed = false; singleAllowed = false; blockAllowed = false; }
  if (lineBreaks || blockIndicators) plainAllowed = false;
  const multiline = value.includes("\n");
  if (multiline) {
    // serde_yaml_ng asks for a literal block; libyaml falls back to double quotes.
    return { multiline, literal: blockAllowed, doubleQuoted: !blockAllowed, quoted: !blockAllowed };
  }
  const plain = plainAllowed && !resolvesAsNonString(value);
  const doubleQuoted = !plain && !singleAllowed;
  return { multiline, literal: false, doubleQuoted, quoted: !plain };
}

/** A string that YAML would read back as null, a boolean or a number is always quoted. */
function resolvesAsNonString(value: string): boolean {
  if (value === "" || ["~", "null", "Null", "NULL", "true", "True", "TRUE", "false", "False", "FALSE"].includes(value)) return true;
  const unsigned = value.replace(/^[+-]/, "");
  if (unsigned.length > 1 && unsigned.startsWith("0") && /^[0-9]+$/.test(unsigned.slice(1))) return true;
  if (/^[+-]?(?:[0-9]+|0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/.test(value)) return true;
  if ([".inf", ".Inf", ".INF", "-.inf", "-.Inf", "-.INF", "+.inf", "+.Inf", "+.INF", ".nan", ".NaN", ".NAN"].includes(value)) return true;
  return /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value) && Number.isFinite(Number(value.replace(/^\+/, "")));
}

const ANCHOR_PATTERNS = [": &", ": *", "- &", "- *"];
const EXTERNAL_REF_PREFIXES = ["$ref: http://", "$ref: https://", "$ref: //"];

function externalRef(line: string): boolean {
  const compact = line.trim().replaceAll("\"", "").replaceAll("'", "");
  return EXTERNAL_REF_PREFIXES.some((prefix) => compact.startsWith(prefix));
}

interface TextualFindings { size: number; anchors: boolean; externalRef: boolean }

/**
 * Walk the document as serialized block YAML: mapping keys in UTF-8 order, sequences
 * indentless under a key, a mapping in a sequence starting on the `- ` line.
 */
function textualFindings(document: Json): TextualFindings {
  const findings: TextualFindings = { size: 0, anchors: false, externalRef: false };
  const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

  const scalarText = (value: Json): { text: string; shape: ScalarShape | undefined } => {
    if (typeof value === "string") {
      const shape = scalarShape(value);
      if (shape.literal) return { text: "|-", shape };
      if (shape.doubleQuoted) return { text: JSON.stringify(value), shape };
      if (shape.quoted) return { text: `'${value.replaceAll("'", "''")}'`, shape };
      return { text: value, shape };
    }
    if (value === null) return { text: "null", shape: undefined };
    if (value instanceof F64) return { text: String(value.value), shape: undefined };
    return { text: String(value), shape: undefined };
  };

  /** Checks for one string: its own content lines and any line it starts. */
  const inspectString = (value: string, shape: ScalarShape, indent: number) => {
    if (shape.literal) {
      for (const line of value.split("\n")) {
        findings.size += indent + 2 + utf8(line) + 1;
        if (line.trimStart().startsWith("&") || line.trimStart().startsWith("*")) findings.anchors = true;
        if (ANCHOR_PATTERNS.some((pattern) => line.includes(pattern))) findings.anchors = true;
        if (externalRef(line)) findings.externalRef = true;
      }
      return;
    }
    // One line: the patterns can only come from the string's own text (a value that starts
    // with `&` or `*` is always quoted, so it never joins the `: `/`- ` before it).
    for (const segment of value.split("\n")) {
      if (ANCHOR_PATTERNS.some((pattern) => segment.includes(pattern))) findings.anchors = true;
    }
  };

  const emitScalar = (value: Json, indent: number) => {
    const { text, shape } = scalarText(value);
    if (typeof value === "string" && shape) inspectString(value, shape, indent);
    return text;
  };

  const walk = (value: Json, indent: number, lineStart: boolean): void => {
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      for (const item of value) {
        findings.size += indent + 2;
        if (Array.isArray(item) && item.length > 0) {
          walk(item, indent + 2, false);
        } else if (isObject(item) && Object.keys(item).length > 0) {
          walk(item, indent + 2, false);
        } else {
          const text = isObject(item) ? "{}" : Array.isArray(item) ? "[]" : emitScalar(item, indent);
          findings.size += utf8(text) + 1;
        }
      }
      return;
    }
    if (isObject(value)) {
      sortedKeys(value).forEach((key, index) => {
        const startsLine = lineStart || index > 0;
        const keyText = emitScalar(key, indent);
        const nested = value[key]!;
        if (startsLine) findings.size += indent;
        findings.size += utf8(keyText) + 1;
        if (Array.isArray(nested) && nested.length > 0) {
          findings.size += 1;
          walk(nested, indent, true);
        } else if (isObject(nested) && Object.keys(nested).length > 0) {
          findings.size += 1;
          walk(nested, indent + 2, true);
        } else {
          const text = isObject(nested) ? "{}" : Array.isArray(nested) ? "[]" : emitScalar(nested, indent);
          findings.size += 1 + utf8(text) + 1;
          // Only a line that starts with the key can read as `$ref: <url>`.
          if (startsLine && externalRef(`${keyText}: ${text}`)) findings.externalRef = true;
        }
      });
      return;
    }
    findings.size += utf8(emitScalar(value, indent)) + 1;
  };
  walk(document, 0, true);
  return findings;
}

function textualRefusal(document: Json): Diagnostic | undefined {
  const findings = textualFindings(document);
  if (findings.size > 2_000_000) return diag("LG001", "error", "/", "LGIR source exceeds the 2 MB import limit.");
  if (findings.anchors) return diag("LG004", "error", "/", "YAML anchors and aliases are not supported.");
  if (findings.externalRef) return diag("LG005", "error", "/", "External schema references are not supported.");
  return undefined;
}

// ---- Typed parse (serde field defaults and strictness) ------------------------------------

class ParseError extends Error {}

function typeName(value: Json): string {
  if (value === null) return "unit value";
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number" || typeof value === "bigint") return `integer \`${value}\``;
  if (value instanceof F64) return `floating point \`${value.value}\``;
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  return Array.isArray(value) ? "sequence" : "map";
}

function invalid(value: Json, expected: string): never {
  throw new ParseError(`invalid type: ${typeName(value)}, expected ${expected}`);
}

function fields(value: Json | undefined, name: string): JsonObject {
  if (value === undefined || value === null) return object();
  if (!isObject(value)) invalid(value, `struct ${name}`);
  return value;
}

function required(source: JsonObject, key: string): Json {
  if (!Object.prototype.hasOwnProperty.call(source, key)) throw new ParseError(`missing field \`${key}\``);
  return source[key]!;
}

function optional(source: JsonObject, key: string): Json | undefined {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

function string(value: Json): string {
  if (typeof value !== "string") invalid(value, "a string");
  return value;
}

function stringOr(source: JsonObject, key: string, fallback = ""): string {
  const value = optional(source, key);
  return value === undefined ? fallback : string(value);
}

function list<T>(value: Json | undefined, item: (value: Json) => T): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(value, "a sequence");
  return value.map(item);
}

function map<T>(value: Json | undefined, item: (value: Json) => T): Map<string, T> {
  const result = new Map<string, T>();
  if (value === undefined || value === null) return result;
  if (!isObject(value)) invalid(value, "a map");
  for (const key of sortedKeys(value)) result.set(key, item(value[key]!));
  return result;
}

function u32(value: Json | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value < 0 || value > 0xffff_ffff) throw new ParseError(`invalid value: integer \`${value}\`, expected u32`);
    return value;
  }
  if (typeof value === "bigint") throw new ParseError(`invalid value: integer \`${value}\`, expected u32`);
  return invalid(value, "u32");
}

function f64(value: Json): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof F64) return value.value;
  return invalid(value, "f64");
}

function bool(value: Json | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") invalid(value, "a boolean");
  return value;
}

function parseConfig(value: Json | undefined): NodeConfig {
  const source = fields(value, "NodeConfig");
  const subgraphValue = optional(source, "subgraph");
  const thresholdValue = optional(source, "threshold");
  return {
    operation: stringOr(source, "operation"),
    expression: stringOr(source, "expression"),
    branches: list(optional(source, "branches"), (item) => {
      const branch = fields(item, "Branch");
      return { label: stringOr(branch, "label"), when: stringOr(branch, "when") };
    }),
    join: stringOr(source, "join"),
    aggregation: stringOr(source, "aggregation"),
    teacherModel: stringOr(source, "teacherModel"),
    feedbackMode: stringOr(source, "feedbackMode"),
    workingDirectory: stringOr(source, "workingDirectory"),
    body: list(optional(source, "body"), string),
    exitCondition: stringOr(source, "exitCondition"),
    maxIterations: u32(optional(source, "maxIterations")),
    onExhausted: stringOr(source, "onExhausted"),
    carry: map(optional(source, "carry"), string),
    threshold: thresholdValue === undefined || thresholdValue === null ? undefined : f64(thresholdValue),
    members: list(optional(source, "members"), string),
    execution: stringOr(source, "execution"),
    exit: stringOr(source, "exit"),
    router: stringOr(source, "router"),
    defaultBranch: stringOr(source, "defaultBranch"),
    entry: stringOr(source, "entry"),
    exitNode: stringOr(source, "exitNode"),
    subgraph: subgraphValue === undefined || subgraphValue === null ? undefined : (() => {
      const subgraph = fields(subgraphValue, "SubgraphConfig");
      return {
        ref: stringOr(subgraph, "ref"),
        inputMap: map(optional(subgraph, "inputMap"), string),
        outputMap: map(optional(subgraph, "outputMap"), string),
        checkpointer: stringOr(subgraph, "checkpointer", "inherit"),
      };
    })(),
  };
}

function parseNode(value: Json): WorkflowNode {
  const source = fields(value, "Node");
  const iconValue = optional(source, "icon");
  const capabilities = fields(optional(source, "capabilities"), "Capabilities");
  const position = fields(optional(source, "position"), "Position");
  const positionX = optional(position, "x");
  const positionY = optional(position, "y");
  return {
    id: string(required(source, "id")),
    kind: string(required(source, "kind")),
    name: stringOr(source, "name"),
    templateRef: stringOr(source, "templateRef"),
    inlineRole: bool(optional(source, "inlineRole")),
    summary: stringOr(source, "summary"),
    icon: iconValue === undefined || iconValue === null ? undefined : (() => {
      const icon = fields(iconValue, "IconRef");
      return { set: string(required(icon, "set")), name: string(required(icon, "name")) };
    })(),
    role: stringOr(source, "role"),
    prompt: stringOr(source, "prompt"),
    inputSchema: optional(source, "inputSchema") ?? null,
    outputSchema: optional(source, "outputSchema") ?? null,
    contractRefs: list(optional(source, "contractRefs"), (item) => {
      const contract = fields(item, "ContractRef");
      return { ref: string(required(contract, "ref")), usage: string(required(contract, "usage")) };
    }),
    formRefs: list(optional(source, "formRefs"), string),
    capabilities: {
      skills: list(optional(capabilities, "skills"), string),
      tools: list(optional(capabilities, "tools"), string),
      connectors: list(optional(capabilities, "connectors"), string),
      permissions: list(optional(capabilities, "permissions"), string),
      customizations: map(optional(capabilities, "customizations"), (item) => {
        const customization = fields(item, "CapabilityCustomization");
        return { template: stringOr(customization, "template"), instructions: stringOr(customization, "instructions") };
      }),
    },
    config: parseConfig(optional(source, "config")),
    position: { x: positionX === undefined ? 0 : f64(positionX), y: positionY === undefined ? 0 : f64(positionY) },
  };
}

function parseEdge(value: Json): WorkflowEdge {
  const source = fields(value, "Edge");
  return {
    id: string(required(source, "id")),
    from: string(required(source, "from")),
    to: string(required(source, "to")),
    kind: stringOr(source, "kind", "dependency"),
    contract: stringOr(source, "contract"),
    condition: stringOr(source, "condition"),
    sourcePath: stringOr(source, "sourcePath"),
    targetPath: stringOr(source, "targetPath"),
  };
}

function parseWorkflow(document: Json): Workflow {
  if (!isObject(document)) invalid(document, "struct Workflow");
  const metadata = fields(required(document, "metadata"), "Metadata");
  const spec = fields(required(document, "spec"), "WorkflowSpec");
  const policiesValue = optional(spec, "policies");
  // An absent `policies` block takes the struct's derived default (all zero); a present one,
  // even empty, takes the per-field defaults.
  const policies = policiesValue === undefined
    ? { maxConcurrency: 0, onFailure: "", requireApprovalFor: [] as string[] }
    : (() => {
      const source = fields(policiesValue, "Policies");
      const concurrency = optional(source, "maxConcurrency");
      return {
        maxConcurrency: concurrency === undefined ? 4 : u32(concurrency),
        onFailure: stringOr(source, "onFailure", "stop"),
        requireApprovalFor: list(optional(source, "requireApprovalFor"), string),
      };
    })();
  return {
    apiVersion: string(required(document, "apiVersion")),
    kind: string(required(document, "kind")),
    metadata: {
      name: string(required(metadata, "name")),
      title: stringOr(metadata, "title"),
      description: stringOr(metadata, "description"),
      version: stringOr(metadata, "version"),
    },
    spec: {
      objective: stringOr(spec, "objective"),
      inputs: map(optional(spec, "inputs"), (item) => item),
      outputs: map(optional(spec, "outputs"), (item) => item),
      policies,
      nodes: list(optional(spec, "nodes"), parseNode),
      edges: list(optional(spec, "edges"), parseEdge),
    },
  };
}

// ---- Serialization of the normalized workflow ---------------------------------------------

/** A `serde_json::Value` subtree as serde writes it: object keys in UTF-8 order at every level. */
function sortDeep(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isObject(value)) {
    const result = object();
    for (const key of sortedKeys(value)) result[key] = sortDeep(value[key]!);
    return result;
  }
  return value;
}

function mapObject<T>(entries: Map<string, T>, value: (item: T) => Json): JsonObject {
  const result = object();
  for (const key of [...entries.keys()].sort(compareKeys)) result[key] = value(entries.get(key)!);
  return result;
}

/** `serde_json::to_value(&node.config)`: every modelled key, with its default. */
export function configJson(config: NodeConfig): JsonObject {
  const result = object();
  result.operation = config.operation;
  result.expression = config.expression;
  result.branches = config.branches.map((branch) => ({ label: branch.label, when: branch.when }));
  result.join = config.join;
  result.aggregation = config.aggregation;
  result.teacherModel = config.teacherModel;
  result.feedbackMode = config.feedbackMode;
  result.workingDirectory = config.workingDirectory;
  result.body = [...config.body];
  result.exitCondition = config.exitCondition;
  result.maxIterations = config.maxIterations;
  result.onExhausted = config.onExhausted;
  result.carry = mapObject(config.carry, (item) => item);
  result.threshold = config.threshold === undefined ? null : new F64(config.threshold);
  result.members = [...config.members];
  result.execution = config.execution;
  result.exit = config.exit;
  result.router = config.router;
  result.defaultBranch = config.defaultBranch;
  result.entry = config.entry;
  result.exitNode = config.exitNode;
  result.subgraph = config.subgraph === undefined ? null : {
    ref: config.subgraph.ref,
    inputMap: mapObject(config.subgraph.inputMap, (item) => item),
    outputMap: mapObject(config.subgraph.outputMap, (item) => item),
    checkpointer: config.subgraph.checkpointer,
  };
  return result;
}

/** The normalized workflow in struct field order (what `sourceHash` digests). */
export function workflowJson(workflow: Workflow): JsonObject {
  return {
    apiVersion: workflow.apiVersion,
    kind: workflow.kind,
    metadata: { ...workflow.metadata },
    spec: {
      objective: workflow.spec.objective,
      inputs: mapObject(workflow.spec.inputs, sortDeep),
      outputs: mapObject(workflow.spec.outputs, sortDeep),
      policies: { ...workflow.spec.policies, requireApprovalFor: [...workflow.spec.policies.requireApprovalFor] },
      nodes: workflow.spec.nodes.map((node) => {
        const result: JsonObject = {
          id: node.id, kind: node.kind, name: node.name, templateRef: node.templateRef,
          inlineRole: node.inlineRole, summary: node.summary,
        };
        if (node.icon) result.icon = { ...node.icon };
        Object.assign(result, {
          role: node.role, prompt: node.prompt, inputSchema: sortDeep(node.inputSchema), outputSchema: sortDeep(node.outputSchema),
          contractRefs: node.contractRefs.map((contract) => ({ ref: contract.ref, usage: contract.usage })),
          formRefs: [...node.formRefs],
          capabilities: {
            skills: [...node.capabilities.skills], tools: [...node.capabilities.tools],
            connectors: [...node.capabilities.connectors], permissions: [...node.capabilities.permissions],
            customizations: mapObject(node.capabilities.customizations, (item) => ({ template: item.template, instructions: item.instructions })),
          },
          config: configJson(node.config),
          position: { x: new F64(node.position.x), y: new F64(node.position.y) },
        });
        return result;
      }),
      edges: workflow.spec.edges.map((edge) => ({ ...edge })),
    },
  };
}

// ---- Graph order ----------------------------------------------------------------------------

function sortedSet(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareKeys);
}

function topologicalOrder(workflow: Workflow): { order: string[]; cyclic: boolean; maxParallel: number } {
  const ids = new Set(workflow.spec.nodes.map((node) => node.id));
  const indegree = new Map<string, number>(sortedSet(ids).map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  const groups = new Map<string, WorkflowNode>();
  for (const node of workflow.spec.nodes) if (node.kind === "group") groups.set(node.id, node);
  const groupList = [...groups.keys()].sort(compareKeys).map((id) => groups.get(id)!);
  const scheduling: [string, string][] = [];
  for (const edge of workflow.spec.edges) {
    const group = groups.get(edge.from);
    if (group) {
      const members = group.config.members.filter((id) => ids.has(id));
      if (members.length === 0) scheduling.push([edge.from, edge.to]);
      else scheduling.push(...members.map((member): [string, string] => [member, edge.to]));
    } else {
      scheduling.push([edge.from, edge.to]);
    }
  }
  for (const group of groupList) {
    const members = group.config.members.filter((id) => ids.has(id));
    if (group.config.execution === "sequential") {
      if (members.length > 0) scheduling.push([group.id, members[0]!]);
      for (let index = 0; index + 1 < members.length; index += 1) scheduling.push([members[index]!, members[index + 1]!]);
    } else {
      scheduling.push(...members.map((member): [string, string] => [group.id, member]));
    }
  }
  const seen = new Set<string>();
  for (const [from, to] of scheduling) {
    const key = JSON.stringify([from, to]);
    if (ids.has(from) && ids.has(to) && !seen.has(key)) {
      seen.add(key);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
      outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
    }
  }
  for (const values of outgoing.values()) values.sort(compareKeys);
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  const order: string[] = [];
  let maxParallel = queue.length;
  while (queue.length > 0) {
    maxParallel = Math.max(maxParallel, queue.length);
    const id = queue.shift()!;
    order.push(id);
    for (const target of outgoing.get(id) ?? []) {
      const degree = indegree.get(target);
      if (degree !== undefined) {
        indegree.set(target, degree - 1);
        if (degree - 1 === 0) queue.push(target);
      }
    }
  }
  return { order, cyclic: order.length !== ids.size, maxParallel };
}

// ---- Validation -------------------------------------------------------------------------------

function validStatePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  return !path.split("/").slice(1).some((segment) => {
    for (let index = 0; index < segment.length; index += 1) {
      if (segment[index] === "~" && !["0", "1"].includes(segment[index + 1] ?? "")) return true;
    }
    return false;
  });
}

const ALLOWED_KINDS = new Set(["input", "output", "agent", "tool", "transform", "condition", "evaluate", "teacher", "approval", "join", "aggregator", "loop", "group", "subgraph"]);
const ALLOWED_TRANSFORMS = new Set(["select", "rename", "merge", "filter", "deduplicate", "sort", "slice"]);
const ALLOWED_AGGREGATIONS = new Set(["collect", "merge", "concat", "vote"]);
const ALLOWED_FEEDBACK_MODES = new Set(["critique", "score", "rubric"]);

function iconNameWellFormed(name: string): boolean {
  return name.length > 0 && name.length <= 64 && name.split("-").every((part) => /^[a-z0-9]+$/.test(part));
}

function validate(workflow: Workflow): { diagnostics: Diagnostic[]; order: string[]; stats: Stats } {
  const diagnostics: Diagnostic[] = [];
  const nodeDiag = (code: string, severity: Diagnostic["severity"], index: number, node: WorkflowNode, message: string): Diagnostic => {
    const result = diag(code, severity, `/spec/nodes/${index}`, message);
    result.nodeId = node.id;
    return result;
  };
  const push = (code: string, severity: Diagnostic["severity"], index: number, node: WorkflowNode, message: string) => {
    diagnostics.push(nodeDiag(code, severity, index, node, message));
  };
  const { nodes, edges } = workflow.spec;
  if (workflow.apiVersion !== API_VERSION) diagnostics.push(diag("LG100", "error", "/apiVersion", `Expected apiVersion ${API_VERSION}.`));
  if (workflow.kind !== "Workflow") diagnostics.push(diag("LG101", "error", "/kind", "kind must be Workflow."));
  if (!/^[a-z0-9-]+$/.test(workflow.metadata.name)) {
    diagnostics.push(diag("LG102", "error", "/metadata/name", "metadata.name must be a non-empty lowercase slug."));
  }
  if (workflow.spec.objective.trim() === "") {
    diagnostics.push(diag("LG103", "warning", "/spec/objective", "Add an objective so the generated workflow has a clear completion condition."));
  }
  if (nodes.length > 1_000) diagnostics.push(diag("LG104", "error", "/spec/nodes", "Workflows are limited to 1,000 nodes."));

  const ids = new Set<string>();
  let inputCount = 0;
  let outputCount = 0;
  nodes.forEach((node, index) => {
    if (ids.has(node.id)) push("LG110", "error", index, node, `Duplicate node id '${node.id}'.`);
    ids.add(node.id);
    if (!ALLOWED_KINDS.has(node.kind)) push("LG111", "error", index, node, `Unsupported node kind '${node.kind}'.`);
    if (node.kind === "input") inputCount += 1;
    if (node.kind === "output") outputCount += 1;
    if (["agent", "evaluate", "teacher"].includes(node.kind) && node.prompt.trim() === "") {
      push("LG112", "error", index, node, "Agent, evaluator, and teacher nodes require a prompt.");
    }
    if (node.kind === "agent" && node.role.trim() === "") {
      push("LG113", "warning", index, node, "Add a role to make this agent's responsibility explicit.");
    }
    if (node.icon) {
      // The icon catalog itself is not carried: a well-formed lucide name is accepted.
      if (node.kind !== "agent") push("LG198", "error", index, node, "Only agent nodes may define an icon override.");
      else if (node.icon.set !== "lucide" || !iconNameWellFormed(node.icon.name)) {
        push("LG199", "warning", index, node, "Agent icons must use the lucide set and a canonical kebab-case name; the generic agent icon will be shown.");
      }
    }
    if (node.kind === "tool" && node.capabilities.tools.length === 0) {
      push("LG114", "warning", index, node, "Tool requirement has no declared tool identifier.");
    }
    if (node.kind === "transform" && !ALLOWED_TRANSFORMS.has(node.config.operation)) {
      push("LG115", "error", index, node, "Transform operation must be select, rename, merge, filter, deduplicate, sort, or slice.");
    }
    if (node.kind === "teacher") {
      if (node.config.teacherModel.trim() === "") push("LG116", "error", index, node, "Teacher model requires a host-resolved teacherModel reference.");
      if (!ALLOWED_FEEDBACK_MODES.has(node.config.feedbackMode)) push("LG117", "error", index, node, "Teacher feedbackMode must be critique, score, or rubric.");
    }
    if (node.kind === "aggregator" && !ALLOWED_AGGREGATIONS.has(node.config.aggregation)) {
      push("LG118", "error", index, node, "Aggregation strategy must be collect, merge, concat, or vote.");
    }
    if (new Set(node.formRefs).size !== node.formRefs.length
      || node.formRefs.some((ref) => !ref.startsWith("ladder://forms/") || ref.length === "ladder://forms/".length)) {
      push("LG196", "error", index, node, "Attached forms must be unique, non-empty ladder://forms/ references.");
    }
    const contractRefs = node.contractRefs.map((contract) => contract.ref);
    const supportedUsages = ["human-interaction", "input", "output", "evidence"];
    const nonEmptyPrefix = (ref: string, prefix: string) => ref.startsWith(prefix) && ref.length > prefix.length;
    if (new Set(contractRefs).size !== node.contractRefs.length
      || node.contractRefs.some((contract) => !(nonEmptyPrefix(contract.ref, "ladder://forms/") || nonEmptyPrefix(contract.ref, "ladder://documents/"))
        || !supportedUsages.includes(contract.usage))
      || contractRefs.some((ref) => node.formRefs.includes(ref))) {
      push("LG197", "error", index, node, "Attached contracts must have unique ladder://forms/ or ladder://documents/ refs and a supported usage.");
    }
    if (node.kind === "condition") {
      if (node.config.branches.length === 0) push("LG160", "error", index, node, "Condition nodes require at least one declared branch token.");
      const tokens = new Set<string>();
      for (const branch of node.config.branches) {
        if (branch.label.trim() === "" || branch.when.trim() === "") {
          push("LG161", "error", index, node, "Condition branch labels and tokens must be non-empty.");
        } else if (tokens.has(branch.when)) {
          push("LG161", "error", index, node, `Condition branch token '${branch.when}' is duplicated.`);
        } else {
          tokens.add(branch.when);
        }
      }
      if (node.config.defaultBranch !== "" && !tokens.has(node.config.defaultBranch)) {
        push("LG162", "error", index, node, `defaultBranch '${node.config.defaultBranch}' must name a declared branch token.`);
      }
    }
    if (node.kind === "loop") {
      if (node.config.maxIterations === 0 || node.config.maxIterations > 100) {
        const result = nodeDiag("LG120", "error", index, node, "Loop maxIterations must be between 1 and 100.");
        result.fix = { label: "Set a safe three-iteration bound", path: `/spec/nodes/${index}/config/maxIterations`, value: 3 };
        diagnostics.push(result);
      }
      if (node.config.exitCondition.trim() === "") push("LG121", "error", index, node, "Loop requires an exitCondition referencing a condition or evaluator result.");
      if (node.config.body.length === 0) push("LG122", "error", index, node, "Loop body must reference at least one node.");
      const bodyIds = new Set<string>();
      for (const bodyId of node.config.body) {
        if (!nodes.some((candidate) => candidate.id === bodyId)) push("LG123", "error", index, node, `Loop body references missing node '${bodyId}'.`);
        // The loop's own id is refused without joining the body set.
        if (bodyId === node.id || bodyIds.has(bodyId)) push("LG170", "error", index, node, "Loop bodies cannot contain the loop node or duplicate member IDs.");
        else bodyIds.add(bodyId);
      }
      const entry = node.config.entry === "" ? node.config.body[0] : node.config.entry;
      const exit = node.config.exitNode === "" ? node.config.body[node.config.body.length - 1] : node.config.exitNode;
      if (entry !== undefined && !bodyIds.has(entry)) push("LG171", "error", index, node, "Loop entry must identify a node in the loop body.");
      if (exit !== undefined && !bodyIds.has(exit)) push("LG172", "error", index, node, "Loop exitNode must identify a node in the loop body.");
      for (const [slot, sourcePath] of node.config.carry) {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(slot)) {
          push("LG177", "error", index, node, `Loop carry slot '${slot}' must start with a letter and contain only letters, digits, underscores, or hyphens.`);
        }
        if (!validStatePath(sourcePath)) push("LG178", "error", index, node, `Loop carry source '${sourcePath}' must be a valid state JSON Pointer.`);
      }
    }
    if (node.kind !== "loop" && node.config.carry.size > 0) push("LG179", "error", index, node, "Loop carry state is valid only on loop nodes.");
    if (node.kind === "join" && !["all", "allSettled", "first"].includes(node.config.join)) {
      push("LG124", "error", index, node, "Join policy must be all, allSettled, or first.");
    }
    if (node.kind === "group") {
      if (node.config.members.length === 0) push("LG125", "warning", index, node, "Group has no member nodes yet.");
      if (!["sequential", "parallel"].includes(node.config.execution)) push("LG126", "error", index, node, "Group execution must be sequential or parallel.");
      if (!["aggregate", "serialize"].includes(node.config.exit)) push("LG127", "error", index, node, "Group exit must aggregate or serialize member outputs.");
      if (new Set(node.config.members).size !== node.config.members.length) push("LG128", "error", index, node, "Group member IDs must be unique.");
      for (const memberId of node.config.members) {
        const member = nodes.find((candidate) => candidate.id === memberId);
        if (!member) push("LG129", "error", index, node, `Group references missing member '${memberId}'.`);
        else if (member.id === node.id || member.kind === "group") push("LG132", "error", index, node, "Groups cannot contain themselves or another group.");
      }
    }
    if (node.kind === "subgraph") {
      const subgraph = node.config.subgraph;
      if (!subgraph) {
        push("LG190", "warning", index, node, "Subgraph has no executable ref or parent/child state mapping.");
      } else {
        const validRef = (subgraph.ref.startsWith("ladder://") && subgraph.ref.length > "ladder://".length)
          || (subgraph.ref.startsWith("host:") && subgraph.ref.length > "host:".length);
        if (!validRef) push("LG191", "error", index, node, "Subgraph ref must be a non-empty ladder:// or host: reference.");
        if (subgraph.inputMap.size === 0) push("LG192", "error", index, node, "Subgraph inputMap must map at least one child input to a parent state path.");
        if (subgraph.outputMap.size === 0) push("LG193", "error", index, node, "Subgraph outputMap must map at least one child output to a parent state path.");
        if ([...subgraph.inputMap.values(), ...subgraph.outputMap.values()].some((path) => !validStatePath(path))) {
          push("LG194", "error", index, node, "Subgraph state mappings must use valid JSON Pointer paths.");
        }
        if (!["inherit", "perInvocation", "perThread", "stateless"].includes(subgraph.checkpointer)) {
          push("LG195", "error", index, node, "Subgraph checkpointer must be inherit, perInvocation, perThread, or stateless.");
        }
      }
    }
  });
  if (inputCount === 0) diagnostics.push(diag("LG130", "warning", "/spec/nodes", "Workflow has no input node."));
  if (outputCount === 0) {
    const terminalAgent = nodes.some((node) => node.kind === "agent" && !edges.some((edge) => edge.from === node.id));
    diagnostics.push(diag("LG131", terminalAgent ? "warning" : "error", "/spec/nodes", terminalAgent
      ? "Workflow uses its terminal agent as the implicit output."
      : "Workflow requires an output or terminal agent node."));
  }

  const known = new Set(nodes.map((node) => node.id));
  const membership = new Map<string, string>();
  for (const group of nodes.filter((node) => node.kind === "group")) {
    for (const memberId of group.config.members) {
      const existing = membership.get(memberId);
      membership.set(memberId, group.id);
      if (existing !== undefined && existing !== group.id) {
        diagnostics.push(diag("LG133", "error", "/spec/nodes", `Node '${memberId}' belongs to more than one group.`));
      }
    }
  }
  const edgeIds = new Set<string>();
  edges.forEach((edge, index) => {
    const edgeError = (code: string, message: string) => {
      const result = diag(code, "error", `/spec/edges/${index}`, message);
      result.edgeId = edge.id;
      diagnostics.push(result);
    };
    if (edgeIds.has(edge.id)) edgeError("LG140", `Duplicate edge id '${edge.id}'.`);
    edgeIds.add(edge.id);
    if (!known.has(edge.from)) edgeError("LG141", `Edge source '${edge.from}' does not exist.`);
    if (!known.has(edge.to)) edgeError("LG142", `Edge target '${edge.to}' does not exist.`);
    if (!["data", "dependency", "control"].includes(edge.kind)) edgeError("LG143", `Unsupported edge kind '${edge.kind}'.`);
    if (edge.from === edge.to) edgeError("LG144", "Self edges are not allowed; use a structured loop node.");
    const hasSource = edge.sourcePath !== "";
    const hasTarget = edge.targetPath !== "";
    if (hasSource !== hasTarget) edgeError("LG183", "Data mappings require both sourcePath and targetPath.");
    if ((hasSource && !validStatePath(edge.sourcePath)) || (hasTarget && !validStatePath(edge.targetPath))) {
      edgeError("LG184", "sourcePath and targetPath must be valid JSON Pointer paths.");
    }
    if ((hasSource || hasTarget) && edge.kind !== "data") edgeError("LG185", "Only data edges can declare sourcePath and targetPath.");
    if (edge.kind === "control" && edge.condition.trim() === "") edgeError("LG186", "Control edges require a non-empty branch token in condition.");
    const sourceGroup = membership.get(edge.from);
    const targetGroup = membership.get(edge.to);
    if (sourceGroup !== undefined && sourceGroup !== targetGroup) {
      diagnostics.push(diag("LG145", "warning", `/spec/edges/${index}`, `Route member '${edge.from}' output through group '${sourceGroup}' before crossing its boundary.`));
    }
    if (targetGroup !== undefined && sourceGroup !== targetGroup) {
      diagnostics.push(diag("LG146", "warning", `/spec/edges/${index}`, `Route external input through group '${targetGroup}' instead of directly to member '${edge.to}'.`));
    }
  });
  const mappedTargets = new Set<string>();
  edges.forEach((edge, index) => {
    if (edge.kind !== "data" || edge.targetPath === "") return;
    const key = JSON.stringify([edge.to, edge.targetPath]);
    if (mappedTargets.has(key)) {
      const result = diag("LG187", "error", `/spec/edges/${index}`, `Multiple data edges map to targetPath '${edge.targetPath}' on node '${edge.to}'.`);
      result.edgeId = edge.id;
      diagnostics.push(result);
    }
    mappedTargets.add(key);
  });
  nodes.forEach((node, index) => {
    if (node.kind !== "condition") return;
    const branchTokens = sortedSet(node.config.branches.map((branch) => branch.when));
    const outgoing = edges.filter((edge) => edge.from === node.id && edge.kind === "control");
    if (outgoing.length === 0) push("LG165", "error", index, node, "Condition requires at least one outgoing control edge.");
    const outgoingTokens = new Set(outgoing.map((edge) => edge.condition));
    for (const edge of outgoing) {
      if (!branchTokens.includes(edge.condition)) {
        const result = nodeDiag("LG163", "error", index, node, `Control edge '${edge.id}' uses undeclared branch token '${edge.condition}'.`);
        result.edgeId = edge.id;
        diagnostics.push(result);
      }
    }
    for (const token of branchTokens.filter((token) => !outgoingTokens.has(token))) {
      push("LG164", "warning", index, node, `Declared branch token '${token}' has no outgoing control edge.`);
    }
  });
  nodes.forEach((node, index) => {
    if (node.kind !== "loop") return;
    const outgoing = edges.filter((edge) => edge.from === node.id);
    if (outgoing.length === 0) push("LG173", "error", index, node, "Loop requires at least one outgoing exit edge.");
    else if (!outgoing.some((edge) => edge.condition === "loop_exit")) {
      push("LG174", "warning", index, node, "Loop exit edges should use the canonical 'loop_exit' condition token.");
    }
    const exhausted = outgoing.some((edge) => edge.condition === "loop_exhausted");
    if (["continue", "warn"].includes(node.config.onExhausted) && !exhausted) {
      push("LG175", "error", index, node, "continue and warn exhaustion policies require a 'loop_exhausted' outgoing edge.");
    }
    if (node.config.onExhausted === "stop" && exhausted) push("LG176", "warning", index, node, "A stop exhaustion policy never follows a 'loop_exhausted' edge.");
  });
  nodes.forEach((node, index) => {
    if (node.kind !== "join") return;
    const inbound = edges.filter((edge) => edge.to === node.id && known.has(edge.from)).length;
    const outbound = edges.filter((edge) => edge.from === node.id && known.has(edge.to)).length;
    if (inbound < 2) push("LG180", "error", index, node, "Join nodes require at least two distinct upstream edges.");
    if (outbound === 0) push("LG181", "error", index, node, "Join nodes require at least one downstream edge.");
  });
  nodes.forEach((node, index) => {
    if (node.kind !== "aggregator") return;
    const inbound = edges.filter((edge) => edge.to === node.id && known.has(edge.from)).length;
    if (inbound < 2) push("LG134", "warning", index, node, "Aggregator should receive outputs from at least two nodes.");
  });
  const { order, cyclic, maxParallel } = topologicalOrder(workflow);
  if (cyclic) {
    diagnostics.push(diag("LG150", "error", "/spec/edges", "Arbitrary cycles are not allowed. Place repeated work inside a structured loop node."));
  }
  const stats: Stats = {
    nodes: nodes.length,
    edges: edges.length,
    agents: nodes.filter((node) => ["agent", "evaluate", "teacher"].includes(node.kind)).length,
    loops: nodes.filter((node) => node.kind === "loop").length,
    maxParallelism: maxParallel,
  };
  return { diagnostics, order, stats };
}

/** `lgir_core::analyze(source, None)` over the document the source serializes. */
export function analyze(document: Json): AnalysisResult {
  const failed = (error: Diagnostic): AnalysisResult => ({
    ok: false, sourceHash: "", diagnostics: [error], normalized: undefined, nodeOrder: [],
    stats: { nodes: 0, edges: 0, agents: 0, loops: 0, maxParallelism: 0 },
  });
  const refusal = textualRefusal(document);
  if (refusal) return failed(refusal);
  let workflow: Workflow;
  try {
    workflow = parseWorkflow(document);
  } catch (error) {
    if (error instanceof ParseError) return failed(diag("LG003", "error", "/", `YAML could not be parsed: ${error.message}`));
    throw error;
  }
  const sourceHash = sha256Hex(stringify(workflowJson(workflow), false));
  const { diagnostics, order, stats } = validate(workflow);
  return {
    ok: !diagnostics.some((item) => item.severity === "error"),
    sourceHash,
    diagnostics,
    normalized: workflow,
    nodeOrder: order,
    stats,
  };
}

function diagnosticJson(item: Diagnostic): JsonObject {
  const result: JsonObject = { code: item.code, severity: item.severity, path: item.path };
  if (item.nodeId !== undefined) result.nodeId = item.nodeId;
  if (item.edgeId !== undefined) result.edgeId = item.edgeId;
  result.message = item.message;
  if (item.capability !== undefined) result.capability = item.capability;
  if (item.fix !== undefined) result.fix = { label: item.fix.label, path: item.fix.path, value: item.fix.value };
  return result;
}

export function diagnosticsJson(items: Diagnostic[]): Json {
  return items.map(diagnosticJson);
}

/** The analysis report `validate` prints, in the original struct field order. */
export function analysisReport(result: AnalysisResult): string {
  return stringifyPretty({
    ok: result.ok,
    sourceHash: result.sourceHash,
    diagnostics: diagnosticsJson(result.diagnostics),
    normalized: result.normalized ? workflowJson(result.normalized) : null,
    nodeOrder: [...result.nodeOrder],
    stats: { ...result.stats },
  }, false);
}
