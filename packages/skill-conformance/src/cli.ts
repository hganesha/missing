#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { REFERENCE_HOST_FIXTURES, runSkillHostConformance, type ConformanceFixtures } from "./index.js";

/**
 * Run the skill.execution.v1 conformance suite against a skill host:
 *
 *   pnpm --filter @ehf/skill-conformance conformance -- --base-url http://127.0.0.1:8090 \
 *     --fixtures ./fixtures.json [--gateway-host 0.0.0.0 --gateway-port 7070 \
 *     --gateway-public-url http://host.docker.internal:7070] [--gateway-token <host workload token>]
 *
 * The host's bearer token comes from SKILL_HOST_AUTH_TOKEN (or --token). Without --fixtures the
 * suite uses the reference host's sample skills. Exit status 1 when any check fails.
 */
const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    token: { type: "string" },
    fixtures: { type: "string" },
    "gateway-host": { type: "string" },
    "gateway-port": { type: "string" },
    "gateway-public-url": { type: "string" },
    "gateway-token": { type: "string" },
    json: { type: "boolean" },
  },
});

const baseUrl = values["base-url"] ?? process.env.SKILL_HOST_URL;
const token = values.token ?? process.env.SKILL_HOST_AUTH_TOKEN;
if (!baseUrl || !token) {
  process.stderr.write("usage: skill-conformance --base-url <url> [--fixtures <file>] (token from SKILL_HOST_AUTH_TOKEN or --token)\n");
  process.exit(2);
}
const fixtures = values.fixtures
  ? JSON.parse(await readFile(values.fixtures, "utf8")) as ConformanceFixtures
  : REFERENCE_HOST_FIXTURES;
const report = await runSkillHostConformance({
  baseUrl,
  token,
  fixtures,
  gatewayListen: {
    ...(values["gateway-host"] ? { host: values["gateway-host"] } : {}),
    ...(values["gateway-port"] ? { port: Number(values["gateway-port"]) } : {}),
  },
  ...(values["gateway-public-url"] ? { gatewayPublicUrl: values["gateway-public-url"] } : {}),
  ...(values["gateway-token"] ? { gatewayWorkloadToken: values["gateway-token"] } : {}),
});
if (values.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const check of report.checks) {
    process.stdout.write(`${check.status.toUpperCase().padEnd(7)} ${check.id}. ${check.name}\n`);
    for (const detail of check.details) process.stdout.write(`        ${detail}\n`);
  }
  process.stdout.write(`\nbundle ${report.bundleDigest ?? "unknown"}: ${report.passed ? "conformant" : "NOT conformant"}\n`);
}
process.exit(report.passed ? 0 : 1);
