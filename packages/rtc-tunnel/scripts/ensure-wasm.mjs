#!/usr/bin/env node
// Copies the freshly built wasm artifact into the package before packing.
//
// The canonical artifact is produced by scripts/build-wasm.sh with the pinned
// nightly, so this never rebuilds. It refuses to fall back to an existing
// bundled wasm: after a Rust change, a stale copy would otherwise ship silently.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");

const bundled = join(packageRoot, "wasm", "rtc_tunnel.wasm");
const built = join(
  repoRoot,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "rtc_tunnel_wasm.wasm",
);

if (!existsSync(built)) {
  console.error(
    "ensure-wasm: no built wasm artifact found.\n" +
      "  build it with: scripts/build-wasm.sh\n" +
      `  expected at:   ${built}`,
  );
  process.exit(1);
}

mkdirSync(dirname(bundled), { recursive: true });
copyFileSync(built, bundled);
console.error(`ensure-wasm: copied ${statSync(bundled).size} bytes from target`);
