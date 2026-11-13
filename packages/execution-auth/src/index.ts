import { SignJWT, importJWK, importPKCS8, importSPKI, jwtVerify } from "jose";
import {
  executionEnvelopeClaimsSchema,
  integrationEnvelopeClaimsSchema,
  runtimeGrantClaimsSchema,
  type BusinessCommandType,
  type CaseReadGrant,
  type ContextClassificationPolicy,
  type EffectClass,
  type ExecutionEnvelopeClaims,
  type IntegrationEnvelopeClaims,
  type IntegrationIntent,
  type RuntimeGrantClaims,
} from "@ehf/contracts";

const ISSUER = "ehf-runtime";
const AUDIENCE = "ehf-capability-gateway";
const GRANT_ISSUER = "ehf-dispatcher";
const GRANT_AUDIENCE = "ehf-envelope-broker";
const INTEGRATION_ISSUER = "ehf-integration-control";
const INTEGRATION_AUDIENCE = "ehf-case-api";

/** Short-lived proof binding a wiring submission to the gateway's exact approved decision and bytes. */
export async function mintSourceAuthorizationProof(input: {
  secret: string; tenantId: string; operationId: string; requestDigest: string; decisionId: string;
  expiresAt: string; scope: Record<string, unknown>;
}): Promise<string> {
  const material = await signingMaterial(input.secret);
  const now = Math.floor(Date.now() / 1000);
  const expires = Math.min(now + 60, Math.floor(Date.parse(input.expiresAt) / 1000));
  if (expires <= now || !/^[a-f0-9]{64}$/.test(input.requestDigest)) throw new Error("source_policy.proof_scope_invalid");
  return new SignJWT({ tenant_id: input.tenantId, operation_id: input.operationId, request_digest: input.requestDigest,
    decision_id: input.decisionId, scope: input.scope }).setProtectedHeader({ alg: material.algorithm, typ: "JWT" })
    .setIssuer("ehf-source-policy").setAudience("ehf-kyc-wiring").setIssuedAt(now).setExpirationTime(expires).sign(material.key);
}

function key(secret: string): Uint8Array {
  if (secret.length < 24) throw new Error("execution_auth.secret_too_short");
  return new TextEncoder().encode(secret);
}

async function signingMaterial(value: string) {
  if (value.includes("BEGIN PRIVATE KEY")) return { algorithm: "RS256" as const, key: await importPKCS8(value, "RS256") };
  return { algorithm: "HS256" as const, key: key(value) };
}

async function verificationMaterial(value: string) {
  if (value.trim().startsWith("{")) return { algorithms: ["RS256"] as const, key: await importJWK(JSON.parse(value), "RS256") };
  if (value.includes("BEGIN PUBLIC KEY")) return { algorithms: ["RS256"] as const, key: await importSPKI(value, "RS256") };
  return { algorithms: ["HS256"] as const, key: key(value) };
}

export type MintEnvelopeInput = {
  tenantId: string;
  caseId: string | null;
  workItemId?: string;
  workFencingEpoch?: number;
  secret?: string;
  signer?: JwtSigner;
  invocationId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  planDigest: string;
  permissionDigest: string;
  capabilities: string[];
  effects: EffectClass[];
  caseWrites?: BusinessCommandType[];
  /** Commands the node may only hold or release (skill effects awaiting approval); emitted only when non-empty. */
  caseWritesHeld?: BusinessCommandType[];
  /** The node shows a model a context pack; its agent commands must cite it. */
  contextRequired?: boolean;
  caseReads?: CaseReadGrant[];
  caseReadPolicies?: ContextClassificationPolicy[];
  fencingEpoch: number;
  ttlSeconds?: number;
};

export type JwtSigner = {
  algorithm: "RS256";
  keyId: string;
  sign(input: Uint8Array): Promise<Uint8Array>;
};

async function signWithRemoteKey(payload: Record<string, unknown>, signer: JwtSigner, input: {
  issuer: string; audience: string; id: string; ttlSeconds: number; expiresAt?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: signer.algorithm, typ: "JWT", kid: signer.keyId })).toString("base64url");
  const exp = input.expiresAt ?? now + input.ttlSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, iss: input.issuer, aud: input.audience, jti: input.id, iat: now, exp })).toString("base64url");
  const signingInput = `${header}.${body}`;
  const signature = await signer.sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

