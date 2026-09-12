/**
 * Measurement primitives shared by every backend.
 *
 * Two rules matter here. First, receive is event driven: a waiter resolves when
 * a message arrives, so latency never includes a polling interval. Second,
 * throughput is a bounded window kept full for a fixed wall time, not a single
 * burst followed by a drain, which would measure round-trip latency instead.
 */

import { performance } from "node:perf_hooks";

import {
  summarize,
  type BurstStats,
  type CadenceStats,
  type LatencyStats,
  type ThroughputStats,
} from "../report/src/report.ts";

type SendResult = "accepted" | "backpressure" | "not-open";

export interface BenchChannel {
  send(data: Buffer): SendResult;
  onMessage(handler: (data: Buffer) => void): void;
}

/** Counts received messages and resolves waiters when a target count is met. */
export class MessageCounter {
  count = 0;
  #waiters: Array<{ target: number; resolve: () => void; timer: NodeJS.Timeout }> = [];

  onMessage(): void {
    this.count++;
    if (this.#waiters.length === 0) return;
    const pending: Array<{ target: number; resolve: () => void; timer: NodeJS.Timeout }> = [];
    for (const waiter of this.#waiters) {
      if (this.count >= waiter.target) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      } else {
        pending.push(waiter);
      }
    }
    this.#waiters = pending;
  }

