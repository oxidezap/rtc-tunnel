/**
 * Benchmark backend: werift as the offerer against the neutral Pion peer.
 *
 * A real offer/answer against an independent implementation over the same UDP
 * path the tunnel uses, with identical peer parameters.
 */

import { performance } from "node:perf_hooks";

import {
  type BackendMetrics,
  type LatencyStats,
  type MemoryStats,
  type ThroughputStats,
  emitMetrics,
  memoryStats,
  summarize,
} from "../report/src/report.ts";
import { benchHost, startPeer, type PeerSession } from "../lib/peer.ts";
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
const LIFECYCLE_COUNTS = (process.env.BENCH_LIFECYCLE_COUNTS ?? "100")
  .split(",")
  .map((value) => Number(value.trim()));
const BURST_MESSAGES = Number(process.env.BENCH_BURST_MESSAGES ?? 500);
const BURST_PAYLOAD_BYTES = 1200;
const CADENCE_MS = Number(process.env.BENCH_CADENCE_MS ?? 5000);

type Werift = typeof import("werift");

function waitGathering(pc: import("werift").RTCPeerConnection, timeoutMs = 5000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const subscription = pc.iceGatheringStateChange.subscribe((state) => {
      if (state === "complete") {
        clearTimeout(timer);
        subscription.unSubscribe();
        resolve();
      }
    });
  });
}

interface Connection {
  channel: BenchChannel;
  counter: MessageCounter;
  close(): Promise<void>;
}

async function connect(werift: Werift, peer: PeerSession): Promise<Connection> {
  const pc = new werift.RTCPeerConnection({
    iceServers: [],
    iceUseIpv6: false,
    iceAdditionalHostAddresses: [host],
  });
  const dc = pc.createDataChannel("relay", {
    ordered: false,
    maxRetransmits: 0,
    negotiated: true,
    id: 0,
  });
  const counter = new MessageCounter();
  dc.onMessage.subscribe(() => counter.onMessage());

  const opened = new Promise<void>((resolve) => {
    if (dc.readyState === "open") return resolve();
    dc.stateChanged.subscribe((state) => state === "open" && resolve());
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitGathering(pc);
  const answer = await peer.exchange(pc.localDescription!.sdp);
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  await opened;

  const channel: BenchChannel = {
    send(data) {
      try {
        dc.send(data);
        return "accepted";
      } catch {
        return "backpressure";
      }
    },
    onMessage() {},
  };
  return { channel, counter, close: () => pc.close() };
}

async function main(): Promise<void> {
  const memory: MemoryStats[] = [memoryStats("baseline")];

  const importStart = performance.now();
  const werift = await import("werift");
  const importMs = performance.now() - importStart;
  memory.push(memoryStats("after import"));

  const createOpenSamples: number[] = [];
  for (let i = 0; i < CONNECT_SAMPLES; i++) {
    const peer = await startPeer({ host });
    const start = performance.now();
    const connection = await connect(werift, peer);
    createOpenSamples.push(performance.now() - start);
    await connection.close();
    peer.close();
  }
  memory.push(memoryStats("after connect samples"));

  const rttByPayload: Record<string, LatencyStats> = {};
  for (const payloadBytes of RTT_PAYLOADS) {
    const peer = await startPeer({ host });
    const connection = await connect(werift, peer);
    rttByPayload[String(payloadBytes)] = await measureRtt(
      connection.channel,
      connection.counter,
      payloadBytes,
      50,
    );
    await connection.close();
    peer.close();
  }

  const throughput: Record<string, ThroughputStats> = {};
  for (const workload of [
    { name: "voice", payloadBytes: 160, window: 64 },
    { name: "video", payloadBytes: 1200, window: 256 },
  ]) {
    const peer = await startPeer({ host });
    const connection = await connect(werift, peer);
    throughput[workload.name] = await measureThroughput(connection.channel, connection.counter, {
      window: workload.window,
      payloadBytes: workload.payloadBytes,
      durationMs: THROUGHPUT_MS,
    });
    await connection.close();
    peer.close();
  }
  memory.push(memoryStats("after throughput"));

  const burst = await (async () => {
    const peer = await startPeer({ host });
    const connection = await connect(werift, peer);
    const result = await measureBurst(connection.channel, connection.counter, {
      burstMessages: BURST_MESSAGES,
      burstPayloadBytes: BURST_PAYLOAD_BYTES,
      audioPayloadBytes: 160,
      audioSamples: 50,
    });
    await connection.close();
    peer.close();
    return result;
  })();
  memory.push(memoryStats("after burst"));

  const cadence = await (async () => {
    const peer = await startPeer({ host });
    const connection = await connect(werift, peer);
    const result = await measureCadence(connection.channel, connection.counter, {
      durationMs: CADENCE_MS,
      audioPerSecond: 50,
      videoPerSecond: 300,
      audioPayloadBytes: 160,
      videoPayloadBytes: 1200,
    });
    await connection.close();
    peer.close();
    return result;
  })();
  memory.push(memoryStats("after cadence"));

  let lifecycle;
  for (const iterations of LIFECYCLE_COUNTS) {
    global.gc?.();
    const rssStart = process.memoryUsage().rss;
    let peak = rssStart;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const peer = await startPeer({ host });
      const connection = await connect(werift, peer);
      await connection.close();
      peer.close();
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
    name: "werift (werift + pion peer)",
    available: true,
    note: "werift offerer against the neutral Pion peer over the same UDP path as the tunnel",
    cold: { importMs },
    createOpenMs: summarize(createOpenSamples),
    rttByPayload,
    throughput,
    lifecycle,
    memory,
    cadence,
    burst,
  };
  emitMetrics(metrics);
}

await main();
