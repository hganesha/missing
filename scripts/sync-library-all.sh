#!/usr/bin/env bash
# Regenerate everything derived from the in-repository skill library (apps/fincrime-host), in order:
# the library's own catalog and document assets, the platform's vendored snapshots, the KYB/KYC
# packages (and the KYB screening slice) and their compiled plans, the library host's bundle lock, and the UI pack's kyc pins.
#
#   PYTHON=<fincrime-host venv python> scripts/sync-library-all.sh [--check]
#
# --check regenerates nothing and fails on the first stale artifact (as CI does).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python="${PYTHON:-${VENV_ROOT:-$root/.venv-py}/fincrime-host/bin/python}"
check=""
[ "${1:-}" = "--check" ] && check="--check"
cd "$root"

(cd apps/fincrime-host && "$python" scripts/build_catalog.py $check && "$python" scripts/build_document_catalog.py $check)
for script in library-contracts business-skills kyb-package kyb-screening-package kyc-package connector-catalog library-bundle-lock; do
  node "scripts/sync-$script.mjs" $check
done
node scripts/ui-document-fixtures.mjs $check
if [ -n "$check" ]; then
  make compile > /dev/null && git diff --exit-code -- artifacts
else
  make compile > /dev/null
  python3 apps/fincrime-host/docs/ui/contracts/tools/repin_kyc.py
fi
