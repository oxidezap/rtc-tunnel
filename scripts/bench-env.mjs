#!/usr/bin/env node
// Records the machine and toolchain behind a benchmark run.
//
// Numbers from shared runners only make sense as a trend when each point says
// what it ran on, so the summary can tell a real change apart from a new
// runner image. Writes one JSON object; every version probe is optional and
// degrades to null instead of failing the run.
//
// Usage: node scripts/bench-env.mjs [out.json]

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release, arch } from "node:os";
import { dirname } from "node:path";

const out = process.argv[2] ?? "target/bench-env.json";

function probe(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 15000 }).trim();
  } catch {
    return null;
  }
}

function firstLine(text) {
  if (!text) return null;
  const line = text.split("\n")[0].trim();
  return line === "" ? null : line;
}

const cores = cpus();
const env = {
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  ref: process.env.GITHUB_REF ?? null,
  runnerOs: process.env.RUNNER_OS ?? null,
  runnerArch: process.env.RUNNER_ARCH ?? null,
  imageVersion: process.env.ImageVersion ?? null,
  platform: platform(),
  kernel: release(),
  arch: arch(),
  cpuModel: cores[0]?.model.trim() ?? null,
  logicalCpus: cores.length || null,
  node: process.version,
  npm: probe("npm", ["--version"]),
  go: firstLine(probe("go", ["version"])),
  rustc: firstLine(probe("rustc", ["--version"])),
  wasmOpt: firstLine(probe("wasm-opt", ["--version"])),
  wasmTools: firstLine(probe("wasm-tools", ["--version"])),
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(env, null, 2)}\n`);
console.log(`wrote ${out}`);
