#!/usr/bin/env bash
# Install one Python service's locked dependencies into a virtualenv and run its checks.
#
#   scripts/python-check.sh <fincrime-host|evidence-pipeline|kyc-wiring|kyc-provider-atlas>
#
# PYTHON (default python3) picks the interpreter; VENV_ROOT (default .venv-py under the
# repository) holds one virtualenv per service so repeated runs reuse it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
service="${1:?usage: scripts/python-check.sh <fincrime-host|evidence-pipeline|kyc-wiring|kyc-provider-atlas>}"
python="${PYTHON:-python3}"
venv="${VENV_ROOT:-$root/.venv-py}/$service"

case "$service" in
  fincrime-host) dir="$root/apps/fincrime-host" ;;
  evidence-pipeline) dir="$root/apps/evidence-pipeline" ;;
  kyc-wiring) dir="$root/apps/kyc-wiring" ;;
  kyc-provider-atlas) dir="$root/tools/kyc-provider-atlas" ;;
  *) echo "unknown service: $service" >&2; exit 2 ;;
esac

[ -x "$venv/bin/python" ] || "$python" -m venv "$venv"
pip=("$venv/bin/python" -m pip install --quiet --disable-pip-version-check)
cd "$dir"
case "$service" in
  fincrime-host)
    "${pip[@]}" -r requirements-dev.lock
    "${pip[@]}" --no-deps -e .
    "$venv/bin/python" scripts/build_catalog.py --check
    "$venv/bin/python" scripts/build_document_catalog.py --check
    "$venv/bin/python" scripts/build_sourcing_manifest.py --check
    "$venv/bin/python" -m pytest -q -p no:cacheprovider
    "$venv/bin/python" -m financial_crime.cli validate
    ;;
  evidence-pipeline)
    "${pip[@]}" -r requirements-dev.lock
    "${pip[@]}" --no-deps -e .
    "$venv/bin/python" -m pytest -q -p no:cacheprovider
    ;;
  kyc-wiring)
    "${pip[@]}" -r requirements.txt -c requirements-tested.txt
    "$venv/bin/python" -m pytest -q -p no:cacheprovider
    ;;
  kyc-provider-atlas)
    "${pip[@]}" -r requirements.txt "pytest>=8,<10"
    "$venv/bin/python" -m pytest -q -p no:cacheprovider
    ;;
esac
