import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic's Messages API for a model profile whose provider binding is `kind: "anthropic"`,
 * through the official SDK. It is one reasoning transport among the others (OpenRouter, an
 * OpenAI-compatible endpoint): the same profile, prompt and output rules, a different wire.
 *
 * Only what the caller passes is used. The SDK would otherwise read `ANTHROPIC_BASE_URL`,
 * `ANTHROPIC_API_KEY` or a stored sign-in from the process environment, and a platform
 * process must never reach a provider with credentials its administered binding did not name.
 *
 * There is no automatic fallback to another model on a refusal: a profile pins one model, and
 * an answer from a different one would not be the qualified agent. A refusal or a truncated
 * answer is an error, which the runtime treats like any other failed model call.
 */
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

export type AnthropicCall = {
  signal?: AbortSignal;
  apiKey: string;
  baseUrl?: string | null;
  fetch?: typeof globalThis.fetch;
  model: string;
  prompt: string;
  /** The answer's JSON Schema. Sent as a structured-output format when Claude can enforce it. */
  schema?: Record<string, unknown> | null;
  maxOutputTokens: number;
  timeoutMs: number;
};

export type AnthropicAnswer = {
  text: string;
  /** The parsed answer when the call used a structured-output format. */
  object: unknown;
  structured: boolean;
  responseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

export async function anthropicGenerate(call: AnthropicCall, client?: Pick<Anthropic, "messages">): Promise<AnthropicAnswer> {
  call.signal?.throwIfAborted();
  const messages = client?.messages ?? new Anthropic({
    apiKey: call.apiKey,
    authToken: null,
    baseURL: call.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
    timeout: call.timeoutMs,
    maxRetries: 2,
    ...(call.fetch ? { fetch: call.fetch } : {}),
  }).messages;
  const format = call.schema ? anthropicOutputSchema(call.schema) : null;
  const prompt = call.schema && !format ? withSchemaInstruction(call.prompt, call.schema) : call.prompt;
  // Streamed and collected: thinking counts toward max_tokens, and a large budget sent without
  // streaming can outlast the HTTP request.
  const response = await messages.stream({
    model: call.model,
    max_tokens: call.maxOutputTokens,
    messages: [{ role: "user", content: prompt }],
    ...(format ? { output_config: { format: { type: "json_schema" as const, schema: format } } } : {}),
  }, { ...(call.signal ? { signal: call.signal } : {}) }).finalMessage();
  if (response.stop_reason === "refusal") throw new Error("adapter.model_refused");
  if (response.stop_reason === "max_tokens") throw new Error("adapter.model_output_truncated");
  const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  let object: unknown;
  if (format) {
    try { object = JSON.parse(text); } catch { throw new Error("adapter.model_output_not_json"); }
  }
  return {
    text, object, structured: Boolean(format),
    responseId: response.id ?? null,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
  };
}

/** Keywords Claude's structured outputs do not enforce; the platform validates them afterwards. */
const DROPPED = new Set([
  "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "maxItems", "uniqueItems", "minProperties", "maxProperties", "$schema", "$id", "examples", "default",
]);
/** Keywords that change what is valid in a way the supported subset cannot express. */
const UNSUPPORTED = new Set(["not", "if", "then", "else", "patternProperties", "dependentRequired", "dependentSchemas", "propertyNames", "contains", "prefixItems", "unevaluatedProperties"]);
const UNSUPPORTED_MARK = Symbol("unsupported");
const FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/**
 * The part of a general JSON Schema that Claude's structured outputs enforce, or null when the
 * schema needs something outside that subset (an open map, an empty "any value" schema, `not`, ...), in which case
 * the call asks for JSON in the prompt instead. Either way the platform validates the answer
 * against the full schema; this only decides what the model is constrained to produce.
 *
 * Every object is closed (`additionalProperties: false`, which Claude requires): the model may
 * produce only declared properties, never fewer than are required.
 */
export function anthropicOutputSchema(schema: Record<string, unknown>): Record<string, unknown> | null {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const items = node.map(visit);
      return items.includes(UNSUPPORTED_MARK) ? UNSUPPORTED_MARK : items;
    }
    if (!node || typeof node !== "object") return node;
    const source = node as Record<string, unknown>;
    // An empty schema (any JSON value) has no concrete type to constrain the model to.
    if (!Object.keys(source).length) return UNSUPPORTED_MARK;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (UNSUPPORTED.has(key)) return UNSUPPORTED_MARK;
      if (DROPPED.has(key)) continue;
      if (key === "format" && (typeof value !== "string" || !FORMATS.has(value))) continue;
      if (key === "minItems") { if (value === 0 || value === 1) out[key] = value; continue; }
      if (key === "additionalProperties") {
        if (value === false) continue;
        // An open map (a schema for extra keys) or explicit `true` with no declared properties
        // cannot be closed without changing its meaning.
        if (typeof value === "object" || !source.properties) return UNSUPPORTED_MARK;
        continue;
      }
      if (key === "$defs" || key === "definitions") {
        if (!value || typeof value !== "object" || Array.isArray(value)) return UNSUPPORTED_MARK;
        const definitions: Record<string, unknown> = {};
        for (const [name, definition] of Object.entries(value as Record<string, unknown>)) {
          const visited = visit(definition);
          if (visited === UNSUPPORTED_MARK) return UNSUPPORTED_MARK;
          definitions[name] = visited;
        }
        out[key] = definitions;
        continue;
      }
      if (key === "properties") {
        if (!value || typeof value !== "object" || Array.isArray(value)) return UNSUPPORTED_MARK;
        const properties: Record<string, unknown> = {};
        for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
          const visited = visit(property);
          if (visited === UNSUPPORTED_MARK) return UNSUPPORTED_MARK;
          properties[name] = visited;
        }
        out.properties = properties;
        continue;
      }
      const visited = key === "enum" || key === "const" || key === "required" ? value : visit(value);
      if (visited === UNSUPPORTED_MARK) return UNSUPPORTED_MARK;
      out[key === "oneOf" ? "anyOf" : key] = visited;
    }
    const isObject = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object")) || "properties" in out;
    if (isObject) {
      if (!out.properties) return UNSUPPORTED_MARK;
      out.additionalProperties = false;
    }
    return out;
  };
  const result = visit(schema);
  return result === UNSUPPORTED_MARK ? null : result as Record<string, unknown>;
}

/** The prompt for a schema the provider cannot enforce: the schema goes in the request as text. */
export function withSchemaInstruction(prompt: string, schema: Record<string, unknown>): string {
  return `${prompt}\n\nReturn only one JSON object, with no prose and no code fence, that satisfies this JSON Schema:\n${JSON.stringify(schema)}`;
}
