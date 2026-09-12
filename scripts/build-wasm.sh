#!/usr/bin/env bash
#
# Builds the shipped `rtc-tunnel-wasm` artifact for `wasm32-unknown-unknown`
# with no WASI and no wasm-bindgen.
#
# The module is tuned for throughput: the crypto and SCTP crates that dominate
# the profile compile at `opt-level=3`, everything else stays at `z`, and a
# `wasm-opt -Oz` pass shrinks the result. The size budget is enforced separately
# by scripts/check-wasm-size.sh.
#
# std on bare wasm has no clock and panics on random, so `-Zbuild-std` rebuilds
# it with `scripts/wasm-std/{time,random}.rs` routed to host imports named
# `now_micros`, `unix_millis` and `fill_random` in the `rtc_tunnel` module.
#
# The toolchain is never modified in place. `RUSTUP_HOME` defaults to a
# disposable directory outside `target/`, so `rm -rf .cache` removes every trace
# and a CI cache that restores `target/` never brings back the patched std.
# `CARGO_HOME` stays under `target/` so the crate cache survives. Point
# `RTC_TUNNEL_CARGO_HOME` at an existing cargo home to reuse its crate cache.
#
# Usage: scripts/build-wasm.sh [--debug]

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mode="perf"
if [[ "${1:-}" == "--debug" ]]; then
  mode="debug"
fi

# Isolated, disposable homes. The toolchain lives outside target/ on purpose:
# `target/` is what CI caches, and a restored patched std makes
# `rustup toolchain install` fail on the modified rust-src.
export RUSTUP_HOME="${RTC_TUNNEL_RUSTUP_HOME:-$repo_root/.cache/rustup}"
export CARGO_HOME="${RTC_TUNNEL_CARGO_HOME:-$repo_root/target/cargo-home}"
mkdir -p "$RUSTUP_HOME" "$CARGO_HOME"

# The rustup on PATH is itself a proxy that expects the real rustup binary to
# live under `$CARGO_HOME/bin`. With CARGO_HOME redirected that check fails, so
# make the real binary reachable there.
if [[ ! -e "$CARGO_HOME/bin/rustup" ]]; then
  mkdir -p "$CARGO_HOME/bin"
  real_rustup="$(command -v rustup)"
  ln -sf "$real_rustup" "$CARGO_HOME/bin/rustup"
  ln -sf rustup "$CARGO_HOME/bin/cargo"
  ln -sf rustup "$CARGO_HOME/bin/rustc"
fi

# Prefer the isolated proxies so this script uses the isolated homes even if
# the caller's PATH points at another rustup installation.
export PATH="$CARGO_HOME/bin:$PATH"

toolchain="$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' rust-toolchain.toml)"
if [[ -z "$toolchain" ]]; then
  echo "error: could not read a channel from rust-toolchain.toml" >&2
  exit 1
fi
if [[ "$toolchain" != *nightly* ]]; then
  echo "error: build-std requires a nightly toolchain, pinned is '$toolchain'" >&2
  exit 1
fi

echo "toolchain:  $toolchain"
echo "RUSTUP_HOME=$RUSTUP_HOME"
echo "CARGO_HOME=$CARGO_HOME"

# Install the pinned toolchain and its sources into the isolated home when they
# are missing. A patched `rust-src` makes `rustup toolchain install --component
# rust-src` fail on the modified files, so the two are added separately and only
# when absent.
has_rust_src() {
  rustup run "$toolchain" rustc --print sysroot >/dev/null 2>&1 &&
    [[ -d "$(rustup run "$toolchain" rustc --print sysroot)/lib/rustlib/src/rust/library/std/src/sys" ]]
}
if ! has_rust_src; then
  rustup toolchain install "$toolchain" --profile minimal >/dev/null
  rustup component add --toolchain "$toolchain" rust-src >/dev/null
fi

sysroot="$(rustup run "$toolchain" rustc --print sysroot)"
std_sys="$sysroot/lib/rustlib/src/rust/library/std/src/sys"
if [[ ! -d "$std_sys" ]]; then
  echo "error: rust-src not found under $std_sys" >&2
  exit 1
fi

install_override() {
  local src="$1" dst="$2"
  if cmp -s "$src" "$dst"; then
    return
  fi
  cp "$src" "$dst"
  echo "patched $(basename "$dst")"
}

install_override "scripts/wasm-std/time.rs" "$std_sys/time/unsupported.rs"
install_override "scripts/wasm-std/random.rs" "$std_sys/random/unsupported.rs"

