#!/usr/bin/env bash
#
# Builds the shipped wasm artifact and enforces its size budget.
#
# The budget is a product constraint: the module is downloaded by every client,
# so raw size affects install and compile cost. It is deliberately generous
# enough that an intentional throughput trade is not blocked, but a large
# accidental growth fails the gate. The budget is not a recorded measurement.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

budget_raw=1310720 # 1.25 MiB

echo "building shipped artifact..."
./scripts/build-wasm.sh >/dev/null
shipped="target/wasm32-unknown-unknown/release/rtc_tunnel_wasm.wasm"
raw=$(stat -c%s "$shipped")

if (( raw > budget_raw )); then
  echo "FAIL: shipped wasm is $raw bytes, over the $budget_raw-byte budget" >&2
  exit 1
fi

echo "ok: shipped wasm is $raw bytes, within the $budget_raw-byte budget"