export async function mintExecutionEnvelope(input: MintEnvelopeInput): Promise<string> {
  const ttl = Math.min(120, Math.max(5, input.ttlSeconds ?? 60));
  const claims = {
    tenant_id: input.tenantId, case_id: input.caseId,
    ...(input.workItemId ? { work_item_id: input.workItemId, work_fencing_epoch: input.workFencingEpoch } : {}),
    run_id: input.runId, node_id: input.nodeId, attempt: input.attempt, plan_digest: input.planDigest,
    permission_digest: input.permissionDigest, capabilities: input.capabilities, effects: input.effects,
    case_writes: input.caseWrites ?? [],
    ...(input.caseWritesHeld?.length ? { case_writes_held: input.caseWritesHeld } : {}),
    ...(input.contextRequired ? { context_required: true } : {}),
    case_reads: input.caseReads ?? [], case_read_policies: input.caseReadPolicies ?? [],
    fencing_epoch: input.fencingEpoch,
  };
  if (input.signer) return signWithRemoteKey(claims, input.signer, { issuer: ISSUER, audience: AUDIENCE, id: input.invocationId, ttlSeconds: ttl });
  if (!input.secret) throw new Error("execution_auth.signer_missing");
  const material = await signingMaterial(input.secret);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: material.algorithm, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(input.invocationId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(material.key);
}

export async function verifyExecutionEnvelope(token: string, secret: string): Promise<ExecutionEnvelopeClaims> {
  const material = await verificationMaterial(secret);
  const verified = await jwtVerify(token, material.key, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: [...material.algorithms],
    clockTolerance: 2,
  });
  return executionEnvelopeClaimsSchema.parse(verified.payload);
}

export function isDelegatedEnvelope(claims: ExecutionEnvelopeClaims): boolean {
  return claims.delegated_to !== undefined;
}

export type MintDelegatedEnvelopeInput = {
  secret?: string;
  signer?: JwtSigner;
  /** The verified claims of the node envelope being delegated. Never a delegated envelope. */
  parent: ExecutionEnvelopeClaims;
  /** `skills:<skill_id>@<semver>`. */
  delegatedTo: string;
  /** A subset of `parent.capabilities`. */
  capabilities: string[];
  /** A subset of `parent.effects`. */
  effects: EffectClass[];
  /** Requested end of validity (epoch seconds), normally the skill's `limits.deadline_at`. */
  deadlineAt: number;
  now?: number;
};

/** jti of the delegated envelope derived from a node envelope. */
export function delegatedEnvelopeId(parentJti: string): string {
  return `dlg:${parentJti}`;
}

/**
 * Mint a delegated envelope (skill.execution.v1 §6.1): the node envelope narrowed to a skill's
 * declared dependency capabilities, bound to the same tenant, case, run, node, attempt, work
 * item, fences, plan and permission digests, with `delegated_to` and `parent_jti`. It carries
 * no case writes or case reads (a skill never receives write credentials and fetches no
 * context), and expires no later than the parent or the requested deadline, whichever is first.
 * A delegated envelope cannot itself be delegated.
 */
