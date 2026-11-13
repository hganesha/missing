import { expect, it, vi } from "vitest";
import { unchangedMigrationRename } from "./migration-renames.js";
it("recognizes only explicitly renamed, already-applied SQL with an identical checksum", async () => {
  const lookup = vi.fn(async (name: string) => name === "043_context_sources.sql" ? "same-hash" : undefined);
  expect(await unchangedMigrationRename("047_context_setup.sql", "same-hash", lookup)).toBe("043_context_sources.sql");
  await expect(unchangedMigrationRename("047_context_setup.sql", "changed-hash", lookup)).rejects.toThrow("database.migration_changed:043_context_sources.sql");
  expect(await unchangedMigrationRename("048_context_enablement_pause_audit.sql", "hash", lookup)).toBeNull();
  lookup.mockClear();
  expect(await unchangedMigrationRename("054_platform_workbench.sql", "same-hash", lookup)).toBeNull();
  expect(lookup).not.toHaveBeenCalled();
});
