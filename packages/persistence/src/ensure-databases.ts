import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * Create the control, case and context databases when they do not exist yet.
 *
 * The control database (DATABASE_URL) and the case database (CASE_DATABASE_URL) are
 * separate so that no workflow or control-plane credential can reach case truth
 * (docs/implementation/data-stores-plan.md §1). A cloud deployment provisions both
 * databases itself. The local stack and CI only have one server, so the migrate job
 * creates them through DATABASE_BOOTSTRAP_URL, a connection to a maintenance database
 * on the same server. When the variable is unset this step does nothing.
 */
export function databaseNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set<string>();
  for (const key of ["DATABASE_URL", "CASE_DATABASE_URL", "CONTEXT_DATABASE_URL", "DISCOVERY_DATABASE_URL"]) {
    const value = env[key];
    if (!value) continue;
    const name = decodeURIComponent(new URL(value).pathname.replace(/^\//, ""));
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`database.name_invalid:${key}`);
    names.add(name);
  }
  return [...names];
}

export async function ensureDatabases(bootstrapUrl: string, names: string[]): Promise<string[]> {
  if (names.some(name => !/^[a-z_][a-z0-9_]{0,62}$/.test(name))) throw new Error("database.name_invalid");
  const client = new pg.Client({ connectionString: bootstrapUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  const created: string[] = [];
  try {
    for (const name of names) {
      const exists = await client.query("select 1 from pg_database where datname = $1", [name]);
      if (exists.rowCount) continue;
      // CREATE DATABASE cannot take a parameter; the name was validated as an identifier.
      try {
        await client.query(`create database ${name}`);
        created.push(name);
      } catch (error) {
        if ((error as { code?: string }).code !== "42P04") throw error;
      }
    }
  } finally {
    await client.end();
  }
  return created;
}

export async function main(): Promise<void> {
  const bootstrapUrl = process.env.DATABASE_BOOTSTRAP_URL;
  if (!bootstrapUrl) return;
  const created = await ensureDatabases(bootstrapUrl, databaseNames());
  process.stdout.write(created.length ? `databases created: ${created.join(", ")}\n` : "databases present\n");
}

if (import.meta.main ?? (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) await main();
