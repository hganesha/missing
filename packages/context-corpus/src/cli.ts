#!/usr/bin/env -S node --import tsx
import { resolve } from "node:path";
import { readManifest, readParty, validateParty } from "./corpus.js";
import { seedParty } from "./seed.js";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const root = resolve(flag("root") ?? new URL("../../../fixtures/context-corpus", import.meta.url).pathname);
const parties = flag("party") ? [flag("party")!] : readManifest(root).parties.map((p) => p.id);

if (args.includes("--validate")) {
  let bad = 0;
  for (const id of parties) {
    const errors = validateParty(readParty(root, id));
    for (const e of errors) console.error(`${id}: ${e}`);
    bad += errors.length;
    console.log(`${id}: ${errors.length === 0 ? "ok" : `${errors.length} error(s)`}`);
  }
  process.exit(bad ? 1 : 0);
}

const need = (name: string, env: string) => {
  const value = flag(name) ?? process.env[env];
  if (!value) { console.error(`missing --${name} or ${env}`); process.exit(2); }
  return value;
};
const options = {
  baseUrl: need("case-api", "CORPUS_CASE_API_URL"), tenantId: need("tenant", "CORPUS_TENANT_ID"),
  token: need("token", "CORPUS_TOKEN"), policySnapshotDigest: need("policy-digest", "CORPUS_POLICY_DIGEST"),
  harnessPlanDigest: need("plan-digest", "CORPUS_PLAN_DIGEST"),
  permissionEnvelopeDigest: need("envelope-digest", "CORPUS_ENVELOPE_DIGEST"),
};
for (const id of parties) {
  const dossier = readParty(root, id);
  const errors = validateParty(dossier);
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  const result = await seedParty({ ...dossier, case: { ...dossier.case, tenant_id: options.tenantId } }, options);
  console.log(`${id}: case ${result.caseId} (${result.created ? "created" : "existing"}), ${result.recordsWritten} records, ${result.commands} commands`);
}
