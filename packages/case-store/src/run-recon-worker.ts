import { createServer } from "node:http";
import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkloadAuthorization, databaseAuth } from "@ehf/identity";
import { z } from "zod";
import { caseStoreSchemas } from "./config.js";
import { CaseStoreError } from "./index.js";
import { createDiscoveryDatabase, liveDiscoveryEnabled, syntheticDiscoveryEnabled } from "./discovery.js";
import { webSearchConfigured } from "./recon-web-search.js";
import { processReconJob } from "./recon-worker.js";

const env = process.env;
const synthetic = syntheticDiscoveryEnabled(env);
const active = synthetic || (liveDiscoveryEnabled(env) && webSearchConfigured(env));
if (!active) {
  process.stdout.write("Recon worker is idle\n");
  if (!env.DISCOVERY_DATABASE_URL || !env.DISCOVERY_TENANT_ID || !env.DISCOVERY_CONTROL_DATABASE_URL || !env.CASE_DATABASE_URL) {
    process.exit(0);
  }
}
const planDigest = synthetic ? z.string().regex(/^[a-f0-9]{64}$/).parse(env.DISCOVERY_HOSTED_PLAN_DIGEST) : undefined;
const tenantId = z.string().min(1).parse(env.DISCOVERY_TENANT_ID);
const connectionString = z.string().min(1).parse(env.DISCOVERY_CONTROL_DATABASE_URL);
const launchUrl = new URL("/v1/internal/discovery/runs", env.CONTROL_API_URL ?? "http://control-api:4100");
const authorization = synthetic ? createWorkloadAuthorization({ staticTokenEnv: "DISCOVERY_WORKER_SERVICE_TOKEN" }) : undefined;
databaseAuth(env);
const caseConnection = z.string().min(1).parse(env.CASE_DATABASE_URL);
const store = { schemas: caseStoreSchemas(),
  db: new pg.Pool({ connectionString: caseConnection, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 }),
};
const discovery = createDiscoveryDatabase();
const control = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
const port = env.PORT ? z.coerce.number().int().min(1).max(65535).parse(env.PORT) : undefined;
const health = port ? createServer(async (request, reply) => {
  if (request.url === "/health/live") return reply.writeHead(200).end();
  if (request.url !== "/health/ready") return reply.writeHead(404).end();
  try {
    await Promise.all([store.db.query("select 1"), discovery.query("select 1"), control.query("select 1")]);
    reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ready" }));
  } catch {
    reply.writeHead(503).end();
  }
}).listen(port, env.HOST ?? "127.0.0.1") : undefined;
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  while (!controller.signal.aborted) {
    if (!active) {
      await delay(60_000, undefined, { signal: controller.signal }).catch(() => undefined);
      continue;
    }
    try {
      await processReconJob({ store, discovery, control, tenantId, ...(planDigest ? { planDigest } : {}), env, launch: async (body, attempt) => {
        if (!authorization) throw new Error("discovery.synthetic_disabled");
        const response = await fetch(launchUrl, {
          method: "POST", headers: { "content-type": "application/json", authorization: await authorization() },
          body: JSON.stringify({ body, attempt }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) throw new CaseStoreError("discovery.advisory_launch_failed", response.status);
        return z.object({ runId: z.string().min(1) }).parse(await response.json()).runId;
      } });
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = error instanceof CaseStoreError ? error.code : "discovery.worker_error";
        process.stderr.write(`Recon worker could not process a request (${code}).\n`);
      }
    }
    await delay(1_000, undefined, { signal: controller.signal }).catch(() => undefined);
  }
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  health?.close();
  await Promise.all([control.end(), discovery.end(), store.db.end()]);
}
