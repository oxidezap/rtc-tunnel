#!/usr/bin/env bash
#
# Builds everything the benchmark runner needs: the wasm artifact, the native
# reference peer, the neutral Pion peer and the Sans-I/O core benchmark.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "building wasm artifact..."
./scripts/build-wasm.sh

echo "building native reference peer..."
cargo build -p rtc-tunnel-refpeer

echo "building neutral Pion peer..."
(cd benches/peer && go build -o "$repo_root/target/bench-peer" .)

echo "building core benchmark..."
cargo build --release --example core-bench -p rtc-tunnel-core

echo "ok: target/bench-peer, target/release/examples/core-bench"