export async function mintDelegatedEnvelope(input: MintDelegatedEnvelopeInput): Promise<{ envelope: string; jti: string; expiresAt: number }> {
  const parent = input.parent;
  if (isDelegatedEnvelope(parent)) throw new Error("execution_auth.delegation_chain_refused");
  if (!/^skills:[a-z][a-z_]*(\.[a-z][a-z0-9_]*)+@[0-9A-Za-z.+-]{1,64}$/.test(input.delegatedTo)) throw new Error("execution_auth.delegated_to_invalid");
  if (input.capabilities.some((capability) => !parent.capabilities.includes(capability))) throw new Error("execution_auth.delegation_capability_not_in_parent");
  if (input.effects.some((effect) => !parent.effects.includes(effect))) throw new Error("execution_auth.delegation_effect_not_in_parent");
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(parent.exp, Math.floor(input.deadlineAt));
  if (expiresAt <= now) throw new Error("execution_auth.delegation_expired");
  const jti = delegatedEnvelopeId(parent.jti);
  const claims = {
    tenant_id: parent.tenant_id, case_id: parent.case_id,
    ...(parent.work_item_id ? { work_item_id: parent.work_item_id, work_fencing_epoch: parent.work_fencing_epoch } : {}),
    run_id: parent.run_id, node_id: parent.node_id, attempt: parent.attempt, plan_digest: parent.plan_digest,
    permission_digest: parent.permission_digest,
    capabilities: [...new Set(input.capabilities)], effects: [...new Set(input.effects)],
    case_writes: [], case_reads: [], case_read_policies: [],
    fencing_epoch: parent.fencing_epoch,
    delegated_to: input.delegatedTo,
    parent_jti: parent.jti,
  };
  if (input.signer) {
    return { envelope: await signWithRemoteKey(claims, input.signer, { issuer: ISSUER, audience: AUDIENCE, id: jti, ttlSeconds: expiresAt - now, expiresAt }), jti, expiresAt };
  }
  if (!input.secret) throw new Error("execution_auth.signer_missing");
  const material = await signingMaterial(input.secret);
  const envelope = await new SignJWT(claims)
    .setProtectedHeader({ alg: material.algorithm, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(material.key);
  return { envelope, jti, expiresAt };
}

export type MintRuntimeGrantInput = {
  secret?: string;
  signer?: JwtSigner;
  grantId: string;
  runId: string;
  attempt: number;
  workerId: string;
  planDigest: string;
  fencingEpoch: number;
  ttlSeconds: number;
  nodeId?: string;
  workItemId?: string;
  workFencingEpoch?: number;
};

/**
 * Mint the authority a runtime carries for one invocation.
 *
 * The grant is deliberately not a capability envelope: it names a run, attempt, worker
 * and fence and nothing about what may be spent. Exchanging it for a per-node envelope
 * is a separate, re-checked step at the control plane, so possession of the grant is not
 * possession of a capability.
 */
export async function mintRuntimeGrant(input: MintRuntimeGrantInput): Promise<string> {
  // Long enough to cover the invocation deadline, since the runtime needs it for the
  // whole run, and bounded so a leaked grant expires with the work it was issued for.
  const ttl = Math.min(3_600, Math.max(30, input.ttlSeconds));
  const claims = {
    run_id: input.runId,
    attempt: input.attempt,
    worker_id: input.workerId,
    ...(input.nodeId ? { node_id: input.nodeId, work_item_id: input.workItemId, work_fencing_epoch: input.workFencingEpoch } : {}),
    plan_digest: input.planDigest,
    fencing_epoch: input.fencingEpoch,
  };
  if (input.signer) return signWithRemoteKey(claims, input.signer, { issuer: GRANT_ISSUER, audience: GRANT_AUDIENCE, id: input.grantId, ttlSeconds: ttl });
  if (!input.secret) throw new Error("execution_auth.signer_missing");
  const material = await signingMaterial(input.secret);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: material.algorithm, typ: "JWT" })
    .setIssuer(GRANT_ISSUER)
    .setAudience(GRANT_AUDIENCE)
    .setJti(input.grantId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(material.key);
}

export async function verifyRuntimeGrant(token: string, secret: string): Promise<RuntimeGrantClaims> {
  const material = await verificationMaterial(secret);
  const verified = await jwtVerify(token, material.key, {
    issuer: GRANT_ISSUER,
    audience: GRANT_AUDIENCE,
    algorithms: [...material.algorithms],
    clockTolerance: 2,
  });
  return runtimeGrantClaimsSchema.parse(verified.payload);
}

export type MintIntegrationEnvelopeInput = {
  secret?: string;
  signer?: JwtSigner;
  envelopeId: string;
  tenantId: string;
  deploymentId: string;
  bindingId: string;
  bindingRevision: number;
  planDigest: string;
  caseId?: string | null;
  intent: IntegrationIntent;
  commandType?: BusinessCommandType | null;
  nonce: string;
  ttlSeconds?: number;
};

export async function mintIntegrationEnvelope(input: MintIntegrationEnvelopeInput): Promise<string> {
  const ttl = Math.min(300, Math.max(10, input.ttlSeconds ?? 60));
  const claims = {
    tenant_id: input.tenantId,
    deployment_id: input.deploymentId,
    binding_id: input.bindingId,
    binding_revision: input.bindingRevision,
    plan_digest: input.planDigest,
    case_id: input.caseId ?? null,
    intent: input.intent,
    command_type: input.commandType ?? null,
    nonce: input.nonce,
  };
  if (input.signer) return signWithRemoteKey(claims, input.signer, {
    issuer: INTEGRATION_ISSUER, audience: INTEGRATION_AUDIENCE, id: input.envelopeId, ttlSeconds: ttl,
  });
  if (!input.secret) throw new Error("integration_auth.signer_missing");
  const material = await signingMaterial(input.secret);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: material.algorithm, typ: "JWT" })
    .setIssuer(INTEGRATION_ISSUER)
    .setAudience(INTEGRATION_AUDIENCE)
    .setJti(input.envelopeId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(material.key);
}

