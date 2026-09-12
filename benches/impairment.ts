/**
 * Impairment suite: runs the tunnel against the neutral peer under loss,
 * jitter and reordering, and reports open success, setup latency and delivered
 * traffic for each profile.
 *
 * Loopback with zero impairment hides more than it shows. Every profile below
 * reuses the same peer, the same UDP path and the same channel parameters; only
 * the impairment changes. The measurement is the product backend in a child
 * process, with the heavy phases skipped so the run stays short under loss.
 *
 * Usage: node --expose-gc benches/impairment.ts
 */

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { BackendMetrics } from "./report/src/report.ts";
import { benchHost } from "./lib/peer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const backend = join(here, "backends/rtc-tunnel.ts");

interface Profile {
  name: string;
  loss?: number;
  jitterMs?: number;
  reorder?: number;
}

const PROFILES: Profile[] = [
  { name: "clean" },
  { name: "loss 1%", loss: 0.01 },
  { name: "loss 3%", loss: 0.03 },
  { name: "jitter +-5ms", jitterMs: 5 },
  { name: "jitter +-20ms", jitterMs: 20 },
  { name: "reorder 1%", reorder: 0.01 },
];

const CONNECT_SAMPLES = 30;
const THROUGHPUT_MS = 3000;

function runProfile(profile: Profile, host: string): Promise<BackendMetrics> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BENCH_HOST: host,
      BENCH_CONNECT_SAMPLES: String(CONNECT_SAMPLES),
      BENCH_THROUGHPUT_MS: String(THROUGHPUT_MS),
      BENCH_LIFECYCLE_COUNTS: "5",
      BENCH_SKIP: "rtt,burst,cadence",
      BENCH_HANDSHAKE_MS: "5000",
    };
    if (profile.loss !== undefined) env.BENCH_LOSS = String(profile.loss);
    if (profile.jitterMs !== undefined) env.BENCH_JITTER_MS = String(profile.jitterMs);
    if (profile.reorder !== undefined) env.BENCH_REORDER = String(profile.reorder);

    const child = spawn(process.execPath, ["--expose-gc", backend], { cwd: repoRoot, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", () => {
      const match = /BENCH_JSON (\{.*\})/.exec(stdout);
      if (match) resolve(JSON.parse(match[1]!) as BackendMetrics);
      else
        resolve({
          name: "rtc-tunnel",
          available: false,
          note: stderr.trim().split("\n").slice(-1)[0] ?? "no metrics",
        });
    });
  });
}

async function main(): Promise<void> {
  const host = benchHost();
  const rows: Array<Record<string, string | number>> = [];

  for (const profile of PROFILES) {
    process.stdout.write(`running ${profile.name}... `);
    const start = performance.now();
    const metrics = await runProfile(profile, host);
    const wall = ((performance.now() - start) / 1000).toFixed(1);
    if (!metrics.available) {
      console.log("failed");
      rows.push({ profile: profile.name, state: "failed", note: metrics.note ?? "" });
      continue;
    }
    rows.push({
      profile: profile.name,
      "open p50 ms": metrics.createOpenMs!.p50.toFixed(1),
      "open p95 ms": metrics.createOpenMs!.p95.toFixed(1),
      "open fail": metrics.openFailures ?? 0,
      opened: metrics.createOpenMs!.samples,
      "video msg/s": Math.round(metrics.throughput?.video?.messagesPerSecond ?? 0),
      refused: metrics.throughput?.video?.backpressure ?? 0,
      "rss MiB": ((metrics.memory?.at(-1)?.rssBytes ?? 0) / 1048576).toFixed(1),
      "wall s": wall,
    });
    console.log("ok");
  }

  console.table(rows);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), profiles: rows }));
}

await main();
