import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");

// Keep scratch space on the project disk, not tmpfs.
const scratchRoot = join(repoRoot, "target", "pack-test");

test(
  "the packed package installs and exposes its public entry points",
  { timeout: 180000 },
  async () => {
    rmSync(scratchRoot, { recursive: true, force: true });
    mkdirSync(scratchRoot, { recursive: true });

    // Pack the real artifact. `prepack` runs here, so the tarball is what npm
    // would publish.
    const output = execFileSync("npm", ["pack", "--json", "--pack-destination", scratchRoot], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    const [info] = JSON.parse(output) as Array<{ filename: string }>;
    assert.ok(info?.filename, "npm pack must report a filename");
    const tarball = join(scratchRoot, info.filename);
    assert.ok(statSync(tarball).size > 0, "tarball must not be empty");

    // The published tree must be dist/, the wasm and the docs. Shipping source
    // or test files is a packaging regression.
    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    for (const required of [
      "package/package.json",
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/dist/node.js",
      "package/dist/browser.js",
      "package/dist/advanced.js",
      "package/dist/engine/wasm.js",
      "package/wasm/rtc_tunnel.wasm",
      "package/LICENSE",
      "package/THIRD-PARTY.md",
    ]) {
      assert.ok(entries.includes(required), `tarball must contain ${required}`);
    }
    for (const forbidden of entries.filter((e) => e.startsWith("package/src/"))) {
      assert.fail(`tarball must not ship source: ${forbidden}`);
    }

    // Install the tarball into a real consumer, so the path below is exactly
    // what a user gets: TypeScript sources in node_modules are rejected by Node,
    // and this is the install that proves dist/ is what makes it work.
    const consumer = join(scratchRoot, "consumer");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "rtc-tunnel-consumer", private: true, type: "module" }),
    );
    execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
      cwd: consumer,
      encoding: "utf8",
      stdio: "pipe",
    });

    const smoke = join(consumer, "smoke.mjs");
    writeFileSync(
      smoke,
      `
import { readFile } from "node:fs/promises";

// The root entry is a type-only barrel; importing it must still resolve.
await import("@oxidezap/rtc-tunnel");

const node = await import("@oxidezap/rtc-tunnel/node");
if (typeof node.createNodeRelayProvider !== "function") {
  throw new Error("node entry is not loadable");
}

const advanced = await import("@oxidezap/rtc-tunnel/advanced");
if (typeof advanced.createRelayTransportProvider !== "function") {
  throw new Error("advanced entry is not loadable");
}

const { WasmTunnelModule } = await import("@oxidezap/rtc-tunnel/wasm");
const wasmUrl = new URL(import.meta.resolve("@oxidezap/rtc-tunnel/wasm/rtc_tunnel.wasm"));
const module = await WasmTunnelModule.load(await readFile(wasmUrl));
if (module.createTunnel === undefined) throw new Error("wasm did not load");

console.log("SMOKE_OK");
`,
    );
    const result = execFileSync("node", [smoke], { encoding: "utf8" });
    assert.match(result, /SMOKE_OK/);

    // A stale or duplicated wasm in the tarball is a release bug; there is
    // exactly one artifact and it is the one the loader finds.
    const wasmFiles = (await readdir(join(consumer, "node_modules/@oxidezap/rtc-tunnel/wasm"))).filter(
      (name) => name.endsWith(".wasm"),
    );
    assert.deepEqual(wasmFiles, ["rtc_tunnel.wasm"]);

    rmSync(scratchRoot, { recursive: true, force: true });
  },
);
