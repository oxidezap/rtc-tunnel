#!/usr/bin/env bash
#
# Runs every check that must hold before a commit or tag: vendored-rtc
# integrity, formatting, clippy, the Rust and JS tests, the shipped wasm size
# budget, the bundled wasm freshness, and the TypeScript build.
#
# Usage: scripts/golden.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail=0
step() {
  echo
  echo "== $1 =="
}

step "vendored rtc integrity"
scripts/verify-vendored-rtc.sh || fail=1

step "rust fmt"
cargo fmt --all -- --check || fail=1

step "rust clippy"
cargo clippy --all --tests -- -D warnings || fail=1

step "rust tests (direct backend)"
cargo test --workspace || fail=1

step "rust tests (umbrella backend)"
cargo test -p rtc-tunnel-core --no-default-features --features rtc-backend \
  --test interop --test lifecycle --test fuzz || fail=1

step "direct interop against the rtc reference peer"
cargo test -p rtc-tunnel-core --test direct || fail=1

step "shipped wasm size budget"
scripts/check-wasm-size.sh || fail=1

step "bundled wasm is the canonical build"
scripts/check-bundled-wasm.sh || fail=1

step "typescript build and typecheck"
(cd packages/rtc-tunnel && npm run build) || fail=1

step "js package tests"
(cd packages/rtc-tunnel && node --test) || fail=1

echo
if [[ "$fail" -eq 0 ]]; then
  echo "golden: all gates passed"
else
  echo "golden: one or more gates failed" >&2
fi
exit "$fail"
