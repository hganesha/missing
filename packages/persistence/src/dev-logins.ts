import { pathToFileURL } from "node:url";
import pg from "pg";
import { isProductionProfile } from "@ehf/identity";

/**
 * Development logins: one per local service, each a member of only its service groups.
 *
 * Migrations create the NOLOGIN groups and grants.sql gives them their privileges. A
 * deployment maps its own principals into those groups (one database role per service,
 * authenticated by certificate or a mounted password file). The local stack has no such
 * principals, so this step creates
 * password logins with the same shape, so that locally, too, no service connects as a
 * superuser and row-level security is actually enforced.
 *
 * Runs only when DATABASE_DEV_LOGIN_PASSWORD is set, and never under the production
 * security profile.
 */
export const DEV_LOGINS: Readonly<Record<string, readonly string[]>> = {
  // control-api also records context packs for the runtime (context database).
  ehf_dev_control_api: ["ehf_svc_control_api", "ehf_svc_context_writer"],
  ehf_dev_runtime_dispatcher: ["ehf_svc_runtime_dispatcher"],
  ehf_dev_runtime_host: ["ehf_svc_runtime_checkpoint"],
  // The gateway searches the retrieval index in the context database; it has no case-database access.
  ehf_dev_capability_gateway: ["ehf_svc_capability_gateway", "ehf_svc_context_retrieval"],
  ehf_dev_integration_worker: ["ehf_svc_integration_worker"],
  // case-api writes cases, runs the outbox relay, and asks the control database whether an
  // execution still holds its lease.
  ehf_dev_case_api: ["ehf_svc_case_api", "ehf_svc_case_outbox_relay", "ehf_svc_case_execution", "ehf_svc_document_index"],
  // The signed ledger segment exporter (compose profile ledger-export).
  ehf_dev_ledger_exporter: ["ehf_svc_ledger_exporter"],
  // The evidence retention and legal hold job (compose profile blob).
  ehf_dev_evidence_retention: ["ehf_svc_evidence_retention"],
  // The context release job (compose profile context-release): release functions in the
  // context and control databases; it reaches case data only through case-api.
  ehf_dev_context_release: ["ehf_svc_context_release", "ehf_svc_case_data_release"],
};

export async function applyDevelopmentLogins(client: Pick<pg.ClientBase, "query">, password: string): Promise<string[]> {
  if (password.length < 16) throw new Error("database.dev_login_password_too_short");
  const roles = await client.query("select 1 from pg_roles where rolname = 'ehf_svc_discovery_reader'");
  const logins = roles.rowCount ? {
    ...DEV_LOGINS,
    ehf_dev_discovery_reader: ["ehf_svc_discovery_reader"],
    ehf_dev_discovery_worker: ["ehf_svc_discovery_case_reader", "ehf_svc_discovery_observer", "ehf_svc_discovery_writer"],
  } : DEV_LOGINS;
  for (const [login, groups] of Object.entries(logins)) {
    const exists = await client.query("select 1 from pg_roles where rolname = $1", [login]);
    const literal = (await client.query<{ value: string }>("select quote_literal($1) as value", [password])).rows[0]!.value;
    await client.query(`${exists.rowCount ? "alter" : "create"} role ${login} login nosuperuser nobypassrls nocreaterole nocreatedb password ${literal}`);
    for (const group of groups) await client.query(`grant ${group} to ${login}`);
  }
  return Object.keys(logins);
}

export async function main(): Promise<void> {
  const password = process.env.DATABASE_DEV_LOGIN_PASSWORD;
  if (!password) return;
  if (isProductionProfile()) throw new Error("database.dev_logins_forbidden_in_production");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("database.url_missing");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const created = await applyDevelopmentLogins(client, password);
    process.stdout.write(`development database logins: ${created.join(", ")}\n`);
  } finally {
    await client.end();
  }
}

if (import.meta.main ?? (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) await main();
