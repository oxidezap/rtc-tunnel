/**
 * Benchmark backend: the Rust Sans-I/O core, no socket and no JavaScript.
 *
 * It shells out to the `core-bench` example, which wires two `Tunnel`s directly
 * and times `send`/`receive`/`poll_event`. The gap between this and the product
 * backend is the cost of the JS and UDP boundary.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type BackendMetrics, emitMetrics } from "../report/src/report.ts";
import { repoRoot } from "../lib/peer.ts";

const binary = join(repoRoot, "target/release/examples/core-bench");

function run(): Promise<BackendMetrics> {
  return new Promise((resolve) => {
    const child = spawn(binary, [], {
      env: {
        ...process.env,
        CORE_MESSAGES: process.env.CORE_MESSAGES ?? "200000",
        CORE_PAYLOAD: process.env.CORE_PAYLOAD ?? "1200",
        CORE_WINDOW: process.env.CORE_WINDOW ?? "128",
      },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(`[core] ${chunk}`));
    child.on("close", () => {
      const match = /BENCH_JSON (\{.*\})/.exec(stdout);
      if (match) resolve(JSON.parse(match[1]!) as BackendMetrics);
      else
        resolve({
          name: "rtc-tunnel core (sans-io)",
          available: false,
          note: "core-bench produced no metrics",
        });
    });
  });
}

if (!existsSync(binary)) {
  emitMetrics({
    name: "rtc-tunnel core (sans-io)",
    available: false,
    note: "build with: cargo build --release --example core-bench -p rtc-tunnel-core",
  });
} else {
  emitMetrics(await run());
}
