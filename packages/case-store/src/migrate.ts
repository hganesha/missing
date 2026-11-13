import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseAuth } from "@ehf/identity";
import { caseStoreSchemas, qualify, quoteIdentifier, renderMigration } from "./config.js";

const connectionString = process.env.CASE_DATABASE_URL ?? process.env.DATABASE_URL;
databaseAuth();
if (!connectionString) throw new Error("case_store.database_url_missing");

const database = new pg.Pool({ connectionString, max: 2 });
const client = await database.connect();
try {
  await client.query("select pg_advisory_lock(hashtext('ehf:case-store:migrations'))");
  const directory = process.env.MIGRATION_ROOT ? `${process.env.MIGRATION_ROOT}/case/migrations` : fileURLToPath(new URL("../migrations", import.meta.url));
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const schemas = caseStoreSchemas();
  await client.query(`create schema if not exists ${quoteIdentifier(schemas.core)}`);
  const migrationTable = qualify(schemas.core, "schema_migrations");
  await client.query(`
    create table if not exists ${migrationTable} (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
  for (const migration of migrations) {
    const source = await readFile(`${directory}/${migration}`, "utf8");
    const checksum = createHash("sha256").update(source).digest("hex");
    const applied = await client.query<{ checksum: string }>(`select checksum from ${migrationTable} where name = $1`, [migration]);
    if (applied.rows[0]) {
      if (applied.rows[0].checksum !== checksum) throw new Error(`case_store.migration_changed:${migration}`);
      continue;
    }
    await client.query("begin");
    try {
      await client.query(renderMigration(source, schemas));
      await client.query(`insert into ${migrationTable}(name, checksum) values ($1, $2)`, [migration, checksum]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  // Re-applied on every run: a role's privileges are always exactly what grants.sql says.
  const grants = await readFile(process.env.MIGRATION_ROOT ? `${process.env.MIGRATION_ROOT}/case/grants.sql` : fileURLToPath(new URL("../grants.sql", import.meta.url)), "utf8");
  await client.query("begin");
  try {
    await client.query(renderMigration(grants, schemas));
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  process.stdout.write(`case-store migrations applied (${schemas.core}, ${schemas.ledger}, ${schemas.evidence})\n`);
} finally {
  await client.query("select pg_advisory_unlock(hashtext('ehf:case-store:migrations'))").catch(() => undefined);
  client.release();
  await database.end();
}
