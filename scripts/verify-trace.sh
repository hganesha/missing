#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/identity.sh"

run_id="${1:?usage: scripts/verify-trace.sh RUN-ID}"
api="${CONTROL_API_URL:-http://127.0.0.1:4100}"
jaeger="${JAEGER_API_URL:-http://127.0.0.1:16686}"
trace_id="$(curl -fsS "${edge_auth[@]}" "$api/v1/runs/$run_id/trace" | jq -r '.traceId')"

trace_json=""
for _ in $(seq 1 15); do
  trace_json="$(curl -fsS "$jaeger/api/traces/$trace_id" 2>/dev/null || true)"
  if [[ "$(printf '%s' "$trace_json" | jq -r '.data | length' 2>/dev/null)" == "1" ]]; then break; fi
  sleep 1
done

printf '%s' "$trace_json" | jq -e --arg trace "$trace_id" '
  .data[0].traceID == $trace and
  ([.data[0].processes[].serviceName] | unique | sort) ==
    ["harness-capability-gateway", "harness-runtime-dispatcher", "harness-runtime-host"] and
  ([.data[0].spans[].operationName] | unique) as $names |
  ["harness.run", "workflow.transition", "capability.request", "capability.invoke", "authorization.evaluate"] |
  all(. as $required | $names | index($required) != null)
' >/dev/null

printf 'verified trace %s for %s\n' "$trace_id" "$run_id"
