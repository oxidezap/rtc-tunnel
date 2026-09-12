/**
 * Paired throughput comparison: rtc-tunnel against native wrtc.
 *
 * Nearby distributions cannot be separated by one run each, and separate
 * distributions with overlapping quartiles do not prove a tie or a win. This
 * runs the two backends in pairs, alternating order, and reports the ratio
 * `tunnel / wrtc` per pair with a bootstrap confidence interval. The win
 * condition is a 95% interval whose lower bound is above 1.0.
 *
 * Pinning is opt-in for shared machines: set STATS_DUT_CPUS and
 * STATS_PEER_CPUS to pin the backends and the peer apart, so the comparison
 * is not dominated by scheduler placement. Unset, everything floats.
 *
 * Run with `node --expose-gc benches/stats.ts` or `npm run bench:stats`.
 */

import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { BackendMetrics } from "./report/src/report.ts";
import { benchHost } from "./lib/peer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PAIRS = Number(process.env.STATS_PAIRS ?? 20);
const DURATION_MS = Number(process.env.STATS_MS ?? 3000);
const PAYLOAD = Number(process.env.STATS_PAYLOAD ?? 1200);
const WINDOW = Number(process.env.STATS_WINDOW ?? 256);
const DUT_CPUS = process.env.STATS_DUT_CPUS;
const PEER_CPUS = process.env.STATS_PEER_CPUS;

const BACKENDS = {
  tunnel: join(here, "backends/rtc-tunnel.ts"),
  wrtc: join(here, "backends/wrtc.ts"),
} as const;

type BackendName = keyof typeof BACKENDS;

/** Runs one backend and returns its video throughput, or null on failure. */
function runBackend(name: BackendName, host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const command = DUT_CPUS ? "taskset" : process.execPath;
    const args = DUT_CPUS
      ? ["-c", DUT_CPUS, process.execPath, "--expose-gc", BACKENDS[name]]
      : ["--expose-gc", BACKENDS[name]];
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        BENCH_HOST: host,
        ...(PEER_CPUS ? { BENCH_PEER_CPUS: PEER_CPUS } : {}),
        BENCH_SKIP: "rtt,burst,cadence,lifecycle",
        BENCH_THROUGHPUT_MS: String(DURATION_MS),
        BENCH_VIDEO_PAYLOAD: String(PAYLOAD),
        BENCH_VIDEO_WINDOW: String(WINDOW),
        BENCH_CONNECT_SAMPLES: "1",
        BENCH_LIFECYCLE_COUNTS: "1",
      },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", () => {});
    child.on("close", () => {
      const match = /BENCH_JSON (\{.*\})/.exec(stdout);
      if (!match) return resolve(null);
      const metrics = JSON.parse(match[1]!) as BackendMetrics;
      resolve(metrics.throughput?.video?.messagesPerSecond ?? null);
    });
  });
}

/** Percentile of an already sorted array. */
function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

/**
 * Bootstrap the median ratio. Resampling pairs with replacement gives a
 * distribution of the median that does not assume the ratios are normal.
 */
function bootstrapMedianCI(ratios: number[], iterations = 5000): { low: number; high: number } {
  const n = ratios.length;
  const medians: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample: number[] = [];
    for (let j = 0; j < n; j++) sample.push(ratios[Math.floor(Math.random() * n)]!);
    sample.sort((a, b) => a - b);
    medians.push(sample[Math.floor(sample.length / 2)]!);
  }
  medians.sort((a, b) => a - b);
  return { low: quantile(medians, 0.025), high: quantile(medians, 0.975) };
}

async function main(): Promise<void> {
  const host = benchHost();
  const cpuCount = cpus().length;
  const affinity = DUT_CPUS
    ? `CPU affinity: pinned (DUT ${DUT_CPUS}, peer ${PEER_CPUS ?? "any"})`
    : `CPU affinity: unpinned (${cpuCount} logical CPUs; alternating pair order is the control)`;
  console.log(
    `paired throughput: ${PAIRS} pairs, ${PAYLOAD} B, window ${WINDOW}, ${DURATION_MS} ms per run\n` +
      `  ${affinity}, interface ${host}`,
  );

  const tunnelRuns: number[] = [];
  const wrtcRuns: number[] = [];
  const ratios: number[] = [];

  for (let i = 0; i < PAIRS; i++) {
    process.stdout.write(`\r  pair ${i + 1}/${PAIRS}...`);
    // Alternate which backend runs first so a thermal or load drift favors
    // neither side.
    let tunnel: number | null;
    let wrtc: number | null;
    if (i % 2 === 0) {
      tunnel = await runBackend("tunnel", host);
      wrtc = await runBackend("wrtc", host);
    } else {
      wrtc = await runBackend("wrtc", host);
      tunnel = await runBackend("tunnel", host);
    }
    if (tunnel === null || wrtc === null || wrtc === 0) continue;
    tunnelRuns.push(tunnel);
    wrtcRuns.push(wrtc);
    ratios.push(tunnel / wrtc);
  }
  process.stdout.write("\r" + " ".repeat(30) + "\r");

  if (ratios.length === 0) {
    console.log("no complete pairs collected");
    return;
  }

  const ci = bootstrapMedianCI(ratios);
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const tunnelMedian = quantile(
    [...tunnelRuns].sort((a, b) => a - b),
    0.5,
  );
  const wrtcMedian = quantile(
    [...wrtcRuns].sort((a, b) => a - b),
    0.5,
  );

  console.log(`  tunnel median   ${Math.round(tunnelMedian)} msg/s`);
  console.log(`  wrtc median     ${Math.round(wrtcMedian)} msg/s`);
  console.log(`  ratio median    ${median.toFixed(3)}`);
  console.log(
    `  ratio p25/p75   ${quantile(sorted, 0.25).toFixed(3)} / ${quantile(sorted, 0.75).toFixed(3)}`,
  );
  console.log(`  ratio 95% CI    ${ci.low.toFixed(3)} .. ${ci.high.toFixed(3)}`);
  const wins = ratios.filter((r) => r > 1).length;
  console.log(`  pairs           ${ratios.length}, tunnel ahead in ${wins}`);
  const verdict =
    ci.low > 1.0
      ? "tunnel is ahead with 95% confidence"
      : ci.high < 1.0
        ? "wrtc is ahead with 95% confidence"
        : "no significant difference at 95%";
  console.log(`  verdict         ${verdict}`);
  // Machine-readable result for the CI summary. The human lines above stay
  // the source of truth in raw logs.
  console.log(
    `STATS_JSON ${JSON.stringify({
      pairs: PAIRS,
      completePairs: ratios.length,
      payloadBytes: PAYLOAD,
      window: WINDOW,
      durationMs: DURATION_MS,
      tunnelMedian: Math.round(tunnelMedian),
      wrtcMedian: Math.round(wrtcMedian),
      ratioMedian: Number(median.toFixed(3)),
      ratioP25: Number(quantile(sorted, 0.25).toFixed(3)),
      ratioP75: Number(quantile(sorted, 0.75).toFixed(3)),
      ciLow: Number(ci.low.toFixed(3)),
      ciHigh: Number(ci.high.toFixed(3)),
      wins,
      verdict,
      affinity: DUT_CPUS
        ? { pinned: true, dut: DUT_CPUS, peer: PEER_CPUS ?? null, logicalCpus: cpuCount }
        : { pinned: false, logicalCpus: cpuCount },
    })}`,
  );
}

await main();