  /** Resolves once `count` has reached `target`, or rejects on timeout. */
  waitFor(target: number, timeoutMs: number): Promise<void> {
    if (this.count >= target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timed out waiting for message ${target}, got ${this.count}`));
      }, timeoutMs);
      this.#waiters.push({ target, resolve, timer });
    });
  }
}

/**
 * One message in flight per sample: send, wait for the echo, measure. No
 * polling and no pipelining, so the number is a true request/response latency.
 */
export async function measureRtt(
  channel: BenchChannel,
  counter: MessageCounter,
  payloadBytes: number,
  roundTrips: number,
  timeoutMs = 5000,
): Promise<LatencyStats> {
  const payload = Buffer.alloc(payloadBytes, 7);
  const samples: number[] = [];
  for (let i = 0; i < roundTrips; i++) {
    const target = counter.count + 1;
    const start = performance.now();
    if (channel.send(payload) !== "accepted") {
      throw new Error("send refused during RTT measurement");
    }
    await counter.waitFor(target, timeoutMs);
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

export interface ThroughputOptions {
  window: number;
  payloadBytes: number;
  durationMs: number;
  timeoutMs?: number;
}

/**
 * Keeps up to `window` unacknowledged messages in flight for `durationMs`, then
 * drains briefly. Returns delivered messages, not offered ones, so a lossy path
 * cannot inflate the number. `backpressure` counts send calls the channel
 * refused; a healthy run keeps it at zero by sizing the window to the link.
 */
export async function measureThroughput(
  channel: BenchChannel,
  counter: MessageCounter,
  options: ThroughputOptions,
): Promise<ThroughputStats> {
  const { window, payloadBytes, durationMs, timeoutMs = 5000 } = options;
  const payload = Buffer.alloc(payloadBytes, 1);
  const start = performance.now();
  const deadline = start + durationMs;
  let sent = 0;
  let backpressure = 0;

  const fill = () => {
    while (sent - counter.count < window && performance.now() < deadline) {
      const result = channel.send(payload);
      if (result === "accepted") {
        sent++;
      } else if (result === "backpressure") {
        backpressure++;
        break;
      } else {
        break;
      }
    }
  };

  fill();
  while (performance.now() < deadline && sent > counter.count) {
    await counter.waitFor(counter.count + 1, timeoutMs).catch(() => {});
    fill();
  }

  // Drain whatever is still in flight so delivered == offered for a healthy run.
  const drainDeadline = performance.now() + 2000;
  while (counter.count < sent && performance.now() < drainDeadline) {
    await counter.waitFor(counter.count + 1, 1000).catch(() => {});
  }

  const elapsedMs = performance.now() - start;
  const seconds = elapsedMs / 1000;
  return {
    window,
    payloadBytes,
    messages: counter.count,
    seconds,
    messagesPerSecond: counter.count / seconds,
    bytesPerSecond: (counter.count * payloadBytes) / seconds,
    backpressure,
  };
}

export interface BurstOptions {
  burstMessages: number;
  burstPayloadBytes: number;
  audioPayloadBytes: number;
  audioSamples: number;
  getStats?: () => { bufferedBytes: number; refusedSends: number };
  timeoutMs?: number;
}

/** Sends one message and resolves with its echo latency in milliseconds. */
async function oneRtt(
  channel: BenchChannel,
  counter: MessageCounter,
  payload: Buffer,
  timeoutMs: number,
): Promise<number> {
  const target = counter.count + 1;
  const start = performance.now();
  if (channel.send(payload) !== "accepted") throw new Error("send refused during burst audio");
  await counter.waitFor(target, timeoutMs);
  return performance.now() - start;
}

/**
 * Emulates a keyframe burst on top of a continuous audio stream and asks one
 * question: while a large IDR burst is queued, does a small audio frame still
 * cross with low latency?
 *
 * The burst is fired all at once, then audio frames are sent and timed while
 * the burst is still draining. `maxBufferedBytes` is sampled across the whole
 * window. A send refused for backpressure is counted, not silently ignored.
 */
export async function measureBurst(
  channel: BenchChannel,
  counter: MessageCounter,
  options: BurstOptions,
): Promise<BurstStats> {
  const {
    burstMessages,
    burstPayloadBytes,
    audioPayloadBytes,
    audioSamples,
    getStats = () => ({ bufferedBytes: 0, refusedSends: 0 }),
    timeoutMs = 10_000,
  } = options;

  const audio = Buffer.alloc(audioPayloadBytes, 9);
  const video = Buffer.alloc(burstPayloadBytes, 3);
  let maxBufferedBytes = 0;
  const sample = () => {
    maxBufferedBytes = Math.max(maxBufferedBytes, getStats().bufferedBytes);
  };

  const baseline: number[] = [];
  for (let i = 0; i < audioSamples; i++) {
    baseline.push(await oneRtt(channel, counter, audio, timeoutMs));
  }

  const deliveredBefore = counter.count;
  const burstStart = performance.now();
  let refusedSends = 0;
  for (let i = 0; i < burstMessages; i++) {
    if (channel.send(video) !== "accepted") refusedSends++;
  }
  sample();

  const during: number[] = [];
  for (let i = 0; i < audioSamples; i++) {
    during.push(await oneRtt(channel, counter, audio, timeoutMs));
    sample();
  }

  const target = deliveredBefore + burstMessages + audioSamples;
  const drainDeadline = performance.now() + timeoutMs;
  while (counter.count < target && performance.now() < drainDeadline) {
    await counter.waitFor(counter.count + 1, timeoutMs).catch(() => {});
    sample();
  }
  const drainMs = performance.now() - burstStart;
  refusedSends += getStats().refusedSends;

  const after: number[] = [];
  for (let i = 0; i < audioSamples; i++) {
    after.push(await oneRtt(channel, counter, audio, timeoutMs));
  }

  return {
    burstMessages,
    burstPayloadBytes,
    burstBytes: burstMessages * burstPayloadBytes,
    drainMs,
    maxBufferedBytes,
    refusedSends,
    audioBaselineP50: summarize(baseline).p50,
    audioDuringBurstP50: summarize(during).p50,
    audioDuringBurstP99: summarize(during).p99,
    audioAfterP50: summarize(after).p50,
  };
}

export interface CadenceOptions {
  durationMs: number;
  audioPerSecond: number;
  videoPerSecond: number;
  audioPayloadBytes: number;
  videoPayloadBytes: number;
  timeoutMs?: number;
}

/**
 * Drives a paced audio and video load, the shape a real call produces, and
 * reports the CPU it cost. Maximum throughput does not answer what a call
 * costs per second; this does.
 *
 * Audio is paced at `audioPerSecond`, video at `videoPerSecond`. CPU is measured
 * with `process.cpuUsage` around the paced window only, so import, compile and
 * connection setup are excluded. The result is CPU milliseconds per delivered
 * message, the figure that scales to a laptop or a server.
 */
export async function measureCadence(
  channel: BenchChannel,
  counter: MessageCounter,
  options: CadenceOptions,
): Promise<CadenceStats> {
  const { durationMs, audioPerSecond, videoPerSecond, audioPayloadBytes, videoPayloadBytes } =
    options;

  const audio = Buffer.alloc(audioPayloadBytes, 9);
  const video = Buffer.alloc(videoPayloadBytes, 3);
  const audioIntervalMs = 1000 / audioPerSecond;
  const videoTickMs = 10;
  const videoPerTick = Math.max(1, Math.round((videoPerSecond * videoTickMs) / 1000));

  const deliveredBefore = counter.count;
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  let offered = 0;

  await new Promise<void>((resolve) => {
    const audioTimer = setInterval(() => {
      channel.send(audio);
      offered++;
    }, audioIntervalMs);
    const videoTimer = setInterval(() => {
      for (let i = 0; i < videoPerTick; i++) {
        channel.send(video);
        offered++;
      }
    }, videoTickMs);
    setTimeout(() => {
      clearInterval(audioTimer);
      clearInterval(videoTimer);
      resolve();
    }, durationMs);
  });

  const target = deliveredBefore + offered;
  const drainDeadline = performance.now() + 2000;
  while (counter.count < target && performance.now() < drainDeadline) {
    await counter.waitFor(counter.count + 1, 1000).catch(() => {});
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  const cpuUserMs = cpu.user / 1000;
  const cpuSystemMs = cpu.system / 1000;
  const cpuTotalMs = cpuUserMs + cpuSystemMs;
  const delivered = counter.count - deliveredBefore;
  const seconds = elapsedMs / 1000;

  return {
    durationMs: elapsedMs,
    audioPerSecond,
    videoPerSecond,
    delivered,
    messagesPerSecond: delivered / seconds,
    cpuUserMs,
    cpuSystemMs,
    cpuMsPerMessage: delivered === 0 ? 0 : cpuTotalMs / delivered,
    messagesPerCpuSecond: cpuTotalMs === 0 ? 0 : delivered / (cpuTotalMs / 1000),
  };
}
