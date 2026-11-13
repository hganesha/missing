/**
 * Prompt and output rules every model-shaped adapter shares, so a model reached through
 * OpenRouter, an OpenAI-compatible endpoint or a Databricks serving endpoint sees the same
 * prompt for the same input and its answer is read the same way.
 */

/**
 * The prompt for one capability input.
 *
 * A context-plane prompt (one carrying `contextPackDigest`) is complete: it already carries
 * instructions and the fenced, trust-labelled context, so it is passed as-is. Appending the
 * raw input would re-introduce the same data without its labels.
 */
export function promptFor(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.contextPackDigest === "string" && typeof record.prompt === "string") return record.prompt;
    const instruction = typeof record.prompt === "string" ? record.prompt : "Analyze the structured input.";
    return `${instruction}\n\nReturn only a JSON object.\n\nInput:\n${JSON.stringify(record.input ?? input)}`;
  }
  return `Analyze the input and return only a JSON object.\n\nInput:\n${String(input)}`;
}

/** A model's text answer as JSON when it is JSON (optionally fenced), else `{ text }`. */
export function parseModelOutput(text: string): unknown {
  // Fence stripping by slicing: /\s*```$/ backtracks polynomially on long whitespace runs.
  let cleaned = text.trim();
  const opening = /^```(?:json)?/i.exec(cleaned);
  if (opening) cleaned = cleaned.slice(opening[0].length).trimStart();
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3).trimEnd();
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    return { text: text.trim() };
  }
}
