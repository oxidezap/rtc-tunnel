import {
  EVENT_CLOSED,
  EVENT_DATAGRAM,
  EVENT_MESSAGE,
  EVENT_NONE,
  EVENT_OPENED,
  SEND_ACCEPTED,
  SEND_BACKPRESSURE,
  SEND_TOO_LARGE,
  type EngineEvent,
  type TunnelEngine,
  type TunnelEngineConfig,
} from "./engine.ts";
import type {
  RelayConnectionEvents,
  RelayConnectionHandle,
  RelayConnectionParams,
  RelayTransportProvider,
} from "./provider.ts";
import { validateRelayParams } from "./validate.ts";

/** A bound datagram endpoint the provider can send to and receive from. */
export interface UdpEndpoint {
  readonly localAddress: string;
  readonly localPort: number;
  send(data: Uint8Array): void;
  onMessage(handler: (data: Uint8Array) => void): void;
  onError(handler: (error: Error) => void): void;
  close(): void;
}

/** Everything platform specific the provider needs, injected by the adapter. */
export interface TunnelRuntime {
  /** Monotonic milliseconds. Only differences are meaningful. */
  now(): number;
  /** Schedules `cb` after `delayMs`; returns a cancel function. */
  setTimer(delayMs: number, cb: () => void): () => void;
  /** Binds a local UDP socket that can reach the relay. */
  bind(remoteAddress: string, remotePort: number): Promise<UdpEndpoint>;
  /** Creates the sans-I/O engine. May resolve asynchronously. */
  createEngine(config: TunnelEngineConfig): TunnelEngine | Promise<TunnelEngine>;
}

/**
 * What to do when the channel's send buffer is over its cap.
 *
 * The core stays opaque, so it cannot tell an audio frame from a control
 * message. The caller decides. `drop` favors latency, which is right for
 * real-time media; `queue` favors delivery, which is right for control bytes,
 * at the cost of latency and an extra bounded buffer here.
 */
export type BackpressurePolicy = "drop" | "queue";

export interface ProviderOptions {
  /** Cap on the driver's own queue when the policy is `queue`. */
  maxQueuedBytes?: number;
  /** What to do when the core reports backpressure. Defaults to `drop`. */
  backpressure?: BackpressurePolicy;
}

/**
 * Tuning knobs for the low-level driver.
 *
 * These exist for the benchmark harness and for hosts that need a specific
 * scheduling trade-off. The defaults are what a normal caller wants, so the
 * public provider surface does not expose them.
 *
 * `eventBatchSize` is the maximum events pulled from the engine per boundary
 * crossing. `inputBatch` and `sendBatch` select how inbound datagrams and
 * outbound drains are coalesced (`off`, `microtask`, `macrotask`).
 */
export interface AdvancedProviderOptions extends ProviderOptions {
  eventBatchSize?: number;
  inputBatch?: "off" | "microtask" | "macrotask";
  sendBatch?: "off" | "microtask" | "macrotask";
  /**
   * Skip remote certificate fingerprint verification.
   *
   * For deterministic tests and controlled benchmarks only. Never enable this
   * against a real relay.
   */
  insecureSkipFingerprintVerification?: boolean;
}

const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024;
const DEFAULT_EVENT_BATCH_SIZE = 64;
const DEFAULT_INPUT_BATCH = "macrotask";
const DEFAULT_SEND_BATCH = "microtask";

/**
 * Runs `fn` after the current event-loop phase, portably.
 *
 * `setImmediate` is the Node and Bun primitive and runs before timers. Runtimes
 * without it get a zero-delay timer, which is still a full macrotask boundary.
 */
function scheduleMacrotask(fn: () => void): void {
  const immediate = (globalThis as { setImmediate?: (cb: () => void) => unknown }).setImmediate;
  if (typeof immediate === "function") immediate(fn);
  else setTimeout(fn, 0);
}

/**
 * Drives a sans-I/O engine with a real UDP socket and exposes the relay
 * contract.
 *
 * The returned promise resolves only once the data channel is open, so a caller
 * that awaits it never races the handshake and never has its first datagram
 * silently dropped. It rejects if the tunnel closes or times out first.
 */
export function createRelayTransportProvider(
  runtime: TunnelRuntime,
  options: AdvancedProviderOptions = {},
): RelayTransportProvider {
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const backpressure = options.backpressure ?? "drop";
  const eventBatchSize = options.eventBatchSize ?? DEFAULT_EVENT_BATCH_SIZE;
  const inputBatch = options.inputBatch ?? DEFAULT_INPUT_BATCH;
  const sendBatch = options.sendBatch ?? DEFAULT_SEND_BATCH;
  const insecureSkipFingerprintVerification =
    options.insecureSkipFingerprintVerification ?? false;

  return {
    createRelayConnection(params, events, context): Promise<RelayConnectionHandle> {
      validateRelayParams(params);
      return openConnection(
        runtime,
        {
          maxQueuedBytes,
          backpressure,
          eventBatchSize,
          inputBatch,
          sendBatch,
          insecureSkipFingerprintVerification,
        },
        params,
        events,
        context,
      );
    },
  };
}

