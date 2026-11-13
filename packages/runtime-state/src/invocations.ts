import { runtimeInvocationResultSchema, type RuntimeInvocationAnyVersion, type RuntimeInvocationResult, stableDigest } from "@ehf/contracts";
import type { WorkloadCredential } from "./index.js";
import { z } from 'zod';

export type InvocationRecord = {
  invocationId: string; runId: string; requestDigest: string; executionProfileDigest: string;
  state: "running" | "completed" | "failed" | "cancelled";
  cancellationRequested: boolean; result: RuntimeInvocationResult | null;
};
export interface InvocationStore {
  claim(request: RuntimeInvocationAnyVersion): Promise<{ created: boolean; record: InvocationRecord }>;
  read(id: string): Promise<InvocationRecord | null>;
  cancel(id: string): Promise<boolean>;
  complete(request: RuntimeInvocationAnyVersion, result: RuntimeInvocationResult): Promise<void>;
}
const invocationRecordSchema=z.object({invocationId:z.string(),runId:z.string(),requestDigest:z.string(),executionProfileDigest:z.string(),
  state:z.enum(['running','completed','failed','cancelled']),cancellationRequested:z.boolean(),result:runtimeInvocationResultSchema.nullable()}).strict();
export function invocationRequestDigest(request: RuntimeInvocationAnyVersion): string {
  const { executionGrant: _transientCredential, ...content } = request;
  return stableDigest(content);
}

/** Authority remains in the control plane; runtimes receive no SQL credentials. */
export class HttpInvocationStore implements InvocationStore {
  constructor(private readonly options: { baseUrl: string; credential: WorkloadCredential; fetch?: typeof globalThis.fetch }) {}
  private async rpc(body: unknown): Promise<unknown> {
    const token = typeof this.options.credential === "string" ? this.options.credential : await this.options.credential();
    const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl}/v1/runtime/invocation-store`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (!response.ok) throw new Error(`runtime_invocations.http_${response.status}`);
    return response.json();
  }
  async claim(request: RuntimeInvocationAnyVersion) { return z.object({created:z.boolean(),record:invocationRecordSchema}).strict().parse(await this.rpc({ operation: "claim", request })); }
  async read(id: string) { return invocationRecordSchema.nullable().parse(await this.rpc({ operation: "read", invocationId: id })); }
  async cancel(id: string) { return z.boolean().parse(await this.rpc({ operation: "cancel", invocationId: id })); }
  async complete(request: RuntimeInvocationAnyVersion, result: RuntimeInvocationResult) {
    await this.rpc({ operation: "complete", request, result: runtimeInvocationResultSchema.parse(result) });
  }
}
