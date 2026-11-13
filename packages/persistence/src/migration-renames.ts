/** Exact SQL renames for migrations applied before they reached the main migration sequence. */
export const MIGRATION_RENAMES: Readonly<Record<string, string>> = {
  "047_context_setup.sql": "043_context_sources.sql",
  "048_context_enablement_pause_audit.sql": "044_context_enablement_pause_audit.sql",
  "049_context_snapshot_refresh.sql": "045_context_refresh.sql",
  "052_context_case_bindings.sql": "046_context_case_bindings.sql",
  "053_context_pull_authority.sql": "047_context_pull_authority.sql",
  "056_draft_test_runs.sql": "048_draft_test_runs.sql",
  "069_sandbox_observations.sql": "065_sandbox_observations.sql",
};
/** A renamed file may skip SQL only when its explicitly mapped predecessor has the exact hash. */
export async function unchangedMigrationRename(name: string, checksum: string, lookup: (name: string) => Promise<string | undefined>): Promise<string | null> {
  const previous = MIGRATION_RENAMES[name];
  if (!previous) return null;
  const applied = await lookup(previous);
  if (applied === undefined) return null;
  if (applied !== checksum) throw new Error(`database.migration_changed:${previous}`);
  return previous;
}
