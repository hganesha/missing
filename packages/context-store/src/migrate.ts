import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseAuth } from "@ehf/identity";

// The context database (ehf_context): pgvector, Apache AGE and the context schema. Same
// runner shape as the control and case stores: numbered migrations once each, then the grant
// matrix re-applied on every run.
const connectionString = process.env.CONTEXT_DATABASE_URL;
databaseAuth();
if (!connectionString) {
  process.stdout.write("context-store migrations skipped: CONTEXT_DATABASE_URL is not set\n");
  process.exit(0);
}

/**
 * Apache AGE must be loaded in every session that touches the graph. Preloading it for the
 * whole server (shared_preload_libraries) is not an option on a shared server: AGE's drop
 * hook then looks for ag_catalog in every database, and plain DROP TABLE fails in the
 * control and case databases. So it is preloaded for this database only. Setting that needs a
 * superuser; a managed server whose administrator is not one must preload AGE itself and
 * should host the context database on its own server (data-stores-plan.md §4.4).
 */
async function loadAgeForThisDatabase(client: pg.PoolClient): Promise<void> {
  const state = await client.query<{ superuser: boolean; preloaded: string; session: string; database: string }>(`
    select (select rolsuper from pg_roles where rolname = current_user) as superuser,
           current_setting('shared_preload_libraries') as preloaded,
           current_setting('session_preload_libraries') as session,
           current_database() as database`);
  const row = state.rows[0]!;
  const has = (list: string) => list.split(",").map((value) => value.trim().replace(/^"|"$/g, "")).includes("age");
  if (has(row.preloaded) || has(row.session)) return;
  if (!row.superuser) throw new Error("context_store.age_preload_required: preload AGE for this server or migrate as a superuser");
  await client.query("load 'age'");
  if (!has(row.session)) {
    await client.query(`alter database ${pg.escapeIdentifier(row.database)} set session_preload_libraries = 'age'`);
  }
}

const database = new pg.Pool({ connectionString, max: 2 });
const client = await database.connect();
try {
  await client.query("select pg_advisory_lock(hashtext('ehf:context-store:migrations'))");
  await loadAgeForThisDatabase(client);
  // AGE's graph creation resolves internal operator classes through the session path,
  // even when create_graph itself is schema-qualified (including managed Azure AGE).
  await client.query("set search_path = ag_catalog, pg_catalog, public");
  await client.query("create schema if not exists context");
  await client.query(`
    create table if not exists context.schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
  const directory = process.env.MIGRATION_ROOT ? `${process.env.MIGRATION_ROOT}/context/migrations` : fileURLToPath(new URL("../migrations", import.meta.url));
  for (const migration of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    const source = await readFile(`${directory}/${migration}`, "utf8");
    const checksum = createHash("sha256").update(source).digest("hex");
    const applied = await client.query<{ checksum: string }>("select checksum from context.schema_migrations where name = $1", [migration]);
    if (applied.rows[0]) {
      if (applied.rows[0].checksum !== checksum) throw new Error(`context_store.migration_changed:${migration}`);
      continue;
    }
    await client.query("begin");
    try {
      await client.query(source);
      await client.query("insert into context.schema_migrations(name, checksum) values ($1, $2)", [migration, checksum]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  const grants = await readFile(process.env.MIGRATION_ROOT ? `${process.env.MIGRATION_ROOT}/context/grants.sql` : fileURLToPath(new URL("../grants.sql", import.meta.url)), "utf8");
  await client.query("begin");
  try {
    await client.query(grants);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  process.stdout.write("context-store migrations applied (context, context_graph)\n");
} finally {
  await client.query("select pg_advisory_unlock(hashtext('ehf:context-store:migrations'))").catch(() => undefined);
  client.release();
  await database.end();
}
