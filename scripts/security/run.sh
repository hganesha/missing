#!/usr/bin/env bash
# Non-mutating source security gate. Cloud credentials are not needed here.
# Scanner failure, database unavailability and findings all fail the gate.
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: run.sh OUTPUT_DIRECTORY}
mkdir -p "$output"
output=$(cd "$output" && pwd)
cd "$repo_root"
[[ $(gitleaks version) == 8.30.1 ]] || { echo 'Install pinned Gitleaks with install-tools.sh' >&2; exit 2; }
[[ $(trivy --version | head -n1) == 'Version: 0.74.0' ]] || { echo 'Install pinned Trivy with install-tools.sh' >&2; exit 2; }
shellcheck --version | grep -qx 'version: 0.11.0' || { echo 'Install pinned ShellCheck with install-tools.sh' >&2; exit 2; }
if [[ $(git rev-parse --is-shallow-repository) == true ]]; then
  echo 'Full Git history is required for secret scanning; use fetch-depth: 0.' >&2
  exit 2
fi

# Stage the versioned working tree, including relevant untracked changes, but
# never private ignored .env files, node_modules, worktrees or old scan reports.
# This is inventory selection, not a scanner suppression/exception.
snapshot=$(mktemp -d)
trap 'rm -rf "$snapshot"' EXIT
git ls-files -z --cached --others --exclude-standard \
  | node --input-type=module -e 'import {existsSync} from "node:fs"; let data=""; for await (const chunk of process.stdin) data+=chunk; process.stdout.write(data.split("\0").filter(p=>p && existsSync(p)).join("\0")+"\0");' \
  | tar --null -T - -cf - | tar -xf - -C "$snapshot"
status=0
check() { "$@" || status=1; }
check gitleaks git --config .gitleaks.toml --gitleaks-ignore-path /dev/null --ignore-gitleaks-allow --redact --no-banner --log-opts=--all --report-format json --report-path "$output/secrets-history.json" .
check gitleaks dir --config .gitleaks.toml --gitleaks-ignore-path /dev/null --ignore-gitleaks-allow --redact --no-banner --report-format json --report-path "$output/secrets-tree.json" "$snapshot"
check trivy fs --ignorefile /dev/null --scanners vuln,license --include-dev-deps --severity HIGH,CRITICAL --exit-code 1 \
  --format json --output "$output/dependencies-licenses.json" "$snapshot"
check trivy fs --ignorefile /dev/null --scanners vuln --include-dev-deps --format cyclonedx --output "$output/source-sbom.cdx.json" "$snapshot"
pnpm licenses list --json > "$output/npm-licenses.json" || status=1

check trivy config --ignorefile /dev/null --misconfig-scanners dockerfile --severity HIGH,CRITICAL --exit-code 1 --format json \
  --output "$output/dockerfiles.json" "$snapshot"
check node --test scripts/security/*.test.mjs
shellcheck --severity=error --format=json scripts/security/*.sh \
  > "$output/shellcheck.json" || status=1
check pnpm audit --prod --audit-level high

SOURCE_COMMIT=$(git rev-parse HEAD) SCAN_STATUS=$status node --input-type=module - "$output" <<'NODE'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.argv[2], 'source-scan-summary.json'), JSON.stringify({
  schemaVersion: 'SourceScanSummary/v1', sourceCommit: process.env.SOURCE_COMMIT,
  workingTreeIncluded: true, passed: process.env.SCAN_STATUS === '0',
  checkedAt: new Date().toISOString(), tools: { gitleaks: '8.30.1', trivy: '0.74.0', shellcheck: '0.11.0' },
  certification: false, remainingReleaseGates: ['SAST', 'license obligation review', 'digest-pinned image scans', 'signed provenance', 'deployed configuration and functional certification'],
}, null, 2));
NODE
exit "$status"
