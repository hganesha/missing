import { unchangedMigrationRename } from "./migration-renames.js";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { modelProfileDocumentSchema } from "@ehf/contracts";
import { createDatabase } from "./index.js";
import { seedAdminConfig } from "./admin.js";
import { seedConnectorCatalog } from "./connectors.js";
import { seedBusinessSkillCatalog } from "./business-skills.js";

/**
 * Carry the JSON model-profile registry into the admin store the first time it exists.
 *
 * The file stays in the repository as the seed and as the offline fallback; it stops
 * being the authority. Seeding is additive, so re-running migrations after an operator
 * has edited a profile never reverts that edit.
 */
async function seedFromRegistry(database: ReturnType<typeof createDatabase>): Promise<void> {
  // Default to the registry's location in the repository rather than to a path relative
  // to whatever directory the migration was started from. The container sets an absolute
  // path; a developer running `pnpm --filter @ehf/persistence migrate` does not, and the
  // seed silently did nothing for them.
  const path = process.env.MODEL_PROFILES_PATH
    ?? fileURLToPath(new URL("../../../config/model-profiles.json", import.meta.url));
  const tenantId = process.env.LOCAL_DEFAULT_TENANT_ID ?? process.env.PLATFORM_TENANT_ID ?? "tenant_demo";
  let profiles;
  try {
    const registry = JSON.parse(await readFile(path, "utf8")) as { profiles?: unknown[] };
    profiles = (registry.profiles ?? []).map((profile) => modelProfileDocumentSchema.parse(profile));
  } catch (error) {
    process.stdout.write(`admin seed skipped: ${error instanceof Error ? error.message : "registry unreadable"}\n`);
    return;
  }
  const seeded = await seedAdminConfig(database, { tenantId, profiles });
  process.stdout.write(
    `admin seed for ${tenantId}: ${seeded.providersCreated.length} provider(s), ${seeded.profilesCreated.length} model profile(s)\n`,
  );
}

/**
 * Carry the generated connector catalog into the connector registry, and register each
 * canonical capability it names as a draft contract when the registry has none.
 *
 * Additive like the model-profile seed: an operator's connector status and every existing
 * capability contract are left alone.
 */
async function seedConnectors(database: ReturnType<typeof createDatabase>): Promise<void> {
  const path = process.env.CONNECTOR_CATALOG_PATH
    ?? fileURLToPath(new URL("../../../config/connector-catalog.json", import.meta.url));
  let catalog: unknown;
  try {
    catalog = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    process.stdout.write(`connector seed skipped: ${error instanceof Error ? error.message : "catalog unreadable"}\n`);
    return;
  }
  const seeded = await seedConnectorCatalog(database, catalog);
  process.stdout.write(
    `connector seed: ${seeded.connectorsCreated} connector(s) created, ${seeded.connectorsUpdated} updated, ${seeded.capabilitiesCreated} draft capability contract(s)\n`,
  );
}

/**
 * Carry the business skill registry seed (config/business-skills.json, generated from the
 * vendored skill library catalog) into the business skill registry. Additive like the
 * connector seed: an operator's active or deprecated status is never lowered, and unchanged
 * manifests are not rewritten; the retired Phase-1 placeholders are removed.
 */
async function seedBusinessSkills(database: ReturnType<typeof createDatabase>): Promise<void> {
  const path = process.env.BUSINESS_SKILL_CATALOG_PATH
    ?? fileURLToPath(new URL("../../../config/business-skills.json", import.meta.url));
  let catalog: unknown;
  try {
    catalog = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    process.stdout.write(`business skill seed skipped: ${error instanceof Error ? error.message : "catalog unreadable"}\n`);
    return;
  }
  const seeded = await seedBusinessSkillCatalog(database, catalog);
  process.stdout.write(`business skill seed: ${seeded.created} skill version(s) created, ${seeded.updated} updated, ${seeded.retired} placeholder(s) retired\n`);
}

const database = createDatabase();
const client = await database.connect();
try {
  await client.query("select pg_advisory_lock(hashtext('ehf:persistence:migrations'))");
  await client.query("create schema if not exists harness_control");
  await client.query(`
    create table if not exists harness_control.schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
  const migrationDirectory = process.env.MIGRATION_ROOT ? `${process.env.MIGRATION_ROOT}/control/migrations` : fileURLToPath(new URL("../migrations", import.meta.url));
  const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) {
    const source = await readFile(`${migrationDirectory}/${migration}`, "utf8");
    const checksum = createHash("sha256").update(source).digest("hex");
    const applied = await client.query<{ checksum: string }>(
      "select checksum from harness_control.schema_migrations where name = $1", [migration],
    );
    if (applied.rows[0]) {
      if (applied.rows[0].checksum !== checksum) throw new Error(`database.migration_changed:${migration}`);
      continue;
    }
    await client.query("begin");
    try {
      const renamed = await unchangedMigrationRename(migration, checksum, async name => (await client.query<{ checksum: string }>("select checksum from harness_control.schema_migrations where name = $1", [name])).rows[0]?.checksum);
      if (!renamed) await client.query(source);
      else process.stdout.write(`Recognized unchanged migration rename: ${renamed} -> ${migration}\n`);
      await client.query("insert into harness_control.schema_migrations(name, checksum) values ($1, $2)", [migration, checksum]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  process.stdout.write("database migrations applied\n");
  // The grant matrix is declarative and re-applied on every run, so a role's privileges are
  // always exactly what grants.sql says, whatever an earlier run or an operator granted.
  const grants = await readFile(process.env.MIGRATION_ROOT ? `${process.env.MIGRATION_ROOT}/control/grants.sql` : fileURLToPath(new URL("../grants.sql", import.meta.url)), "utf8");
  await client.query("begin");
  try {
    await client.query(grants);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  process.stdout.write("grant matrix applied\n");
  await seedFromRegistry(database);
  await seedConnectors(database);
  await seedBusinessSkills(database);
} finally {
  await client.query("select pg_advisory_unlock(hashtext('ehf:persistence:migrations'))").catch(() => undefined);
  client.release();
  await database.end();
}