interface ResolvedOptions {
  maxQueuedBytes: number;
  backpressure: BackpressurePolicy;
  eventBatchSize: number;
  inputBatch: "off" | "microtask" | "macrotask";
  sendBatch: "off" | "microtask" | "macrotask";
  insecureSkipFingerprintVerification: boolean;
}

interface OpenCallbacks {
  opened: boolean;
  closed: boolean;
  closeReason: string | undefined;
  settleOpen(): void;
  settleClosed(): void;
}

async function openConnection(
  runtime: TunnelRuntime,
  options: ResolvedOptions,
  params: RelayConnectionParams,
  events: RelayConnectionEvents,
  context: { localAddress?: string } | undefined,
): Promise<RelayConnectionHandle> {
  const { maxQueuedBytes, backpressure, eventBatchSize, inputBatch, sendBatch } = options;
  const remoteAddress = params.address;
  const remotePort = params.port;
  const endpoint = await runtime.bind(remoteAddress, remotePort);

  // Anything after the socket is bound must close it on failure: the caller
  // has no handle yet, so a throw here would otherwise leak the socket.
  let engine: TunnelEngine;
  try {
    let localAddress = endpoint.localAddress;
    let localPort = endpoint.localPort;
    if (context?.localAddress) {
      const parsed = splitHost(context.localAddress);
      localAddress = parsed.host;
      localPort = parsed.port;
    }

    engine = await runtime.createEngine({
      remoteAddress,
      remotePort,
      localAddress,
      localPort,
      iceUfrag: params.iceUfrag,
      icePwd: params.icePwd,
      fingerprint: params.fingerprint,
      fingerprintAlgorithm: params.fingerprintAlgorithm ?? "sha-256",
      sctpPort: params.sctpPort ?? 5000,
      streamId: params.streamId ?? 0,
      ordered: params.ordered ?? false,
      maxRetransmits: params.maxRetransmits ?? 0,
      handshakeTimeoutMs: params.handshakeTimeoutMs ?? 30_000,
      disableFingerprintVerification: options.insecureSkipFingerprintVerification,
      nowMs: runtime.now(),
    });
  } catch (error) {
    try {
      endpoint.close();
    } catch {
      // endpoint already gone
    }
    throw error;
  }

  let cancelTimer: (() => void) | null = null;
  let scheduledDeadline: number | null = null;
  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let refusedSends = 0;
  /** Datagrams received in one event-loop turn, flushed together. */
  const inbound: Uint8Array[] = [];
  let inboundScheduled = false;

  const state: OpenCallbacks = {
    opened: false,
    closed: false,
    closeReason: undefined,
    settleOpen: () => {},
    settleClosed: () => {},
  };

  const finish = (reason: string | undefined) => {
    if (state.closed) return;
    state.closed = true;
    state.closeReason = reason;
    if (cancelTimer) cancelTimer();
    cancelTimer = null;
    scheduledDeadline = null;
    queue.length = 0;
    queuedBytes = 0;
    try {
      endpoint.close();
    } catch {
      // endpoint already gone
    }
    // The engine owns a Rust handle; free it once, here, so the lifetime does
    // not depend on the wasm instance being garbage collected.
    engine.dispose();
    if (state.opened) {
      events.onClose(reason);
    } else {
      state.settleClosed();
    }
  };

  const schedule = () => {
    if (state.closed) return;
    const deadline = engine.nextDeadline();
    if (deadline === null) return;
    // `pump` runs on every inbound datagram and every send, and each run would
    // otherwise cancel and re-arm the timer. Keep the armed timer when it still
    // fires at or before the new deadline; only re-arm when the engine wants an
    // earlier one. A later deadline needs no change, because waking early is
    // always safe and the timer re-arms on fire.
    if (cancelTimer !== null && scheduledDeadline !== null && scheduledDeadline <= deadline) {
      return;
    }
    if (cancelTimer) cancelTimer();
    const delay = Math.max(0, deadline - runtime.now());
    scheduledDeadline = deadline;
    cancelTimer = runtime.setTimer(delay, () => {
      cancelTimer = null;
      scheduledDeadline = null;
      engine.tick(runtime.now());
      pump();
    });
  };

  const flushQueue = () => {
    while (queue.length > 0) {
      const next = queue[0]!;
      const result = engine.send(next);
      if (result === SEND_ACCEPTED) {
        queue.shift();
        queuedBytes -= next.length;
      } else if (result === SEND_BACKPRESSURE) {
        break;
      } else {
        queue.shift();
        queuedBytes -= next.length;
      }
    }
  };

  const applyEvent = (event: EngineEvent): boolean => {
    switch (event.kind) {
      case EVENT_DATAGRAM:
        endpoint.send(event.data);
        return false;
      case EVENT_OPENED:
        if (!state.opened) {
          state.opened = true;
          events.onOpen();
          state.settleOpen();
        }
        return false;
      case EVENT_MESSAGE:
        events.onPacket(event.data);
        return false;
      case EVENT_CLOSED:
        finish(closeReason(event.reason));
        return true;
      default:
        return false;
    }
  };

  const useBatch = eventBatchSize > 0 && typeof engine.drainEvents === "function";

  const pump = () => {
    if (state.closed) return;
    schedule();
    if (backpressure === "queue") flushQueue();
    if (useBatch) {
      const drain = (engine.drainEvents as (max: number) => EngineEvent[]).bind(engine);
      while (!state.closed) {
        const batch = drain(eventBatchSize);
        for (const event of batch) {
          if (applyEvent(event)) return;
        }
        if (batch.length < eventBatchSize) break;
      }
    } else {
      let event: EngineEvent;
      while ((event = engine.pollEvent()).kind !== EVENT_NONE) {
        if (applyEvent(event)) return;
      }
    }
  };

  // Coalesces the host-side drain after `send`. `engine.send` still runs on
  // every call, so backpressure and ordering are unchanged; only the drain is
  // deferred. With a send window of N this replaces N drains per turn with one.
  let outboundScheduled = false;
  const schedulePump = () => {
    if (sendBatch === "off") {
      pump();
      return;
    }
    if (outboundScheduled) return;
    outboundScheduled = true;
    const flush = () => {
      outboundScheduled = false;
      pump();
    };
    if (sendBatch === "microtask") queueMicrotask(flush);
    else scheduleMacrotask(flush);
  };

  endpoint.onMessage((data) => {
    if (state.closed) return;
    if (inputBatch === "off") {
      engine.input(runtime.now(), data);
      pump();
      return;
    }
    inbound.push(data);
    if (inboundScheduled) return;
    inboundScheduled = true;
    const flush = () => {
      inboundScheduled = false;
      if (state.closed || inbound.length === 0) return;
      const now = runtime.now();
      // With the deferred ABI the engine copies each datagram into its own
      // queue and advances the protocol once, so a batch pays one ICE/DTLS/SCTP
      // pump instead of one per datagram. Engines without it feed normally.
      const deferred = engine.inputDeferred !== undefined && engine.finishInputBatch !== undefined;
      if (deferred) {
        for (const datagram of inbound) engine.inputDeferred!(now, datagram);
        inbound.length = 0;
        engine.finishInputBatch!();
      } else {
        for (const datagram of inbound) engine.input(now, datagram);
        inbound.length = 0;
      }
      pump();
    };
    if (inputBatch === "microtask") queueMicrotask(flush);
    else scheduleMacrotask(flush);
  });
  endpoint.onError((error) => {
    finish(error.message);
  });

  await new Promise<void>((resolve, reject) => {
    state.settleOpen = resolve;
    state.settleClosed = () =>
      reject(new Error(`tunnel closed before opening: ${state.closeReason ?? "unknown"}`));
    pump();
    if (state.opened) resolve();
    else if (state.closed) state.settleClosed();
  });

  return {
    send(data: Uint8Array) {
      if (state.closed || !state.opened) return;
      const result = engine.send(data);
      if (result === SEND_ACCEPTED) {
        schedulePump();
        return;
      }
      if (result === SEND_TOO_LARGE) {
        throw new RangeError(`message of ${data.length} bytes exceeds the channel maximum`);
      }
      if (result === SEND_BACKPRESSURE && backpressure === "queue") {
        if (queuedBytes + data.length > maxQueuedBytes) {
          refusedSends++;
          return;
        }
        queue.push(data);
        queuedBytes += data.length;
        return;
      }
      if (result === SEND_BACKPRESSURE) {
        refusedSends++;
      }
    },
    close() {
      if (state.closed) return;
      engine.close();
      pump();
      finish("local");
    },
    stats() {
      const cipherSuite = engine.negotiatedCipherSuite?.() ?? null;
      return {
        bufferedBytes: engine.bufferedBytes?.() ?? 0,
        droppedDatagrams: engine.droppedDatagrams?.() ?? 0,
        refusedSends,
        ...(cipherSuite ? { cipherSuite } : {}),
      };
    },
  };
}

function closeReason(reason: number): string {
  switch (reason) {
    case 0:
      return "local";
    case 1:
      return "remote";
    case 2:
      return "timeout";
    default:
      return "failure";
  }
}

/** Parses an `ip:port`, accepting IPv4 and bracketed IPv6. */
function splitHost(address: string): { host: string; port: number } {
  if (address.startsWith("[")) {
    const end = address.indexOf("]");
    if (end === -1 || address[end + 1] !== ":") {
      throw new Error(`expected a host:port, got '${address}'`);
    }
    return {
      host: address.slice(1, end),
      port: Number(address.slice(end + 2)),
    };
  }
  const index = address.lastIndexOf(":");
  if (index === -1 || address.indexOf(":") !== index) {
    throw new Error(`expected an IPv4 host:port, got '${address}'`);
  }
  return {
    host: address.slice(0, index),
    port: Number(address.slice(index + 1)),
  };
}
