// Document Model Factory, Phase 0 baseline: run the existing LLM extraction route over a dataset
// version's sealed test requests and write one prediction per sample for the factory scorer.
//
//   python -m document_factory.cli baseline-requests --type passport --dataset v.json --dir data --out requests.jsonl
//   NODE_USE_ENV_PROXY=1 node --import tsx scripts/document-factory-baseline.ts --requests requests.jsonl \
//     --out predictions.jsonl [--profiles config/model-profiles.json] [--profile model.document.v1] [--concurrency 2]
//   python -m document_factory.cli evaluate --type passport --dataset v.json --dir data --predictions predictions.jsonl \
//     --route llm --run-id <id> --model-profile model.document.v1 --model-profile-digest <digest printed here> --out report.json
//
// The requests come from the skill host's own builder (kyc_document_studio.prepare), and each call goes
// through the platform's document.fields connector (@ehf/adapters invokeDocumentFieldsModel): the
// same prompt, schema, structured-output path and answer binding as Document Studio and case runs.
// Nothing here writes to a case. A failed call is recorded as a failed prediction, which the scorer
// counts as an abstention; it is never retried until it succeeds or replaced with a canned answer.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { invokeDocumentFieldsModel, loadModelProfiles } from "../packages/adapters/src/index.js";

const repo = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1]! : fallback; };
const requestsPath = arg("requests") ?? (() => { throw new Error("--requests is required"); })();
const outPath = arg("out") ?? (() => { throw new Error("--out is required"); })();
const profiles = await loadModelProfiles(resolve(repo, arg("profiles", "config/model-profiles.json")!));
const profileId = arg("profile", "model.document.v1")!;
const profile = profiles.find(item => item.id === profileId) ?? (() => { throw new Error(`unknown model profile ${profileId}`); })();
const concurrency = Math.max(1, Math.min(8, Number(arg("concurrency", "2"))));
if (profile.provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for an anthropic profile");
// openrouter.ai credentials may be injected by an egress proxy; the adapter still needs a non-empty key.
const apiKey = profile.provider === "anthropic" ? process.env.ANTHROPIC_API_KEY! : process.env.OPENROUTER_API_KEY ?? "proxy-injected";
const providerBinding = { kind: profile.provider === "anthropic" ? "anthropic" as const : "openrouter" as const,
  baseUrl: null, siteUrl: null, appName: null, status: "active" as const };

type RequestLine = { sample_id: string; document_type: string; request: Record<string, unknown> };
const lines: RequestLine[] = readFileSync(requestsPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])) : value;
const profileDigest = createHash("sha256").update(JSON.stringify(sorted(profile))).digest("hex");

const results: string[] = new Array(lines.length);
let next = 0;
async function worker() {
  while (next < lines.length) {
    const index = next++;
    const line = lines[index]!;
    const started = performance.now();
    try {
      const answer = await invokeDocumentFieldsModel({ profile, input: line.request, apiKey, providerBinding });
      results[index] = JSON.stringify({ sample_id: line.sample_id, route: "llm", status: "completed", result: answer.output,
        latency_ms: Math.round(performance.now() - started), cost_usd: answer.costUsd ?? null });
    } catch (error) {
      // Keep enough to diagnose without storing model text: the error's first phrase, and for the AI SDK's
      // NoObjectGeneratedError its finish reason ("length" means the output-token limit cut the answer off).
      const code = error instanceof Error ? error.message.split(":")[0]!.slice(0, 120) : "unknown_error";
      const detail = error && typeof error === "object" ? error as { finishReason?: unknown; usage?: { outputTokens?: unknown } } : {};
      const finish = typeof detail.finishReason === "string" ? `;finish=${detail.finishReason}` : "";
      const tokens = typeof detail.usage?.outputTokens === "number" ? `;output_tokens=${detail.usage.outputTokens}` : "";
      results[index] = JSON.stringify({ sample_id: line.sample_id, route: "llm", status: "failed", error_code: (code + finish + tokens).slice(0, 200),
        latency_ms: Math.round(performance.now() - started) });
    }
    process.stderr.write(`${index + 1}/${lines.length} ${JSON.parse(results[index]!).status}\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, lines.length) }, worker));
writeFileSync(outPath, results.join("\n") + "\n");
const failed = results.filter(result => JSON.parse(result).status !== "completed").length;
console.log(JSON.stringify({ predictions: results.length, failed, profile: profile.id, model: profile.model, profileDigest }));
