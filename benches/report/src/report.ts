/**
 * Benchmark metrics and reporting.
 *
 * A backend writes one JSON object per process, so backends cannot share
 * heaps, timers or JIT state. The runner collects those objects and prints a
 * table. Every metric is optional: a backend reports only what it can measure
 * honestly.
 *
 * The metrics are grouped by phase because mixing them was the flaw in the
 * first version of this benchmark:
 *
 *   cold      one-time process and module cost
 *   create    one connection, from call to channel open
 *   stages    where the create time went, when the stack exposes it
 *   rtt       one message in flight, no polling
 *   throughput  a bounded window kept full for a fixed wall time
 *   lifecycle many connections, watching memory
 *   memory    snapshots at named points, including PSS and high-water mark
 */

import { readFileSync } from "node:fs";

export interface LatencyStats {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

/** One-time cost paid before the first connection. */
interface ColdStats {
  /** Dynamic import of the library, or reading the wasm artifact. */
  importMs?: number;
  /** `WebAssembly.compile`, when the backend compiles wasm itself. */
  compileMs?: number;
  /** `WebAssembly.instantiate` for the first module instance. */
  instantiateMs?: number;
}

/** Coarse handshake phases, when the stack exposes the transitions. */
interface StageStats {
  iceMs?: number;
  dtlsMs?: number;
  sctpMs?: number;
  openMs?: number;
}

/** Sustained throughput with a bounded number of messages in flight. */
export interface ThroughputStats {
  window: number;
  payloadBytes: number;
  messages: number;
  seconds: number;
  messagesPerSecond: number;
  bytesPerSecond: number;
  /** Send calls refused for backpressure. Zero is the healthy value. */
  backpressure: number;
}

interface LifecycleStats {
  iterations: number;
  totalMs: number;
  perSecond: number;
  rssStartBytes: number;
  peakRssBytes: number;
  rssEndBytes: number;
  rssGrowthBytes: number;
}

export interface MemoryStats {
  stage: string;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  /** Linux proportional set size, when /proc is available. */
  pssBytes?: number;
  /** Linux unique set size, when /proc is available. */
  ussBytes?: number;
  /** Linux peak resident set, when /proc is available. */
  vmHwmBytes?: number;
}

/** JS <-> wasm boundary cost, measured over one throughput window. */
export interface BoundaryStats {
  messages: number;
  payloadBytes: number;
  inputCallsPerMessage: number;
  sendCallsPerMessage: number;
  pollEventCallsPerMessage: number;
  /** All three host calls summed, the number an optimization tries to lower. */
  crossingsPerMessage: number;
  bytesInPerPayloadByte: number;
  bytesOutPerPayloadByte: number;
  allocationsPer1kMessages: number;
}

/** Keyframe burst behavior on top of a continuous audio stream. */
export interface BurstStats {
  burstMessages: number;
  burstPayloadBytes: number;
  burstBytes: number;
  drainMs: number;
  maxBufferedBytes: number;
  refusedSends: number;
  audioBaselineP50: number;
  audioDuringBurstP50: number;
  audioDuringBurstP99: number;
  audioAfterP50: number;
}

/** Paced audio and video at call cadence, with CPU cost. */
export interface CadenceStats {
  durationMs: number;
  audioPerSecond: number;
  videoPerSecond: number;
  delivered: number;
  messagesPerSecond: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  /** CPU milliseconds spent per delivered message, the efficiency figure. */
  cpuMsPerMessage: number;
  messagesPerCpuSecond: number;
}

export interface BackendMetrics {
  name: string;
  available: boolean;
  note?: string;
  cold?: ColdStats;
  /** createRelayConnection to channel open, per independent connection. */
  createOpenMs?: LatencyStats;
  /** Connections that never opened, counted instead of aborting the run. */
  openFailures?: number;
  stages?: StageStats;
  /** Echo round-trip latency per payload size, keyed by byte count. */
  rttByPayload?: Record<string, LatencyStats>;
  /** Sustained throughput per workload, keyed by name such as `video`. */
  throughput?: Record<string, ThroughputStats>;
  lifecycle?: LifecycleStats;
  memory?: MemoryStats[];
  /** Whole-process JS <-> wasm counters. */
  crossings?: Record<string, number>;
  /** Per-message boundary cost for one measured workload. */
  boundary?: BoundaryStats;
  /** Keyframe burst behavior, when the backend ran it. */
  burst?: BurstStats;
  /** Paced call-cadence workload, when the backend ran it. */
  cadence?: CadenceStats;
  /** DTLS cipher suite the connection negotiated, when the backend reports it. */
  cipherSuite?: string;
}

export interface FootprintReport {
  wasmRawBytes?: number;
  wasmGzipBytes?: number;
  wasmBrotliBytes?: number;
  npmTarballBytes?: number;
  npmUnpackedBytes?: number;
  rustReleaseBinaryBytes?: number;
  peerBinaryBytes?: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}

export function summarize(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** Reads PSS, USS and peak RSS from /proc. Absent on non-Linux or sandboxes. */
function procMemory(): { pssBytes?: number; ussBytes?: number; vmHwmBytes?: number } {
  const result: { pssBytes?: number; ussBytes?: number; vmHwmBytes?: number } = {};
  try {
    const rollup = readFileSync("/proc/self/smaps_rollup", "utf8");
    const pss = /^Pss:\s+(\d+) kB/m.exec(rollup);
    const uss = /^Private_Clean:\s+(\d+) kB/m.exec(rollup);
    const ussDirty = /^Private_Dirty:\s+(\d+) kB/m.exec(rollup);
    if (pss) result.pssBytes = Number(pss[1]) * 1024;
    if (uss || ussDirty) {
      result.ussBytes = (Number(uss?.[1] ?? 0) + Number(ussDirty?.[1] ?? 0)) * 1024;
    }
  } catch {
    // not Linux
  }
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const hwm = /^VmHWM:\s+(\d+) kB/m.exec(status);
    if (hwm) result.vmHwmBytes = Number(hwm[1]) * 1024;
  } catch {
    // not Linux
  }
  return result;
}

export function memoryStats(stage: string): MemoryStats {
  const usage = process.memoryUsage();
  return {
    stage,
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    ...procMemory(),
  };
}

/** Prints the backend metrics as JSON on its own line, for the runner to read. */
export function emitMetrics(metrics: BackendMetrics): void {
  process.stdout.write(`\nBENCH_JSON ${JSON.stringify(metrics)}\n`);
}

export function printReport(metrics: BackendMetrics[], footprint: FootprintReport): void {
  console.log("\nfootprint:");
  console.table(
    Object.fromEntries(
      Object.entries(footprint).map(([key, value]) => [
        key,
        value === undefined ? "-" : formatBytes(value),
      ]),
    ),
  );

  console.log("cold start:");
  console.table(
    metrics.map((m) => ({
      backend: m.name,
      state: m.available ? "ok" : "n/a",
      import: formatMs(m.cold?.importMs),
      compile: formatMs(m.cold?.compileMs),
      instantiate: formatMs(m.cold?.instantiateMs),
    })),
  );

  console.log("connection:");
  console.table(
    metrics.map((m) => ({
      backend: m.name,
      "create->open p50": formatMs(m.createOpenMs?.p50),
      p95: formatMs(m.createOpenMs?.p95),
      samples: m.createOpenMs?.samples ?? "-",
      "ice p50": formatMs(m.stages?.iceMs),
      "dtls p50": formatMs(m.stages?.dtlsMs),
      "sctp p50": formatMs(m.stages?.sctpMs),
    })),
  );

  console.log("traffic:");
  console.table(
    metrics.map((m) => {
      const tp = m.throughput?.video ?? Object.values(m.throughput ?? {})[0];
      return {
        backend: m.name,
        "rtt256 p50": formatMs(m.rttByPayload?.["256"]?.p50),
        "rtt256 p99": formatMs(m.rttByPayload?.["256"]?.p99),
        "msgs/s": tp ? Math.round(tp.messagesPerSecond).toString() : "-",
        "MiB/s": tp ? (tp.bytesPerSecond / (1024 * 1024)).toFixed(2) : "-",
        window: tp?.window ?? "-",
        refused: tp?.backpressure ?? "-",
        cipher: shortCipher(m.cipherSuite),
      };
    }),
  );

  console.log("lifecycle and memory:");
  console.table(
    metrics.map((m) => ({
      backend: m.name,
      "cycles/s": m.lifecycle ? m.lifecycle.perSecond.toFixed(1) : "-",
      cycles: m.lifecycle?.iterations ?? "-",
      "rss growth": m.lifecycle ? formatBytes(m.lifecycle.rssGrowthBytes) : "-",
      "final rss": formatBytes(m.memory?.at(-1)?.rssBytes),
      "final pss": formatBytes(m.memory?.at(-1)?.pssBytes),
    })),
  );

  const withBoundary = metrics.filter((m) => m.boundary);
  if (withBoundary.length > 0) {
    console.log("wasm boundary (per delivered message):");
    console.table(
      withBoundary.map((m) => ({
        backend: m.name,
        crossings: m.boundary!.crossingsPerMessage.toFixed(2),
        input: m.boundary!.inputCallsPerMessage.toFixed(2),
        send: m.boundary!.sendCallsPerMessage.toFixed(2),
        pollEvent: m.boundary!.pollEventCallsPerMessage.toFixed(2),
        "bytes in/payload": m.boundary!.bytesInPerPayloadByte.toFixed(2),
        "bytes out/payload": m.boundary!.bytesOutPerPayloadByte.toFixed(2),
        "allocs/1k": m.boundary!.allocationsPer1kMessages.toFixed(2),
      })),
    );
  }

  const withBurst = metrics.filter((m) => m.burst);
  if (withBurst.length > 0) {
    console.log("keyframe burst (audio latency while a burst drains):");
    console.table(
      withBurst.map((m) => ({
        backend: m.name,
        "burst kB": (m.burst!.burstBytes / 1024).toFixed(0),
        "drain ms": m.burst!.drainMs.toFixed(1),
        "max queued B": m.burst!.maxBufferedBytes,
        refused: m.burst!.refusedSends,
        "audio base p50": formatMs(m.burst!.audioBaselineP50),
        "audio burst p50": formatMs(m.burst!.audioDuringBurstP50),
        "audio burst p99": formatMs(m.burst!.audioDuringBurstP99),
        "audio after p50": formatMs(m.burst!.audioAfterP50),
      })),
    );
  }

  const withCadence = metrics.filter((m) => m.cadence);
  if (withCadence.length > 0) {
    console.log("realistic cadence (50 audio/s + 300 video/s):");
    console.table(
      withCadence.map((m) => ({
        backend: m.name,
        delivered: m.cadence!.delivered,
        "msg/s": Math.round(m.cadence!.messagesPerSecond),
        "cpu user ms": m.cadence!.cpuUserMs.toFixed(1),
        "cpu sys ms": m.cadence!.cpuSystemMs.toFixed(1),
        "cpu ms/msg": m.cadence!.cpuMsPerMessage.toFixed(3),
        "msg/cpu-s": Math.round(m.cadence!.messagesPerCpuSecond),
      })),
    );
  }

  for (const m of metrics) {
    if (m.note) console.log(`  ${m.name}: ${m.note}`);
    if (m.lifecycle) {
      console.log(
        `  ${m.name} lifecycle: ${m.lifecycle.iterations} cycles in ` +
          `${m.lifecycle.totalMs.toFixed(0)}ms, RSS ${formatBytes(m.lifecycle.rssStartBytes)}` +
          ` -> peak ${formatBytes(m.lifecycle.peakRssBytes)} -> ` +
          `${formatBytes(m.lifecycle.rssEndBytes)}`,
      );
    }
  }
}

function formatMs(value: number | undefined): string {
  return value === undefined ? "-" : `${value.toFixed(2)}ms`;
}

/** Compacts a DTLS suite name for the table, keeping the distinctive tail. */
function shortCipher(name: string | undefined): string {
  if (!name) return "-";
  if (name.includes("CHACHA20_POLY1305")) return "chacha20-poly1305";
  if (name.includes("AES_128_GCM")) return "aes128-gcm";
  if (name.includes("AES_256_GCM")) return "aes256-gcm";
  if (name.includes("AES_128_CCM")) return "aes128-ccm";
  return name;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MiB`;
}
