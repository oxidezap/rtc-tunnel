/**
 * Benchmark backend: the wasm tunnel over UDP against the neutral Pion peer.
 *
 * Each connection is a full product path: JS API -> wasm -> node:dgram -> UDP ->
 * peer. The compiled module is created once and every connection reuses the
 * same instance, which is how a long-lived process uses it.
 *
 * The RTT test keeps one message in flight. The throughput test keeps a bounded
 * window in flight for a fixed wall time. Both count echoes as they arrive, so
 * neither includes a polling interval.
 */

import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";

import { createNodeRuntime } from "../../packages/rtc-tunnel/src/runtime/node.ts";
import { createRelayTransportProvider } from "../../packages/rtc-tunnel/src/driver.ts";
import { WasmTunnelModule, wasmCounters } from "../../packages/rtc-tunnel/src/engine/wasm.ts";
import type { TunnelEngine, TunnelEngineConfig } from "../../packages/rtc-tunnel/src/engine.ts";
import type { HandshakeTrace } from "../../packages/rtc-tunnel/src/engine.ts";
import type { RelayConnectionHandle } from "../../packages/rtc-tunnel/src/provider.ts";
import {
  type BackendMetrics,
  type BoundaryStats,
  type LatencyStats,
  type MemoryStats,
  type ThroughputStats,
  emitMetrics,
  memoryStats,
  percentile,
  summarize,
} from "../report/src/report.ts";
import { benchHost, startPeer, wasmPath, type PeerReady, type PeerSession } from "../lib/peer.ts";
import {
  MessageCounter,
  measureBurst,
  measureCadence,
  measureRtt,
  measureThroughput,
  type BenchChannel,
} from "../lib/measure.ts";

const host = benchHost();
const RTT_PAYLOADS = [64, 256, 1200, 8192];
const CONNECT_SAMPLES = Number(process.env.BENCH_CONNECT_SAMPLES ?? 50);
const THROUGHPUT_MS = Number(process.env.BENCH_THROUGHPUT_MS ?? 5000);
// 0 makes the driver poll one event per crossing instead of batching.
const EVENT_BATCH = Number(process.env.BENCH_EVENT_BATCH ?? 64);
const BURST_MESSAGES = Number(process.env.BENCH_BURST_MESSAGES ?? 500);
const BURST_PAYLOAD_BYTES = 1200;
const CADENCE_MS = Number(process.env.BENCH_CADENCE_MS ?? 5000);
// Comma separated phase names to skip: rtt, throughput, burst, cadence.
const SKIP = new Set((process.env.BENCH_SKIP ?? "").split(",").filter(Boolean));
const LIFECYCLE_COUNTS = (process.env.BENCH_LIFECYCLE_COUNTS ?? "100")
  .split(",")
  .map((value) => Number(value.trim()));

function relayParams(ready: PeerReady) {
  return {
    address: ready.host,
    port: ready.port,
    iceUfrag: ready.ufrag,
    icePwd: ready.pwd,
    fingerprint:
      "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
    handshakeTimeoutMs: Number(process.env.BENCH_HANDSHAKE_MS ?? 20000),
  };
}

interface Connection {
  handle: RelayConnectionHandle;
  counter: MessageCounter;
  channel: BenchChannel;
  trace: HandshakeTrace | null;
  cipherSuite: string | null;
  close(): void;
}

async function connect(module: WasmTunnelModule, peer: PeerSession): Promise<Connection> {
  const counter = new MessageCounter();
  let engineRef: TunnelEngine | null = null;
  const baseRuntime = createNodeRuntime(
    async (config: TunnelEngineConfig): Promise<TunnelEngine> => {
      const engine = module.createTunnel(config);
      engineRef = engine;
      const offer = engine.offerSdp();
      if (!offer) throw new Error("engine produced no offer");
      // Wait for the peer's answer before the driver starts pumping. The peer
      // only answers after it has applied the offer, so this removes the race
      // where the tunnel's first flight arrives before the peer is listening
      // and is answered only on a DTLS retransmit.
      await peer.exchange(offer);
      return engine;
    },
    { bindAddress: host },
  );

  const provider = createRelayTransportProvider(baseRuntime, {
    backpressure: "queue",
    eventBatchSize: EVENT_BATCH,
    insecureSkipFingerprintVerification: true,
  });
  const handle = await provider.createRelayConnection(relayParams(peer.ready), {
    onOpen: () => {},
    onPacket: () => counter.onMessage(),
    onClose: () => {},
  });
  const channel: BenchChannel = {
    send(data) {
      handle.send(data);
      return "accepted";
    },
    onMessage(handler) {
      void handler;
    },
  };
  return {
    handle,
    counter,
    channel,
    trace: (engineRef as TunnelEngine | null)?.handshakeTrace() ?? null,
    cipherSuite: (engineRef as TunnelEngine | null)?.negotiatedCipherSuite() ?? null,
    close: () => handle.close(),
  };
}

