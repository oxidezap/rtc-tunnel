#!/usr/bin/env bash
#
# Installs the pinned wasm tooling that scripts/build-wasm.sh needs: `wasm-opt`
# (binaryen) for the size pass and `wasm-tools` for structural validation.
#
# Pinned by version and sha256 rather than fetched by `latest`, because these
# run on the release path and a new upstream default would silently change the
# published artifact. The checksums are for the x86_64-linux builds; CI runs on
# ubuntu-latest.
#
# Usage: scripts/install-wasm-tools.sh [--dest <dir>]

set -euo pipefail

dest="/usr/local/bin"
if [[ "${1:-}" == "--dest" ]]; then
  dest="${2:?--dest needs a directory}"
fi
mkdir -p "$dest"

binaryen_version="version_132"
binaryen_sha="195ddc94f9bc89f45abdabb0b9eea86023d727ba90eac8b35b80f2544fc30572"
wasm_tools_version="1.258.0"
wasm_tools_sha="b52d14eb74a4852cc249369bd4480c2b2fdd876145f41db51ff52269ded240ce"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$repo_root/target"
workdir="$(mktemp -d "$repo_root/target/install-wasm-tools.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT

fetch() {
  local url="$1" out="$2" sha="$3"
  curl -fsSL "$url" -o "$out"
  echo "$sha  $out" | sha256sum -c -
}

echo "installing binaryen $binaryen_version..."
fetch \
  "https://github.com/WebAssembly/binaryen/releases/download/${binaryen_version}/binaryen-${binaryen_version}-x86_64-linux.tar.gz" \
  "$workdir/binaryen.tar.gz" "$binaryen_sha"
tar -xzf "$workdir/binaryen.tar.gz" -C "$workdir"
install -m 0755 "$workdir/binaryen-${binaryen_version}/bin/wasm-opt" "$dest/wasm-opt"

echo "installing wasm-tools $wasm_tools_version..."
fetch \
  "https://github.com/bytecodealliance/wasm-tools/releases/download/v${wasm_tools_version}/wasm-tools-${wasm_tools_version}-x86_64-linux.tar.gz" \
  "$workdir/wasm-tools.tar.gz" "$wasm_tools_sha"
tar -xzf "$workdir/wasm-tools.tar.gz" -C "$workdir"
install -m 0755 "$workdir/wasm-tools-${wasm_tools_version}-x86_64-linux/wasm-tools" "$dest/wasm-tools"

# Query by absolute path: `$GITHUB_PATH` only reaches later steps, so the
# bare names are not on PATH yet inside this script.
echo "wasm-opt: $("$dest/wasm-opt" --version)"
echo "wasm-tools: $("$dest/wasm-tools" --version)"
