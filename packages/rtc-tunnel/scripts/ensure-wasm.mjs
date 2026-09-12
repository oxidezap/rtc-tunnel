#!/usr/bin/env node
// Copies the built wasm artifact into the package before packing.
//
// The artifact is not committed: `ring` compiles C with the host compiler, so
// the binary differs between machines and a committed copy would never match a
// fresh build. It is produced by scripts/build-wasm.sh with the pinned nightly.

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