function stageDelta(samples: number[]): number | undefined {
  return samples.length === 0
    ? undefined
    : percentile(
        [...samples].sort((a, b) => a - b),
        50,
      );
}

async function main(): Promise<void> {
  const memory: MemoryStats[] = [memoryStats("baseline")];

  const importStart = performance.now();
  // RTC_TUNNEL_WASM selects a specific artifact without overwriting the
  // canonical build output.
  const bytes = await readFile(process.env.RTC_TUNNEL_WASM ?? wasmPath);
  const importMs = performance.now() - importStart;
  memory.push(memoryStats("after import"));

  const compileStart = performance.now();
  const compiled = await WasmTunnelModule.compile(bytes);
  const compileMs = performance.now() - compileStart;
  memory.push(memoryStats("after compile"));

  const instantiateStart = performance.now();
  const module = WasmTunnelModule.instantiate(compiled);
  const instantiateMs = performance.now() - instantiateStart;
  memory.push(memoryStats("after instantiate"));

  const createOpenSamples: number[] = [];
  const stageSamples = {
    ice: [] as number[],
    dtls: [] as number[],
    sctp: [] as number[],
    open: [] as number[],
  };
  let openFailures = 0;
  let cipherSuite: string | null = null;
  for (let i = 0; i < CONNECT_SAMPLES; i++) {
    const peer = await startPeer({ host });
    try {
      const start = performance.now();
      const connection = await connect(module, peer);
      createOpenSamples.push(performance.now() - start);
      if (connection.cipherSuite) cipherSuite = connection.cipherSuite;
      if (connection.trace) {
        const trace = connection.trace;
        const push = (list: number[], value: number | undefined) => {
          if (value !== undefined) list.push(value - trace.startMs);
        };
        push(stageSamples.ice, trace.iceMs);
        push(stageSamples.dtls, trace.dtlsMs);
        push(stageSamples.sctp, trace.sctpMs);
        push(stageSamples.open, trace.openedMs);
      }
      connection.close();
    } catch {
      openFailures++;
    }
    peer.close();
  }
  memory.push(memoryStats("after connect samples"));

  const rttByPayload: Record<string, LatencyStats> = {};
  if (!SKIP.has("rtt")) {
    for (const payloadBytes of RTT_PAYLOADS) {
      const peer = await startPeer({ host });
      const connection = await connect(module, peer);
      rttByPayload[String(payloadBytes)] = await measureRtt(
        connection.channel,
        connection.counter,
        payloadBytes,
        50,
      );
      connection.close();
      peer.close();
    }
  }

  const throughput: Record<string, ThroughputStats> = {};
  let boundary: BoundaryStats | undefined;
  if (!SKIP.has("throughput")) {
    for (const workload of [
      { name: "voice", payloadBytes: 160, window: 64 },
      { name: "video", payloadBytes: 1200, window: 256 },
    ]) {
      const peer = await startPeer({ host });
      const connection = await connect(module, peer);
      const before = { ...wasmCounters };
      const stats = await measureThroughput(connection.channel, connection.counter, {
        window: workload.window,
        payloadBytes: workload.payloadBytes,
        durationMs: THROUGHPUT_MS,
      });
      const after = { ...wasmCounters };
      throughput[workload.name] = stats;
      if (workload.name === "video") {
        const messages = Math.max(1, stats.messages);
        const input = after.inputCalls - before.inputCalls;
        const send = after.sendCalls - before.sendCalls;
        const poll = after.pollEventCalls - before.pollEventCalls;
        const drain = after.drainCalls - before.drainCalls;
        boundary = {
          messages: stats.messages,
          payloadBytes: workload.payloadBytes,
          inputCallsPerMessage: input / messages,
          sendCallsPerMessage: send / messages,
          pollEventCallsPerMessage: (poll + drain) / messages,
          crossingsPerMessage: (input + send + poll + drain) / messages,
          bytesInPerPayloadByte:
            (after.bytesCopiedIn - before.bytesCopiedIn) / (messages * workload.payloadBytes),
          bytesOutPerPayloadByte:
            (after.bytesCopiedOut - before.bytesCopiedOut) / (messages * workload.payloadBytes),
          allocationsPer1kMessages: ((after.allocCalls - before.allocCalls) / messages) * 1000,
        };
      }
      connection.close();
      peer.close();
    }
  }
  memory.push(memoryStats("after throughput"));

  const burst = SKIP.has("burst")
    ? undefined
    : await (async () => {
        const peer = await startPeer({ host });
        const connection = await connect(module, peer);
        const result = await measureBurst(connection.channel, connection.counter, {
          burstMessages: BURST_MESSAGES,
          burstPayloadBytes: BURST_PAYLOAD_BYTES,
          audioPayloadBytes: 160,
          audioSamples: 50,
          getStats: () => connection.handle.stats?.() ?? { bufferedBytes: 0, refusedSends: 0 },
        });
        connection.close();
        peer.close();
        return result;
      })();
  memory.push(memoryStats("after burst"));

  const cadence = SKIP.has("cadence")
    ? undefined
    : await (async () => {
        const peer = await startPeer({ host });
        const connection = await connect(module, peer);
        const result = await measureCadence(connection.channel, connection.counter, {
          durationMs: CADENCE_MS,
          audioPerSecond: 50,
          videoPerSecond: 300,
          audioPayloadBytes: 160,
          videoPayloadBytes: 1200,
        });
        connection.close();
        peer.close();
        return result;
      })();
  memory.push(memoryStats("after cadence"));

  let lifecycle;
  let lifecycleFailures = 0;
  const lifecycleFailureReasons: string[] = [];
  for (const iterations of LIFECYCLE_COUNTS) {
    global.gc?.();
    const rssStart = process.memoryUsage().rss;
    let peak = rssStart;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const peer = await startPeer({ host });
      try {
        const connection = await connect(module, peer);
        connection.close();
      } catch (error) {
        // A connection can fail to open under an impaired or loaded machine.
        // Count it and keep going; the run must not abort on one timeout.
        lifecycleFailures++;
        lifecycleFailureReasons.push(error instanceof Error ? error.message : String(error));
      } finally {
        peer.close();
      }
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    const totalMs = performance.now() - start;
    const rssEnd = process.memoryUsage().rss;
    lifecycle = {
      iterations,
      totalMs,
      perSecond: (iterations / totalMs) * 1000,
      rssStartBytes: rssStart,
      peakRssBytes: peak,
      rssEndBytes: rssEnd,
      rssGrowthBytes: rssEnd - rssStart,
    };
  }
  memory.push(memoryStats("after lifecycle"));
  global.gc?.();
  memory.push(memoryStats("after gc"));

  const metrics: BackendMetrics = {
    name: "rtc-tunnel (wasm + node:dgram)",
    available: true,
    note: "offerer tunnel over UDP against the neutral Pion peer; module reused across connections",
    cold: { importMs, compileMs, instantiateMs },
    createOpenMs: summarize(createOpenSamples),
    openFailures: openFailures + lifecycleFailures,
    stages: {
      iceMs: stageDelta(stageSamples.ice),
      dtlsMs: stageDelta(stageSamples.dtls),
      sctpMs: stageDelta(stageSamples.sctp),
      openMs: stageDelta(stageSamples.open),
    },
    rttByPayload,
    throughput,
    lifecycle,
    memory,
    crossings: { ...wasmCounters },
    boundary,
    burst,
    cadence,
    cipherSuite: cipherSuite ?? undefined,
  };
  if (lifecycleFailureReasons.length > 0) {
    metrics.note = `${metrics.note}; lifecycle failures: ${lifecycleFailureReasons[0]}`;
  }
  emitMetrics(metrics);
}

await main();
