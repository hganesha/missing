import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

// Every Node entrypoint of the single application image (Dockerfile.platform). The image's
// entrypoint selects one with SERVICE_NAME; Compose runs the same image locally.
const entries = {
  "seed-authoring": "apps/control-api/src/seed-authoring.ts",
  "runtime-verify": "apps/launcher/src/runtime-verify.ts",
  "runtime-launch": "apps/launcher/src/runtime-launch.ts",
  "migrate": "apps/launcher/src/migrate.ts",
  "migrate-control": "packages/persistence/src/migrate.ts",
  "migrate-case": "packages/case-store/src/migrate.ts",
  "migrate-context": "packages/context-store/src/migrate.ts",
  "migrate-discovery": "packages/case-store/src/migrate-discovery.ts",
  "launcher": "apps/launcher/src/server.ts",
  "onboarding-recover": "apps/launcher/src/recover.ts",
  "experience-bff": "apps/experience-bff/src/server.ts",
  "discovery-worker": "packages/case-store/src/run-recon-worker.ts",
  "context-refresh": "apps/control-api/src/context-refresh-worker.ts",
  "control-api": "apps/control-api/src/server.ts",
  "capability-gateway": "apps/capability-gateway/src/server.ts",
  "case-api": "apps/case-api/src/server.ts",
  "runtime-host": "apps/runtime-host/src/server.ts",
  "runtime-worker": "apps/runtime-worker/src/worker.ts",
  "integration-worker": "apps/integration-worker/src/worker.ts",
  // Development only: it refuses to start outside the development security profile.
  "skill-host-reference": "apps/skill-host-reference/src/server.ts",
};
// Maintenance jobs whose modules guard `main` behind import.meta.main. A bundle defines
// import.meta.main as false (an imported module never runs its own main), so each job gets
// a two-line entry that calls the exported main explicitly.
const jobs = {
  "ensure-databases": "packages/persistence/src/ensure-databases.ts",
  "dev-logins": "packages/persistence/src/dev-logins.ts",
  "ensure-containers": "packages/blob-store/src/ensure-containers.ts",
  "ledger-export": "packages/case-store/src/ledger-export.ts",
  "evidence-governance": "packages/case-store/src/governance.ts",
  "context-release": "packages/context-store/src/release.ts",
};

const service = process.argv[2];
const selected = service === "platform" ? [...Object.keys(entries), ...Object.keys(jobs)] : [service];
for (const name of selected) {
  const entry = entries[name];
  const job = jobs[name];
  if (!entry && !job) throw new Error(`build.service_invalid:${name ?? "missing"}`);
  const outputDirectory = resolve("dist/services", name);
  await mkdir(outputDirectory, { recursive: true });
  await build({
    ...(entry ? { entryPoints: [resolve(entry)] } : { stdin: { contents: `import { main } from ${JSON.stringify(resolve(job))};\nawait main();\n`, resolveDir: resolve("."), loader: "ts" } }),
    outfile: resolve(outputDirectory, "server.mjs"),
    bundle: true,
    // Imported maintenance modules are never the entrypoint of a service bundle.
    define: { "import.meta.main": "false" },
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    banner: { js: "import { createRequire as __createRequire } from 'node:module';const require=__createRequire(import.meta.url);" + (name.startsWith("migrate-") ? `
process.on('uncaughtException', error => {
  const code = /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : 'migration.store_failed';
  // Raw errors can carry SQL or credential material: only a development run prints them.
  if (process.env.SECURITY_PROFILE === 'development') process.stderr.write(String(error?.stack ?? error) + '\\n');
  process.stderr.write(JSON.stringify({ code }) + '\\n'); process.exit(1);
});` : "") },
  });
}
