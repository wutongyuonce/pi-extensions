#!/usr/bin/env bash
# Run the official MCP client conformance scenarios against pi-mcp-adapter's
# real McpServerManager and OAuth stack.
#
# Usage:
#   npm run test:conformance
#   bash conformance/run.sh --scenario initialize
#   bash conformance/run.sh --scenario auth/metadata-default --verbose
set -euo pipefail

cd "$(dirname "$0")/.."

RESULTS_DIR="${CONFORMANCE_RESULTS_DIR:-conformance/results}"
BASELINE="conformance/baseline-client.yml"
DRIVER="bash conformance/driver.sh"
TIMEOUT="${CONFORMANCE_TIMEOUT_MS:-90000}"

run_scenario() {
  local scenario="$1"
  shift
  npx conformance client \
    --command "$DRIVER" \
    --scenario "$scenario" \
    --expected-failures "$BASELINE" \
    --timeout "$TIMEOUT" \
    --output-dir "$RESULTS_DIR" \
    "$@"
}

is_baselined() {
  grep -Fqx "  - $1" "$BASELINE"
}

allows_client_error() {
  [[ "$1" == "auth/scope-retry-limit" || "$1" == "auth/resource-mismatch" ]]
}

# Preserve the official CLI's focused-scenario workflow. Full-suite execution
# below is deliberately sequential: pre-registered clients bind an exact local
# callback port, so the CLI's parallel --suite mode creates false port-contention
# failures between otherwise independent scenarios.
focused_scenario=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "--scenario" ]]; then
    focused_scenario="$argument"
    break
  fi
  previous="$argument"
done

if [[ -n "$focused_scenario" ]]; then
  focused_log="$(mktemp "${TMPDIR:-/tmp}/pi-mcp-conformance-log.XXXXXX")"
  trap 'rm -f "$focused_log"' EXIT
  set +e
  npx conformance client \
    --command "$DRIVER" \
    --expected-failures "$BASELINE" \
    --timeout "$TIMEOUT" \
    --output-dir "$RESULTS_DIR" \
    "$@" 2>&1 | tee "$focused_log"
  focused_status=${PIPESTATUS[0]}
  set -e
  if [[ "$focused_status" -ne 0 ]]; then
    exit "$focused_status"
  fi
  if grep -q "Client timed out after" "$focused_log"; then
    echo "MCP client conformance timed out" >&2
    exit 1
  fi
  if grep -q "Client exited with code" "$focused_log" \
    && ! is_baselined "$focused_scenario" \
    && ! allows_client_error "$focused_scenario"; then
    echo "MCP client exited unexpectedly despite passing wire checks" >&2
    exit 1
  fi
  exit 0
fi

if [[ " $* " == *" --suite "* ]]; then
  echo "conformance/run.sh runs the complete client matrix sequentially; use --scenario for a focused run" >&2
  exit 2
fi

rm -rf "$RESULTS_DIR"
mkdir -p "$RESULTS_DIR"

scenarios="$({ npx conformance list --client 2>/dev/null || true; } |
  awk '/^Client scenarios/{found=1; next} found && /^  - /{print $2}')"
if [[ -z "$scenarios" ]]; then
  echo "Unable to list MCP client conformance scenarios" >&2
  exit 1
fi

failed=0
log_file="$(mktemp "${TMPDIR:-/tmp}/pi-mcp-conformance-log.XXXXXX")"
trap 'rm -f "$log_file"' EXIT

while IFS= read -r scenario; do
  [[ -z "$scenario" ]] && continue
  printf '%-52s' "$scenario"
  if run_scenario "$scenario" "$@" >"$log_file" 2>&1; then
    # conformance 0.1.16's baseline check only evaluates wire checks. Do not
    # let it hide an unexpected client-process failure after those checks ran.
    if grep -q "Client timed out after" "$log_file"; then
      echo "FAIL"
      tail -40 "$log_file"
      failed=1
    elif grep -q "Client exited with code" "$log_file" \
      && ! is_baselined "$scenario" \
      && ! allows_client_error "$scenario"; then
      echo "FAIL"
      tail -40 "$log_file"
      failed=1
    else
      echo "PASS"
    fi
  else
    echo "FAIL"
    tail -40 "$log_file"
    failed=1
  fi
done <<< "$scenarios"

if [[ "$failed" -ne 0 ]]; then
  echo "MCP client conformance failed; inspect $RESULTS_DIR" >&2
  exit 1
fi

echo "All MCP client conformance scenarios passed or matched the reviewed baseline."
