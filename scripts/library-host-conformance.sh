#!/usr/bin/env bash
# Run EHF's skill.execution.v1 conformance suite against the skill library's own host
# (apps/fincrime-host, python -m financial_crime.runtimes.skill_host).
#
# Needs the fincrime-host virtualenv from scripts/python-check.sh (VENV_ROOT as there) and the
# workspace's node_modules (pnpm install).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python="${VENV_ROOT:-$root/.venv-py}/fincrime-host/bin/python"
port="${SKILL_HOST_PORT:-18090}"
token="conformance-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
work="$(mktemp -d)"
trap 'kill "${host_pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT

"$python" "$root/apps/fincrime-host/scripts/skill_host_conformance_fixtures.py" > "$work/fixtures.json"
SKILL_HOST_AUTH_TOKEN="$token" SKILL_HOST_PORT="$port" SKILL_HOST_BIND=127.0.0.1 \
  "$python" -m financial_crime.runtimes.skill_host > "$work/host.log" 2>&1 &
host_pid=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$port/healthz" > /dev/null && break
  sleep 0.2
done
cd "$root"
SKILL_HOST_AUTH_TOKEN="$token" pnpm --filter @ehf/skill-conformance exec tsx src/cli.ts \
  --base-url "http://127.0.0.1:$port" --fixtures "$work/fixtures.json"