export async function verifyIntegrationEnvelope(token: string, secret: string): Promise<IntegrationEnvelopeClaims> {
  const material = await verificationMaterial(secret);
  const verified = await jwtVerify(token, material.key, {
    issuer: INTEGRATION_ISSUER,
    audience: INTEGRATION_AUDIENCE,
    algorithms: [...material.algorithms],
    clockTolerance: 2,
  });
  return integrationEnvelopeClaimsSchema.parse(verified.payload);
}

export {
  EnvelopeAuthorityError,
  issueDelegatedEnvelope,
  type DelegationDependencies,
  type DelegationReads,
} from "./delegation.js";

/** Interactive preview proof: never accepted as execution or case-write authority. */
export async function mintContextPreviewProof(input:{secret:string;tenantId:string;actor:string;requestDigest:string;expiresAt:string}){
 const material=await signingMaterial(input.secret);const now=Math.floor(Date.now()/1000);
 const expires=Math.min(now+30,Math.floor(Date.parse(input.expiresAt)/1000));
 if(expires<=now)throw new Error('context.preview_authority_expired');
 return new SignJWT({tenant_id:input.tenantId,actor:input.actor,request_digest:input.requestDigest}).setProtectedHeader({alg:material.algorithm,typ:'JWT'}).setIssuer('ehf-context-preview').setAudience('ehf-case-preview').setIssuedAt(now).setExpirationTime(expires).sign(material.key);
}
export async function verifyContextPreviewProof(token:string,secret:string,scope:{tenantId:string;actor:string;requestDigest:string}){
 const material=await verificationMaterial(secret);
 const {payload}=await jwtVerify(token,material.key,{issuer:'ehf-context-preview',audience:'ehf-case-preview',algorithms:[...material.algorithms],maxTokenAge:'30s'});
 if(payload.tenant_id!==scope.tenantId||payload.actor!==scope.actor||payload.request_digest!==scope.requestDigest)throw new Error('context.preview_authority_scope_denied');
}

/** Interactive case traversal proof, distinct from runtime invocation and preview audiences. */
export async function signCaseTraversalProof(input: { secret?: string; signer?: JwtSigner; tenantId: string; actor: string; requestDigest: string; expiresAt: string }): Promise<string> {
  const now = Math.floor(Date.now()/1000);
  const expires = Math.min(now + 30, Math.floor(Date.parse(input.expiresAt)/1000));
  if (!Number.isFinite(expires) || expires <= now) throw new Error("context.traversal_authority_expired");
  const claims = { tenant_id: input.tenantId, actor: input.actor, request_digest: input.requestDigest };
  if (input.signer) return signWithRemoteKey(claims, input.signer, { issuer: "ehf-context-traversal", audience: "ehf-case-traversal", id: input.requestDigest, ttlSeconds: 30, expiresAt: expires });
  if (!input.secret) throw new Error("context.traversal_signer_missing");
  const material = await signingMaterial(input.secret);
  return new SignJWT(claims).setProtectedHeader({ alg: material.algorithm })
    .setIssuer("ehf-context-traversal").setAudience("ehf-case-traversal").setIssuedAt(now).setExpirationTime(expires).sign(material.key);
}
export async function verifyCaseTraversalProof(token: string, secret: string, scope: { tenantId: string; actor: string; requestDigest: string }): Promise<void> {
  const material = await verificationMaterial(secret);
  const {payload} = await jwtVerify(token, material.key, { issuer: "ehf-context-traversal", audience: "ehf-case-traversal", algorithms: [...material.algorithms], maxTokenAge: "30s" });
  if(payload.tenant_id!==scope.tenantId || payload.actor!==scope.actor || payload.request_digest!==scope.requestDigest) throw new Error("context.traversal_authority_scope_denied");
}
