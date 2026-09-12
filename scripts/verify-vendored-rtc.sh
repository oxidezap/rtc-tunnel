#!/usr/bin/env bash
#
# Verifies that `vendor/rtc` is the pinned upstream source plus exactly the
# patches listed in `patches/rtc/`.
#
# It reconstructs the source from a local registry copy and applies the patches,
# then diffs the result against `vendor/rtc/src`. A mismatch means the vendored
# tree drifted: someone edited it directly, or a patch is missing from the list.
#
# Usage:
#   scripts/verify-vendored-rtc.sh            # check against the local registry
#   scripts/verify-vendored-rtc.sh <rtc-src>  # check against an explicit source
#
# The registry path is discovered from `$CARGO_HOME` or `~/.cargo`. If the
# pinned source is not present, pass its `src` to check a checkout.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

rtc_version="0.21.0-rc.2"
if [[ $# -ge 1 ]]; then
  upstream="$1"
else
  cargo_home="${CARGO_HOME:-$HOME/.cargo}"
  upstream="$(find "$cargo_home/registry/src" -maxdepth 2 -type d -name "rtc-$rtc_version" 2>/dev/null | head -1)/src"
  if [[ ! -d "$upstream" ]]; then
    echo "could not find rtc-$rtc_version sources; pass the src path explicitly" >&2
    exit 2
  fi
fi

mkdir -p target
workdir="$(mktemp -d target/verify-rtc.XXXXXX)"
trap 'rm -rf "$workdir"' EXIT

cp -r "$upstream" "$workdir/src"

shopt -s nullglob
patches=(patches/rtc/*.patch)
if [[ ${#patches[@]} -eq 0 ]]; then
  echo "no patches found in patches/rtc" >&2
  exit 1
fi

for patch_file in "${patches[@]}"; do
  echo "applying $(basename "$patch_file")"
  (cd "$workdir" && patch -p1 --silent < "$repo_root/$patch_file")
done

if diff -r "$workdir/src" vendor/rtc/src >/dev/null; then
  echo "ok: vendor/rtc matches upstream $rtc_version plus ${#patches[@]} patch(es)"
else
  echo "MISMATCH: vendor/rtc differs from upstream plus patches:" >&2
  diff -r "$workdir/src" vendor/rtc/src >&2 || true
  exit 1
fi
