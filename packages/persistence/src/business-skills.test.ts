import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  businessSkillCatalogSchema,
  businessSkillEffects,
  businessSkillManifestDigest,
  librarySkillManifestSchema,
} from "@ehf/contracts";
import { getBusinessSkill, listBusinessSkills, seedBusinessSkillCatalog, upsertBusinessSkill, type BusinessSkillClient } from "./business-skills.js";

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(repo(path), "utf8")) as unknown;
const catalog = businessSkillCatalogSchema.parse(readJson("config/business-skills.json"));
const library = readJson("config/skill-library/catalog.json") as { version: string; source_hash: string; bundle_code_hash: string; skills: Array<Record<string, unknown> & { id: string; semver: string }> };
const source = readJson("config/skill-library/source.json") as { revision?: string; path?: string };

function runSync(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [repo("scripts/sync-business-skills.mjs"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { status: failed.status, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe("business skill registry seed (config/business-skills.json)", () => {
  it("is the vendored skill library catalog: every entry, verbatim, at its own maturity", () => {
    expect(catalog.generatedFrom).toMatchObject({
      source: "config/skill-library/catalog.json", library: "financial-crime-skills", version: library.version,
      sourceHash: library.source_hash, bundleDigest: `sha256:${library.bundle_code_hash}`,
      ...(source.revision ? { revision: source.revision } : { path: source.path }),
    });
    expect(catalog.skills.map((skill) => `${skill.skillId}@${skill.semver}`).sort())
      .toEqual(library.skills.map((skill) => `${skill.id}@${skill.semver}`).sort());
    const entries = new Map(library.skills.map((skill) => [skill.id, skill]));
    for (const skill of catalog.skills) {
      const entry = entries.get(skill.skillId)!;
      expect(skill.manifest).toEqual(entry);
      expect(skill.manifestDigest).toBe(businessSkillManifestDigest(entry));
      expect(skill.maturity).toBe(entry.maturity);
      expect(skill.status).toBe("draft");
      expect(skill.source).toEqual({ path: "config/skill-library/catalog.json", revision: source.revision ?? `in-repo:${source.path}` });
      expect(skill.effects).toEqual(businessSkillEffects(librarySkillManifestSchema.parse(entry)));
    }
    expect(catalog.skills.filter((skill) => skill.effects.approval === "required")).toHaveLength(7);
  });

  it("is current with the vendored snapshot", () => {
    const result = runSync(["--check"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuses an entry whose digest, effect mode or dependencies its manifest does not support", () => {
    const entry = catalog.skills.find((skill) => skill.skillId === "decision.disposition.record")!;
    const parse = (changed: Record<string, unknown>) => businessSkillCatalogSchema.safeParse({ ...catalog, skills: [{ ...entry, ...changed }] }).success;
    expect(parse({})).toBe(true);
    expect(parse({ manifestDigest: "0".repeat(64) })).toBe(false);
    expect(parse({ effects: { mode: "internal_write", approval: "none" } })).toBe(false);
    expect(parse({ dependencies: { capabilities: ["screening.sanctions.v1"], skills: [] } })).toBe(false);
    expect(parse({ skillId: "decision.disposition.recorded" })).toBe(false);
  });
});

describe("business skill registry persistence", () => {
  function recording(rows: Record<string, unknown>[] = []) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db: BusinessSkillClient = {
      query: async <T,>(text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        return { rows: rows as T[], rowCount: rows.length };
      },
    };
    return { db, calls };
  }
  const entry = catalog.skills[0]!;
  const row = {
    skill_id: entry.skillId, semver: entry.semver, manifest: entry.manifest, manifest_digest: entry.manifestDigest,
    status: "draft", maturity: "implemented_synthetic", source: entry.source, owner: entry.owner,
    created_at: new Date(0), updated_at: new Date(0),
  };

  it("retires the Phase-1 placeholders, then seeds additively without lowering an operator's status or maturity", async () => {
    const { db, calls } = recording([{ inserted: true }]);
    await expect(seedBusinessSkillCatalog(db, catalog)).resolves.toEqual({ created: 1, updated: 0, retired: 1 });
    expect(calls[0]!.text).toContain("delete from harness_control.business_skill_registry");
    expect(calls[0]!.text).toContain("manifest->>'source' = 'spec-derived-placeholder'");
    const sql = calls[1]!.text;
    expect(sql).toContain("on conflict (skill_id, semver) do update");
    expect(sql).toContain("when business_skill_registry.status = 'active' then 'active'");
    expect(sql).toContain("then business_skill_registry.maturity");
    expect(sql).toContain("manifest_digest is distinct from excluded.manifest_digest");
    const seeded = JSON.parse(calls[1]!.values[0] as string) as Array<{ maturity: string; manifest: unknown; manifest_digest: string }>;
    expect(seeded).toHaveLength(catalog.skills.length);
    expect(new Set(seeded.map((item) => item.maturity))).toEqual(new Set(["implemented_synthetic"]));
    for (const item of seeded) expect(businessSkillManifestDigest(item.manifest)).toBe(item.manifest_digest);
  });

  it("lists and reads skill versions with validated filters", async () => {
    const { db, calls } = recording([row]);
    const listed = await listBusinessSkills(db, { status: "draft", maturity: "implemented_synthetic", domain: "alert" });
    expect(listed[0]).toMatchObject({ skillId: entry.skillId, maturity: "implemented_synthetic", effects: entry.effects, dependencies: entry.dependencies });
    expect(calls[0]!.values).toEqual(["draft", "implemented_synthetic", "alert"]);
    await expect(listBusinessSkills(db, { domain: "case.%" })).rejects.toThrow("business_skill.domain_invalid");
    await expect(getBusinessSkill(db, "Not-An-Id")).rejects.toThrow();
    expect((await getBusinessSkill(db, entry.skillId))?.manifestDigest).toBe(entry.manifestDigest);
  });

  it("registers a library manifest under its own digest and refuses one the library schema does not allow", async () => {
    const { db, calls } = recording([row]);
    await expect(upsertBusinessSkill(db, { manifest: entry.manifest, source: entry.source })).resolves.toMatchObject({ record: { skillId: entry.skillId } });
    expect(calls[0]!.values[3]).toBe(entry.manifestDigest);
    await expect(upsertBusinessSkill(db, { manifest: { ...entry.manifest, effects: "autonomous" }, source: entry.source })).rejects.toThrow();
  });
});
