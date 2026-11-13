import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { stableDigest } from "@ehf/contracts";

/**
 * A stand-in capability gateway for the conformance suite. It accepts only envelopes the suite
 * issued (unsigned, so they are useless anywhere else), enforces their narrowed capability list
 * and the `<execution_id>:<key>` invocation-id rule, returns programmed outputs with a receipt
 * digest, and records every call so the suite can see what the host did.
 */
export type FakeGatewayCall = {
  executionId: string | null;
  invocationId: string;
  capabilityId: string;
  effect: string;
  input: unknown;
  allowed: boolean;
  workloadAuthorization: boolean;
};

export type FakeEnvelopeInput = {
  executionId: string;
  tenantId: string;
  caseId: string | null;
  skillId: string;
  skillVersion: string;
  capabilities: string[];
  /** Epoch seconds. */
  expiresAt: number;
  /** Defaults to `skills:<skillId>@<skillVersion>`; set to test a delegated-elsewhere envelope. */
  delegatedTo?: string;
};

export type FakeGateway = {
  url: string;
  calls: FakeGatewayCall[];
  issueEnvelope(input: FakeEnvelopeInput): string;
  /** The output the next calls of one execution to one capability return. */
  program(executionId: string, capabilityId: string, output: unknown): void;
  callsFor(executionId: string): FakeGatewayCall[];
  close(): Promise<void>;
};

type Issued = FakeEnvelopeInput & { jti: string };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error("body_too_large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startFakeGateway(options: {
  host?: string;
  port?: number;
  /** The URL the skill host must use to reach this gateway, if not the listening address. */
  publicUrl?: string;
  /** Default output per capability when nothing is programmed. */
  defaultOutputs?: Record<string, unknown>;
  /** When set, calls must also carry `Authorization: Bearer <workloadToken>` (the host's own identity). */
  workloadToken?: string;
} = {}): Promise<FakeGateway> {
  const envelopes = new Map<string, Issued>();
  const programmed = new Map<string, unknown>();
  const receipts = new Map<string, unknown>();
  const calls: FakeGatewayCall[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/invoke") return send(response, 404, { error: "not_found" });
      let body: Record<string, unknown>;
      try {
        body = await readBody(request) as Record<string, unknown>;
      } catch {
        return send(response, 400, { error: "gateway.request_invalid" });
      }
      const token = String(request.headers["x-execution-envelope"] ?? "");
      const envelope = envelopes.get(token);
      const invocationId = typeof body.invocationId === "string" ? body.invocationId : "";
      const capabilityId = typeof body.capabilityId === "string" ? body.capabilityId : "";
      const workloadAuthorization = !options.workloadToken || request.headers.authorization === `Bearer ${options.workloadToken}`;
      const call: FakeGatewayCall = {
        executionId: envelope?.executionId ?? null, invocationId, capabilityId, effect: String(body.effect ?? ""), input: body.input ?? null,
        allowed: false, workloadAuthorization,
      };
      calls.push(call);
      if (!workloadAuthorization) return send(response, 401, { error: "authorization.principal_unauthenticated" });
      if (!envelope || envelope.expiresAt * 1000 <= Date.now()) return send(response, 403, { error: "gateway.execution_envelope_invalid" });
      if (!envelope.capabilities.includes(capabilityId)) return send(response, 403, { error: "gateway.capability_denied" });
      const prefix = `${envelope.executionId}:`;
      if (!invocationId.startsWith(prefix) || !/^[A-Za-z0-9._~-]{1,128}$/.test(invocationId.slice(prefix.length))) {
        return send(response, 403, { error: "gateway.invocation_mismatch" });
      }
      call.allowed = true;
      const replay = receipts.get(invocationId);
      if (replay) return send(response, 200, replay);
      const output = programmed.get(`${envelope.executionId}\u0000${capabilityId}`) ?? options.defaultOutputs?.[capabilityId] ?? { found: true, active: true };
      const unsigned = {
        invocationId, capabilityId, status: "succeeded", output, errorCode: null, provider: "conformance-fake-gateway",
        model: capabilityId, providerRequestId: null, usage: { inputTokens: null, outputTokens: null, costUsd: null }, latencyMs: 0,
      };
      const result = { ...unsigned, receiptDigest: stableDigest(unsigned) };
      receipts.set(invocationId, result);
      return send(response, 200, result);
    })().catch(() => send(response, 500, { error: "gateway.internal_error" }));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const url = options.publicUrl ?? `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`;
  return {
    url,
    calls,
    issueEnvelope(input) {
      const now = Math.floor(Date.now() / 1000);
      const jti = `dlg:${input.executionId}`;
      const claims = {
        iss: "ehf-runtime", aud: "ehf-capability-gateway", jti, iat: now, exp: input.expiresAt,
        tenant_id: input.tenantId, case_id: input.caseId, run_id: "conformance-run", node_id: "conformance-node", attempt: 1,
        plan_digest: "0".repeat(64), permission_digest: "0".repeat(64), capabilities: input.capabilities, effects: ["read"],
        case_writes: [], case_reads: [], case_read_policies: [], fencing_epoch: 1,
        delegated_to: input.delegatedTo ?? `skills:${input.skillId}@${input.skillVersion}`, parent_jti: input.executionId,
      };
      const signature = createHash("sha256").update(`${jti}:${Math.random()}`).digest("base64url");
      const token = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.${signature}`;
      envelopes.set(token, { ...input, jti });
      return token;
    },
    program(executionId, capabilityId, output) {
      programmed.set(`${executionId}\u0000${capabilityId}`, output);
    },
    callsFor(executionId) {
      return calls.filter((call) => call.executionId === executionId || call.invocationId.startsWith(`${executionId}:`));
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
