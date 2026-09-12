/**
 * Benchmark runner.
 *
 * Each backend runs in its own child process, so no backend inherits another's
 * heap, native libraries or JIT state. That is the only way an RSS or startup
 * number means anything: importing werift after wrtc in one process would
 * charge the second for the first.
 *
 * Every backend talks to the same neutral Pion peer over a real UDP path. The
 * runner picks the interface once and passes it down as BENCH_HOST, so all
 * processes bind and advertise the same address.
 *
 * Usage: node benches/run.ts [--json out.json]
 */

import { spawn } from "node:child_process";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { type BackendMetrics, type FootprintReport, printReport } from "./report/src/report.ts";
import { benchHost } from "./lib/peer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const BACKENDS = [
  { name: "rtc-tunnel (wasm + node:dgram)", path: join(here, "backends/rtc-tunnel.ts") },
  { name: "rtc-tunnel core (sans-io)", path: join(here, "backends/core.ts") },
  { name: "werift (werift + pion peer)", path: join(here, "backends/werift.ts") },
  { name: "@koush/wrtc (native + pion peer)", path: join(here, "backends/wrtc.ts") },
];

function runBackend(path: string, host: string): Promise<BackendMetrics> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--expose-gc", path], {
      cwd: root,
      env: { ...process.env, BENCH_HOST: host },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", () => {
      const match = /BENCH_JSON (\{.*\})/.exec(stdout);
      if (match) {
        resolve(JSON.parse(match[1]!) as BackendMetrics);
      } else {
        resolve({
          name: path,
          available: false,
          note: `backend produced no metrics: ${stderr.trim().split("\n").slice(-1)[0] ?? "unknown"}`,
        });
      }
    });
  });
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function footprint(): FootprintReport {
  const report: FootprintReport = {};

  const wasmPath = join(root, "target/wasm32-unknown-unknown/release/rtc_tunnel_wasm.wasm");
  try {
    const wasm = readFileSync(wasmPath);
    report.wasmRawBytes = wasm.length;
    report.wasmGzipBytes = gzipSync(wasm).length;
    report.wasmBrotliBytes = brotliCompressSync(wasm).length;
  } catch {
    // wasm not built
  }

  report.rustReleaseBinaryBytes = sizeOf(join(root, "target/release/rtc-tunnel-refpeer"));
  report.peerBinaryBytes = sizeOf(join(root, "target/bench-peer"));

  // Tarball size, if a pack has been produced.
  const packDir = join(root, "target");
  try {
    for (const entry of readdirSync(packDir)) {
      if (entry.endsWith(".tgz")) {
        report.npmTarballBytes = sizeOf(join(packDir, entry));
      }
    }
  } catch {
    // no pack output
  }

  return report;
}

async function main(): Promise<void> {
  const host = benchHost();
  console.log(`interface: ${host}`);

  const metrics: BackendMetrics[] = [];
  for (const backend of BACKENDS) {
    process.stdout.write(`running ${backend.name}... `);
    const result = await runBackend(backend.path, host);
    metrics.push(result);
    console.log(result.available ? "ok" : "n/a");
  }

  const fp = footprint();
  printReport(metrics, fp);

  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex !== -1) {
    const out = process.argv[jsonIndex + 1] ?? "target/bench-report.json";
    writeFileSync(
      out,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), host, metrics, footprint: fp },
        null,
        2,
      ),
    );
    console.log(`wrote ${out}`);
  }
}

await main();
