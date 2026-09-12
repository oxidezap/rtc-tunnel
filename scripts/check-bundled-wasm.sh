#!/usr/bin/env bash
#
# Fails if the wasm bundled in the npm package is not byte-for-byte the artifact
# the pinned build produces. The build is deterministic, so any difference means
# the package is carrying a stale binary that predates the current Rust source.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "building the canonical wasm artifact..."
./scripts/build-wasm.sh >/dev/null
built="target/wasm32-unknown-unknown/release/rtc_tunnel_wasm.wasm"
bundled="packages/rtc-tunnel/wasm/rtc_tunnel.wasm"

if [[ ! -f "$bundled" ]]; then
  echo "FAIL: $bundled is missing; run packages/rtc-tunnel/scripts/ensure-wasm.mjs" >&2
  exit 1
fi

built_hash=$(sha256sum "$built" | awk '{print $1}')
bundled_hash=$(sha256sum "$bundled" | awk '{print $1}')

if [[ "$built_hash" != "$bundled_hash" ]]; then
  echo "FAIL: bundled wasm is stale" >&2
  echo "  built:   $built_hash  ($(stat -c%s "$built") bytes)" >&2
  echo "  bundled: $bundled_hash  ($(stat -c%s "$bundled") bytes)" >&2
  echo "  run: packages/rtc-tunnel/scripts/ensure-wasm.mjs" >&2
  exit 1
fi

echo "ok: bundled wasm matches the canonical build ($built_hash)"
