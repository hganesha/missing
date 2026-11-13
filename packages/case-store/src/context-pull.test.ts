import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createKycCaseRequestSchema,
  stableDigest,
  type BusinessCommand,
  type CaseSnapshot,
} from "@ehf/contracts";
import {
  canonicalMappingSchema,
  contextCaseBindingSchema,
} from "@ehf/contracts/context-setup";
import {
  createCaseStore,
  createKycCase,
  getCanonicalCaseSnapshot,
  submitBusinessCommand,
  type CaseExecutionAuthority,
} from "./index.js";
import {
  assertContextPullCommands,
  contextPullRunScope,
  scopeContextPullSnapshot,
} from "./context-pull.js";

const digest = (c: string) => c.repeat(64);
const scope = {
  planDigest: digest("b"),
  nodeId: "fetch",
  subjects: ["entity:one"],
  objectTypes: ["Entity"],
  connectorId: "context-salesforce:identity",
};
function command(tenantId = "tenant", caseId = "case"): BusinessCommand {
  return {
    commandId: randomUUID(),
    commandType: "RecordCanonicalRecords",
    commandVersion: "v1",
    tenantId,
    caseId,
    actor: {
      type: "SYSTEM",
      principalId: "source-normalizer",
      roles: ["workflow.executor"],
    },
    authority: {
      planDigest: scope.planDigest,
      policySnapshotDigest: digest("a"),
      permissionEnvelopeDigest: digest("c"),
    },
    payload: {
      records: [
        {
          tenant_id: tenantId,
          case_id: caseId,
          object_type: "Entity",
          object_id: "entity:one",
          version_id: "pull-one",
          subject_ids: scope.subjects,
          data: {
            name: "Customer",
            entity_type: "company",
            identifiers: ["crm-one"],
          },
          observed_at: "2026-11-09T12:00:00Z",
          source_refs: [],
          provenance: {
            method: "connector_normalizer",
            connector_id: scope.connectorId,
          },
          classification: "CONFIDENTIAL",
          synthetic: false,
        },
      ],
    },
    preconditions: { caseSequence: 1 },
    idempotencyKey: randomUUID(),
  } as BusinessCommand;
}
it("limits acquisition commands to the reviewed subjects, mapped observation types and service provenance", () => {
  expect(() => assertContextPullCommands(scope, [command()])).not.toThrow();
  for (const patch of [
    { object_type: "Case" },
    { object_type: "Party" },
    { subject_ids: ["foreign"] },
    { case_id: "foreign" },
    { provenance: { method: "human" } },
  ]) {
    const c = command();
    Object.assign((c.payload.records as object[])[0]!, patch);
    expect(() => assertContextPullCommands(scope, [c])).toThrow(
      "context.pull_execution_not_authorized",
    );
  }
  expect(() =>
    assertContextPullCommands(scope, [
      { ...command(), commandType: "AddSubject" },
    ]),
  ).toThrow("context.pull_execution_not_authorized");
});
it("gives an acquisition plan only case metadata and a new snapshot digest", () => {
  const original = {
    snapshotId: "original",
    snapshotDigest: digest("a"),
    capturedAt: "2026-11-09T12:00:00Z",
    planDigest: digest("d"),
    data: {
      case: { caseId: "case", status: "open" },
      records: { Entity: [{ secret: "excluded" }] },
      subjects: ["excluded"],
    },
  } as unknown as CaseSnapshot;
  const result = scopeContextPullSnapshot(original, scope);
  expect(result.data).toEqual({ case: original.data.case });
  expect(result.planDigest).toBe(scope.planDigest);
  expect(result.snapshotDigest).not.toBe(original.snapshotDigest);
  const {
    snapshotId: _id,
    snapshotDigest: _digest,
    capturedAt: _at,
    ...basis
  } = result;
  expect(result.snapshotDigest).toBe(stableDigest(basis));
  expect(original.planDigest).toBe(digest("d"));
});

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)(
  "reviewed pull authority in PostgreSQL",
  () => {
    it("commits a source observation under a separate acquisition plan, retains case workflow authority and fails closed after binding changes", async () => {
      const store = createCaseStore({
        connectionString: process.env.EHF_TEST_DATABASE_URL!,
      });
      const tenantId = `pull_${randomUUID()}`,
        environment = "test",
        mainPlan = digest("d"),
        runId = `run-${randomUUID()}`;
      try {
        await store.db.query(
          "insert into harness_control.plans(plan_digest,plan_id,name,domain,version,plan,tenant_id) values($1,$2,'pull','kyc','1','{}',$3)",
          [scope.planDigest, randomUUID(), tenantId],
        );
        const created = await createKycCase(
          store,
          createKycCaseRequestSchema.parse({
            tenantId,
            harnessPlanDigest: mainPlan,
            policySnapshotDigest: digest("a"),
            policyAuthority: {
              policyId: "policy",
              policyVersion: "1",
              policyBundleDigest: digest("c"),
              dependencyDigest: digest("d"),
            },
            actor: { type: "HUMAN", principalId: "reviewer", roles: [] },
          }),
          randomUUID(),
        );
        const caseId = created.case.caseId;
        const connection = {
          kind: "connection",
          id: "crm",
          connectorId: scope.connectorId,
          api: { kind: "salesforce" },
        };
        const resource = {
          kind: "resource",
          id: "account",
          connectionId: "crm",
          connectionDigest: stableDigest(connection),
        };
        const mapping = canonicalMappingSchema.parse({
          kind: "mapping",
          id: "identity",
          name: "Identity",
          resourceId: "account",
          resourceDigest: stableDigest(resource),
          productId: "identity.intelligence",
          catalogDigest: digest("a"),
          schemaVersion: "2.0.0",
          subject: { op: "field", path: "key" },
          outputs: [
            {
              objectType: "Entity",
              identity: { op: "field", path: "key" },
              fields: {},
            },
          ],
        });
        const binding = contextCaseBindingSchema.parse({
          kind: "case-binding",
          id: "reviewed",
          caseId,
          mappingId: "identity",
          mappingDigest: stableDigest(mapping),
          enablementRevision: 1,
          planDigest: scope.planDigest,
          nodeId: "fetch",
          sourceContextDigest: digest("e"),
          subjects: [{ subjectId: "entity:one", sourceKey: "crm-one" }],
          enabled: true,
        });
        const save = <T extends { kind: string; id: string }>(
          definition: T,
          revision = 1,
        ) =>
          store.db.query(
            "insert into harness_control.context_revisions(tenant_id,environment,kind,id,revision,digest,definition,reason,created_by) values($1,$2,$3,$4,$5,$6,$7,'reviewed','reviewer')",
            [
              tenantId,
              environment,
              definition.kind,
              definition.id,
              revision,
              stableDigest(definition),
              definition,
            ],
          );
        for (const definition of [connection, resource, mapping, binding])
          await save(definition);
        await store.db.query(
          "insert into harness_control.context_enablements(tenant_id,environment,mapping_id,revision,mapping_digest,report_id,report_digest,authority,enabled_by) values($1,$2,'identity',1,$3,'sample',$4,$5,'reviewer')",
          [
            tenantId,
            environment,
            stableDigest(mapping),
            digest("f"),
            { connectorId: scope.connectorId, planDigest: scope.planDigest },
          ],
        );
        await store.db.query(
          `insert into harness_runtime.runs(run_id,idempotency_key,plan_digest,status,input,source_context_digest,attempt,fencing_epoch,lease_expires_at,tenant_id,request_digest)
        values($1,$1,$2,'running',$3,$4,1,1,now()+interval '10 minutes',$5,'test')`,
          [
            runId,
            scope.planDigest,
            {
              tenantId,
              caseId,
              contextEnvironment: environment,
              contextPullBinding: {
                id: binding.id,
                digest: stableDigest(binding),
              },
              contextPullNodeId: "fetch",
              canonicalSubjects: scope.subjects,
              subjects: ["crm-one"],
            },
            digest("e"),
            tenantId,
          ],
        );
        const authority: CaseExecutionAuthority = {
          tenant_id: tenantId,
          case_id: caseId,
          run_id: runId,
          plan_digest: scope.planDigest,
          node_id: "fetch",
          attempt: 1,
          fencing_epoch: 1,
        };
        expect(await contextPullRunScope(store, authority)).toEqual(scope);
        await expect(
          contextPullRunScope(store, { ...authority, node_id: "other-node" }),
        ).rejects.toThrow("context.pull_execution_not_authorized");
        expect(
          await contextPullRunScope(store, {
            ...authority,
            tenant_id: "other-tenant",
          }),
        ).toBeNull();
        const client = await store.db.connect();
        try {
          await client.query("begin");
          await client.query("set local role ehf_svc_case_execution");
          expect(await contextPullRunScope(store, authority, client)).toEqual(
            scope,
          );
          await expect(
            client.query("select * from harness_control.context_revisions"),
          ).rejects.toThrow(/permission denied/);
        } finally {
          await client.query("rollback");
          client.release();
        }
        const response = await submitBusinessCommand(
          store,
          command(tenantId, caseId),
          authority,
        );
        expect(response.caseSequence).toBe(2);
        const snapshot = await getCanonicalCaseSnapshot(
          store,
          tenantId,
          caseId,
          "KYB_ONBOARDING",
        );
        expect(snapshot?.planDigest).toBe(mainPlan);
        expect(
          (snapshot?.data.records as Record<string, unknown[]>).Entity,
        ).toHaveLength(1);
        const prohibited: BusinessCommand = {
          ...command(tenantId, caseId),
          commandType: "AddSubject",
          payload: { subjectType: "individual", displayName: "Unapproved" },
          preconditions: { caseSequence: 2 },
        };
        await expect(
          submitBusinessCommand(store, prohibited, authority),
        ).rejects.toThrow("context.pull_execution_not_authorized");
        await save({ ...binding, enabled: false }, 2);
        expect(await contextPullRunScope(store, authority)).toBeNull();
        await expect(
          submitBusinessCommand(
            store,
            {
              ...command(tenantId, caseId),
              preconditions: { caseSequence: 2 },
            },
            authority,
          ),
        ).rejects.toThrow();
        expect(
          (
            await getCanonicalCaseSnapshot(
              store,
              tenantId,
              caseId,
              "KYB_ONBOARDING",
            )
          )?.caseSequence,
        ).toBe(2);
      } finally {
        await store.db.end();
      }
    });
  },
);
