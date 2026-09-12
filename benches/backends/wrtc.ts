/**
 * Benchmark backend: @koush/wrtc native as the offerer against the neutral
 * Pion peer.
 *
 * Optional. Native libwebrtc is the historical baseline; it is heavy to
 * install, so this reports unavailable rather than failing when absent. Like
 * werift it now does a real offer/answer with an independent implementation.
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

interface DataChannelLike {
  readyState: string;
  send(data: Buffer): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null;
}

interface PeerConnectionLike {
  createDataChannel(label: string, init?: Record<string, unknown>): DataChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(desc: unknown): Promise<void>;
  setRemoteDescription(desc: unknown): Promise<void>;
  localDescription?: { sdp?: string } | null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null;
  onicegatheringstatechange: (() => void) | null;
  iceGatheringState?: string;
  connectionState: string;
  close(): void;
}

type WrtcModule = {
  RTCPeerConnection: new (config: Record<string, unknown>) => PeerConnectionLike;
};

async function loadWrtc(): Promise<WrtcModule | null> {
  try {
    const mod = (await import("@koush/wrtc")) as unknown as WrtcModule & { default?: WrtcModule };
    return mod.RTCPeerConnection ? mod : (mod.default ?? null);
  } catch {
    return null;
  }
}

function waitGathering(pc: PeerConnectionLike, timeoutMs = 5000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    };
  });
}

function waitOpen(channel: DataChannelLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (channel.readyState === "open") return resolve();
    const timer = setTimeout(() => reject(new Error("channel never opened")), timeoutMs);
    channel.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

interface Connection {
  channel: BenchChannel;
  counter: MessageCounter;
  close(): void;
}

async function connect(wrtc: WrtcModule, peer: PeerSession): Promise<Connection> {
  const pc = new wrtc.RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel("relay", {
    ordered: false,
    maxRetransmits: 0,
    negotiated: true,
    id: 0,
  });
  const counter = new MessageCounter();
  dc.onmessage = () => counter.onMessage();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitGathering(pc);
  const answer = await peer.exchange(pc.localDescription?.sdp ?? offer.sdp ?? "");
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  await waitOpen(dc, 20000);

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
  const wrtc = await loadWrtc();
  const importMs = performance.now() - importStart;
  if (!wrtc) {
    emitMetrics({
      name: "@koush/wrtc (native + pion peer)",
      available: false,
      note: "not installed",
    });
    return;
  }
  memory.push(memoryStats("after import"));

  const createOpenSamples: number[] = [];
  for (let i = 0; i < CONNECT_SAMPLES; i++) {
    const peer = await startPeer({ host });
    const start = performance.now();
    const connection = await connect(wrtc, peer);
    createOpenSamples.push(performance.now() - start);
    connection.close();
    peer.close();
  }
  memory.push(memoryStats("after connect samples"));

  const rttByPayload: Record<string, LatencyStats> = {};
  for (const payloadBytes of RTT_PAYLOADS) {
    const peer = await startPeer({ host });
    const connection = await connect(wrtc, peer);
    rttByPayload[String(payloadBytes)] = await measureRtt(
      connection.channel,
      connection.counter,
      payloadBytes,
      50,
    );
    connection.close();
    peer.close();
  }

  const throughput: Record<string, ThroughputStats> = {};
  for (const workload of [
    { name: "voice", payloadBytes: 160, window: 64 },
    { name: "video", payloadBytes: 1200, window: 256 },
  ]) {
    const peer = await startPeer({ host });
    const connection = await connect(wrtc, peer);
    throughput[workload.name] = await measureThroughput(connection.channel, connection.counter, {
      window: workload.window,
      payloadBytes: workload.payloadBytes,
      durationMs: THROUGHPUT_MS,
    });
    connection.close();
    peer.close();
  }
  memory.push(memoryStats("after throughput"));

  const burst = await (async () => {
    const peer = await startPeer({ host });
    const connection = await connect(wrtc, peer);
    const result = await measureBurst(connection.channel, connection.counter, {
      burstMessages: BURST_MESSAGES,
      burstPayloadBytes: BURST_PAYLOAD_BYTES,
      audioPayloadBytes: 160,
      audioSamples: 50,
    });
    connection.close();
    peer.close();
    return result;
  })();
  memory.push(memoryStats("after burst"));

  const cadence = await (async () => {
    const peer = await startPeer({ host });
    const connection = await connect(wrtc, peer);
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
      const connection = await connect(wrtc, peer);
      connection.close();
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
    name: "@koush/wrtc (native + pion peer)",
    available: true,
    note: "native wrtc offerer against the neutral Pion peer over the same UDP path as the tunnel",
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

  // libwebrtc's teardown can abort on process exit. The metrics are already
  // emitted, so leave cleanly rather than let the native destructors run.
  process.exit(0);
}

await main();
