import { readFile } from "node:fs/promises";
import { createDiscoveryDatabase } from "./discovery-database.js";

if (!process.env.DISCOVERY_DATABASE_URL) {
  process.stdout.write("discovery migrations skipped: DISCOVERY_DATABASE_URL is not set\n");
  process.exit(0);
}

const db = createDiscoveryDatabase();
const client = await db.connect();
try {
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtext('ehf:discovery-store:bootstrap'))");
  const file = process.env.MIGRATION_ROOT
    ? `${process.env.MIGRATION_ROOT}/discovery/bootstrap.sql`
    : new URL("../discovery/bootstrap.sql", import.meta.url);
  await client.query(await readFile(file, "utf8"));
  await client.query("commit");
  process.stdout.write("discovery database initialized (case_discovery)\n");
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await db.end();
}