# Backend selection. `direct` drives the protocol crates and is the shipped
# default; `rtc` keeps the umbrella peer connection as a fallback. Both expose
# the same C ABI.
backend="${RTC_TUNNEL_BACKEND:-direct}"
case "$backend" in
  rtc) feature_args=(--no-default-features --features rtc-backend) ;;
  direct) feature_args=(--no-default-features --features direct) ;;
  *) echo "error: RTC_TUNNEL_BACKEND must be 'rtc' or 'direct', got '$backend'" >&2; exit 1 ;;
esac

if [[ "$mode" == "debug" ]]; then
  echo "building debug wasm (backend=$backend)"
  cargo -Zbuild-std=std,panic_abort build \
    "${feature_args[@]}" \
    -p rtc-tunnel-wasm \
    --target wasm32-unknown-unknown
  artifact="target/wasm32-unknown-unknown/debug/rtc_tunnel_wasm.wasm"
  ls -l "$artifact"
  echo "ok: $artifact"
  exit 0
fi

if ! command -v wasm-opt >/dev/null 2>&1; then
  echo "error: wasm-opt is required to build the shipped artifact" >&2
  exit 1
fi

# `panic = "immediate-abort"` needs opting in through a `cargo-features` line.
# Add it for the run and remove it on exit so the manifest stays clean.
manifest="$repo_root/Cargo.toml"
added=false
if ! head -n1 "$manifest" | grep -q '^cargo-features'; then
  printf 'cargo-features = ["panic-immediate-abort"]\n\n' | cat - "$manifest" > "$manifest.tmp"
  mv "$manifest.tmp" "$manifest"
  added=true
fi
cleanup() {
  if $added; then
    sed -i '1{/^cargo-features = \["panic-immediate-abort"\]$/d}' "$manifest"
    sed -i '1{/^$/d}' "$manifest"
  fi
}
trap cleanup EXIT

# The getrandom custom-backend cfg normally comes from .cargo/config.toml. A
# RUSTFLAGS env var replaces that, so include it explicitly. Cargo encodes
# multiple flags with the unit separator.
sep=$'\x1f'
encoded="--cfg${sep}getrandom_backend=\"custom\"${sep}-Zlocation-detail=none"

echo "building shipped wasm ($toolchain, backend=$backend)"
CARGO_TARGET_DIR="$repo_root/target/wasm-build" \
CARGO_PROFILE_RELEASE_PANIC=immediate-abort \
CARGO_ENCODED_RUSTFLAGS="$encoded" \
  "$CARGO_HOME/bin/cargo" +"$toolchain" \
    -Zbuild-std=std,panic_abort \
    -Zbuild-std-features=optimize_for_size \
    --config 'profile.release.package.ring.opt-level=3' \
    --config 'profile.release.package.rtc-dtls.opt-level=3' \
    --config 'profile.release.package.rtc-sctp.opt-level=3' \
    --config 'profile.release.package.crc32c.opt-level=3' \
    build --release "${feature_args[@]}" -p rtc-tunnel-wasm --target wasm32-unknown-unknown

input="target/wasm-build/wasm32-unknown-unknown/release/rtc_tunnel_wasm.wasm"
optimized="target/wasm-build/wasm32-unknown-unknown/release/rtc_tunnel_wasm.release.wasm"
artifact="target/wasm32-unknown-unknown/release/rtc_tunnel_wasm.wasm"

features=(
  --enable-bulk-memory
  --enable-bulk-memory-opt
  --enable-nontrapping-float-to-int
  --enable-mutable-globals
  --enable-sign-ext
  --enable-reference-types
  --enable-multivalue
  --enable-extended-const
)
wasm-opt "${features[@]}" -Oz "$input" -o "$optimized"

# A module can pass structural validation and still use a feature the target
# runtime rejects, so check both here rather than discover it at load time.
wasm-tools validate "$optimized"
node -e "
const { readFileSync } = require('node:fs');
WebAssembly.compile(readFileSync('$optimized'))
  .then(() => process.exit(0))
  .catch((err) => { console.error(err.message); process.exit(1); });
"

# Publish to the canonical path. Cargo hardlinks release outputs into the
# target dir, so overwriting in place with cp could corrupt its cache; rename a
# fresh copy instead, which replaces the directory entry and leaves the
# original inode untouched.
mkdir -p "$(dirname "$artifact")"
tmp="$artifact.tmp.$$"
cp "$optimized" "$tmp"
mv "$tmp" "$artifact"

before=$(stat -c%s "$input")
after=$(stat -c%s "$optimized")
pct=$(awk "BEGIN { printf \"%.1f\", (1 - $after / $before) * 100 }")
echo "release input (pre wasm-opt): $before bytes"
echo "release output:               $after bytes (-$pct%)"
ls -l "$artifact"
echo "ok: $artifact"
