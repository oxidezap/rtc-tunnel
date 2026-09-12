/**
 * Bare-wasm engine over the `rtc-tunnel-wasm` C ABI.
 *
 * The module targets `wasm32-unknown-unknown` with a reconstructed std, so it
 * has no WASI and no wasm-bindgen glue. It imports exactly three host
 * functions under the `rtc_tunnel` module:
 *
 *   now_micros() -> u64          monotonic clock, microseconds
 *   unix_millis() -> f64         wall clock, milliseconds since the epoch
 *   fill_random(ptr, len) -> u32 random fill for std and the crypto stack
 *
 * The host supplies them from the same clock it uses to drive `input`/`tick`,
 * so the tunnel's internal epoch stays consistent with the `nowMs` it is fed.
 *
 * Instantiation is separated from tunnel creation. `WasmTunnelModule` owns one
 * `WebAssembly.Instance` and can create many tunnels from it, which is what a
 * long-lived process wants: pay the compile and instantiate cost once. Each
 * tunnel still has its own Rust handle and is freed by `dispose`.
 */

import {
  EVENT_CLOSED,
  EVENT_DATAGRAM,
  EVENT_MESSAGE,
  EVENT_NONE,
  EVENT_OPENED,
  type EngineEvent,
  type HandshakeTrace,
  type TunnelEngine,
  type TunnelEngineConfig,
} from "../engine.ts";

export type WasmSource = Uint8Array | ArrayBuffer | Response | Promise<Uint8Array | ArrayBuffer>;

/** Optional overrides for the host clock and entropy. */
export interface HostImports {
  nowMicros(): bigint;
  unixMillis(): number;
  fillRandom(dest: Uint8Array): void;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  rtc_tunnel_abi_version(): number;
  rtc_tunnel_alloc(len: number): number;
  rtc_tunnel_free(ptr: number, len: number): void;
  rtc_tunnel_create(
    remotePtr: number,
    remoteLen: number,
    ufragPtr: number,
    ufragLen: number,
    pwdPtr: number,
    pwdLen: number,
    fpPtr: number,
    fpLen: number,
    fingerprintAlgorithmPtr: number,
    fingerprintAlgorithmLen: number,
    localPtr: number,
    localLen: number,
    sctpPort: number,
    streamId: number,
    ordered: number,
    maxRetransmits: number,
    handshakeTimeoutMs: number,
    disableFingerprintVerification: number,
    nowMs: number,
  ): number;
  rtc_tunnel_destroy(handle: number): void;
  rtc_tunnel_input(handle: number, nowMs: number, dataPtr: number, dataLen: number): void;
  rtc_tunnel_input_deferred(handle: number, nowMs: number, dataPtr: number, dataLen: number): void;
  rtc_tunnel_finish_input_batch(handle: number): void;
  rtc_tunnel_tick(handle: number, nowMs: number): void;
  rtc_tunnel_send(handle: number, dataPtr: number, dataLen: number): number;
  rtc_tunnel_next_deadline(handle: number): number;
  rtc_tunnel_is_open(handle: number): number;
  rtc_tunnel_is_finished(handle: number): number;
  rtc_tunnel_dropped_datagrams(handle: number): number;
  rtc_tunnel_close(handle: number): void;
  rtc_tunnel_set_send_buffer_cap(handle: number, cap: number): void;
  rtc_tunnel_offer_len(handle: number): number;
  rtc_tunnel_offer_copy(handle: number, buf: number, cap: number): number;
  rtc_tunnel_stage_ms(handle: number, stage: number): number;
  rtc_tunnel_cipher_len(handle: number): number;
  rtc_tunnel_cipher_copy(handle: number, buf: number, cap: number): number;
  rtc_tunnel_poll_event(handle: number): number;
  rtc_tunnel_event_ptr(handle: number): number;
  rtc_tunnel_event_len(handle: number): number;
  rtc_tunnel_event_reason(handle: number): number;
  rtc_tunnel_drain_events(handle: number, max: number): number;
  rtc_tunnel_events_ptr(handle: number): number;
  rtc_tunnel_buffered_bytes(handle: number): number;
  rtc_tunnel_last_error_len(): number;
  rtc_tunnel_last_error_copy(buf: number, cap: number): number;
}

function defaultHost(): HostImports {
  return {
    nowMicros: () => BigInt(Math.round(performance.now() * 1000)),
    unixMillis: () => Date.now(),
    fillRandom: (dest) => {
      globalThis.crypto.getRandomValues(dest as Uint8Array<ArrayBuffer>);
    },
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** ABI version this loader speaks. Must match `rtc_tunnel_abi_version`. */
const ABI_VERSION = 1;

/**
 * Counters for the JS <-> wasm boundary. They cost a few increments per call
 * and make it possible to see, after a real workload, how many crossings and
 * how many bytes the host paid for. Read and reset by callers that care.
 */
export const wasmCounters = {
  inputCalls: 0,
  sendCalls: 0,
  pollEventCalls: 0,
  drainCalls: 0,
  allocCalls: 0,
  bytesCopiedIn: 0,
  bytesCopiedOut: 0,
};

/** A reusable host-side wasm buffer, grown on demand and never freed per call. */
class Scratch {
  ptr = 0;
  cap = 0;

  write(exports: WasmExports, data: Uint8Array): { ptr: number; len: number } {
    if (data.length > this.cap) {
      if (this.ptr !== 0) exports.rtc_tunnel_free(this.ptr, this.cap);
      const cap = Math.max(data.length, this.cap * 2, 2048);
      this.ptr = exports.rtc_tunnel_alloc(cap);
      this.cap = cap;
      wasmCounters.allocCalls++;
    }
    if (data.length > 0) {
      new Uint8Array(exports.memory.buffer, this.ptr, data.length).set(data);
      wasmCounters.bytesCopiedIn += data.length;
    }
    return { ptr: this.ptr, len: data.length };
  }

  release(exports: WasmExports): void {
    if (this.ptr !== 0) {
      exports.rtc_tunnel_free(this.ptr, this.cap);
      this.ptr = 0;
      this.cap = 0;
    }
  }
}

/** A compiled and instantiated wasm module that can host many tunnels. */
export class WasmTunnelModule {
  #exports: WasmExports;
  #scratch = new Scratch();

  private constructor(exports: WasmExports) {
    this.#exports = exports;
  }

  /** Compiles the artifact once. Reuse the module across many instances. */
  static async compile(source: WasmSource): Promise<WebAssembly.Module> {
    const bytes = source instanceof Response ? await source.arrayBuffer() : await source;
    return WebAssembly.compile(bytes as BufferSource);
  }

  /** Instantiates a precompiled module. Call once per process and reuse it. */
  static instantiate(
    module: WebAssembly.Module,
    host: HostImports = defaultHost(),
  ): WasmTunnelModule {
    let memory: WebAssembly.Memory | null = null;
    const memoryBuffer = () => {
      if (memory === null) throw new Error("wasm memory accessed before instantiation");
      return memory.buffer;
    };

    const imports = {
      rtc_tunnel: {
        now_micros: () => host.nowMicros(),
        unix_millis: () => host.unixMillis(),
        fill_random: (ptr: number, len: number) => {
          const dest = new Uint8Array(memoryBuffer(), ptr, len);
          host.fillRandom(dest);
          return len;
        },
      },
    };

    const instance = new WebAssembly.Instance(module, imports);
    const exports = instance.exports as unknown as WasmExports;
    if (typeof exports.rtc_tunnel_abi_version !== "function") {
      throw new Error("incompatible rtc-tunnel wasm: missing rtc_tunnel_abi_version");
    }
    const abi = exports.rtc_tunnel_abi_version();
    if (abi !== ABI_VERSION) {
      throw new Error(`incompatible rtc-tunnel wasm ABI: module reports ${abi}, expected ${ABI_VERSION}`);
    }
    memory = exports.memory;
    return new WasmTunnelModule(exports);
  }

  /** Compiles and instantiates in one step. */
  static async load(
    source: WasmSource,
    host: HostImports = defaultHost(),
  ): Promise<WasmTunnelModule> {
    return WasmTunnelModule.instantiate(await WasmTunnelModule.compile(source), host);
  }

  /** Size of this instance's linear memory in bytes. */
  memoryBytes(): number {
    return this.#exports.memory.buffer.byteLength;
  }

  /** Creates one tunnel handle inside this module's instance. */
  createTunnel(config: TunnelEngineConfig): WasmTunnelEngine {
    const exports = this.#exports;
    const remoteAddress = socketAddr(config.remoteAddress, config.remotePort);
    const localAddress = socketAddr(config.localAddress, config.localPort);
    const handle = withCString(exports, remoteAddress, (remote) =>
      withCString(exports, config.iceUfrag, (ufrag) =>
        withCString(exports, config.icePwd, (pwd) =>
          withCString(exports, config.fingerprint, (fingerprint) =>
            withCString(exports, config.fingerprintAlgorithm, (fingerprintAlgorithm) =>
              withCString(exports, localAddress, (local) =>
                exports.rtc_tunnel_create(
                  remote.ptr,
                  remote.len,
                  ufrag.ptr,
                  ufrag.len,
                  pwd.ptr,
                  pwd.len,
                  fingerprint.ptr,
                  fingerprint.len,
                  fingerprintAlgorithm.ptr,
                  fingerprintAlgorithm.len,
                  local.ptr,
                  local.len,
                  config.sctpPort,
                  config.streamId,
                  config.ordered ? 1 : 0,
                  config.maxRetransmits,
                  config.handshakeTimeoutMs,
                  config.disableFingerprintVerification ? 1 : 0,
                  config.nowMs,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    if (handle === 0) {
      throw new Error(`rtc_tunnel_create rejected the configuration: ${readLastError(exports)}`);
    }
    return new WasmTunnelEngine(exports, this.#scratch, handle);
  }
}

export class WasmTunnelEngine implements TunnelEngine {
  #exports: WasmExports;
  #scratch: Scratch;
  #handle: number;
  #disposed = false;

  constructor(exports: WasmExports, scratch: Scratch, handle: number) {
    this.#exports = exports;
    this.#scratch = scratch;
    this.#handle = handle;
  }

  /**
   * Convenience for one-shot use: loads a module and creates a tunnel.
   *
   * Long-lived processes should load a `WasmTunnelModule` once and call
   * `createTunnel` instead, so the compile and instantiate cost is paid once.
   */
  static async create(
    config: TunnelEngineConfig,
    source: WasmSource,
    host: HostImports = defaultHost(),
  ): Promise<WasmTunnelEngine> {
    const module = await WasmTunnelModule.load(source, host);
    return module.createTunnel(config);
  }

  input(nowMs: number, data: Uint8Array): void {
    const { ptr, len } = this.#scratch.write(this.#exports, data);
    wasmCounters.inputCalls++;
    this.#exports.rtc_tunnel_input(this.#handle, nowMs, ptr, len);
  }

  inputDeferred(nowMs: number, data: Uint8Array): void {
    const { ptr, len } = this.#scratch.write(this.#exports, data);
    wasmCounters.inputCalls++;
    this.#exports.rtc_tunnel_input_deferred(this.#handle, nowMs, ptr, len);
  }

  finishInputBatch(): void {
    wasmCounters.inputCalls++;
    this.#exports.rtc_tunnel_finish_input_batch(this.#handle);
  }

  tick(nowMs: number): void {
    this.#exports.rtc_tunnel_tick(this.#handle, nowMs);
  }

  send(data: Uint8Array): number {
    const { ptr, len } = this.#scratch.write(this.#exports, data);
    wasmCounters.sendCalls++;
    return this.#exports.rtc_tunnel_send(this.#handle, ptr, len);
  }

  nextDeadline(): number | null {
    const value = this.#exports.rtc_tunnel_next_deadline(this.#handle);
    return value < 0 ? null : value;
  }

  pollEvent(): EngineEvent {
    wasmCounters.pollEventCalls++;
    const kind = this.#exports.rtc_tunnel_poll_event(this.#handle);
    switch (kind) {
      case EVENT_NONE:
        return { kind: EVENT_NONE };
      case EVENT_OPENED:
        return { kind: EVENT_OPENED };
      case EVENT_CLOSED:
        return { kind: EVENT_CLOSED, reason: this.#exports.rtc_tunnel_event_reason(this.#handle) };
      case EVENT_DATAGRAM:
      case EVENT_MESSAGE: {
        const ptr = this.#exports.rtc_tunnel_event_ptr(this.#handle);
        const len = this.#exports.rtc_tunnel_event_len(this.#handle);
        const data = new Uint8Array(this.#exports.memory.buffer, ptr, len).slice();
        wasmCounters.bytesCopiedOut += len;
        return { kind: kind === EVENT_DATAGRAM ? EVENT_DATAGRAM : EVENT_MESSAGE, data };
      }
      default:
        throw new Error(`unknown engine event ${kind}`);
    }
  }

  isOpen(): boolean {
    return this.#exports.rtc_tunnel_is_open(this.#handle) === 1;
  }

  isFinished(): boolean {
    return this.#exports.rtc_tunnel_is_finished(this.#handle) === 1;
  }

  /**
   * Pulls up to `max` events in one crossing. Descriptors are four u32s each
   * (`kind`, payload pointer, payload length, auxiliary). Payloads are copied
   * out with one `slice` per event.
   */
  drainEvents(max: number): EngineEvent[] {
    wasmCounters.drainCalls++;
    const count = this.#exports.rtc_tunnel_drain_events(this.#handle, max);
    if (count === 0) return [];
    const base = this.#exports.rtc_tunnel_events_ptr(this.#handle);
    const descriptors = new Uint32Array(this.#exports.memory.buffer, base, count * 4);
    const events: EngineEvent[] = [];
    for (let i = 0; i < count; i++) {
      const offset = i * 4;
      const kind = descriptors[offset]!;
      switch (kind) {
        case EVENT_DATAGRAM:
        case EVENT_MESSAGE: {
          const ptr = descriptors[offset + 1]!;
          const len = descriptors[offset + 2]!;
          const data = new Uint8Array(this.#exports.memory.buffer, ptr, len).slice();
          wasmCounters.bytesCopiedOut += len;
          events.push({ kind: kind === EVENT_DATAGRAM ? EVENT_DATAGRAM : EVENT_MESSAGE, data });
          break;
        }
        case EVENT_OPENED:
          events.push({ kind: EVENT_OPENED });
          break;
        case EVENT_CLOSED:
          events.push({ kind: EVENT_CLOSED, reason: descriptors[offset + 3]! });
          break;
        default:
          throw new Error(`unknown engine event ${kind}`);
      }
    }
    return events;
  }

  bufferedBytes(): number {
    return this.#exports.rtc_tunnel_buffered_bytes(this.#handle);
  }

  droppedDatagrams(): number {
    return this.#exports.rtc_tunnel_dropped_datagrams(this.#handle);
  }

  offerSdp(): string | null {
    const len = this.#exports.rtc_tunnel_offer_len(this.#handle);
    if (len === 0) return null;
    return withBuffer(this.#exports, len, (ptr, cap) => {
      const written = this.#exports.rtc_tunnel_offer_copy(this.#handle, ptr, cap);
      const bytes = new Uint8Array(this.#exports.memory.buffer, ptr, written).slice();
      return decoder.decode(bytes);
    });
  }

  handshakeTrace(): HandshakeTrace | null {
    const read = (stage: number): number | undefined => {
      const value = this.#exports.rtc_tunnel_stage_ms(this.#handle, stage);
      return value < 0 ? undefined : value;
    };
    const startMs = read(0);
    if (startMs === undefined) return null;
    return { startMs, iceMs: read(1), dtlsMs: read(2), sctpMs: read(3), openedMs: read(4) };
  }

  negotiatedCipherSuite(): string | null {
    const len = this.#exports.rtc_tunnel_cipher_len(this.#handle);
    if (len === 0) return null;
    return withBuffer(this.#exports, len, (ptr, cap) => {
      const written = this.#exports.rtc_tunnel_cipher_copy(this.#handle, ptr, cap);
      const bytes = new Uint8Array(this.#exports.memory.buffer, ptr, written).slice();
      return decoder.decode(bytes);
    });
  }

  close(): void {
    this.#exports.rtc_tunnel_close(this.#handle);
  }

  setSendBufferCap(cap: number): void {
    this.#exports.rtc_tunnel_set_send_buffer_cap(this.#handle, cap);
  }

  /** Frees the Rust handle. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#exports.rtc_tunnel_destroy(this.#handle);
  }
}

/** Formats an `ip:port`, bracketing IPv6 so it parses as a socket address. */
function socketAddr(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function withCString<T>(
  exports: WasmExports,
  value: string,
  fn: (buf: { ptr: number; len: number }) => T,
): T {
  const data = encoder.encode(value);
  const ptr = exports.rtc_tunnel_alloc(data.length);
  try {
    new Uint8Array(exports.memory.buffer, ptr, data.length).set(data);
    return fn({ ptr, len: data.length });
  } finally {
    exports.rtc_tunnel_free(ptr, data.length);
  }
}

function withBuffer<T>(exports: WasmExports, len: number, fn: (ptr: number, len: number) => T): T {
  const ptr = exports.rtc_tunnel_alloc(len);
  try {
    return fn(ptr, len);
  } finally {
    exports.rtc_tunnel_free(ptr, len);
  }
}

function readLastError(exports: WasmExports): string {
  const len = exports.rtc_tunnel_last_error_len();
  if (len === 0) return "no diagnostic available";
  return withBuffer(exports, len, (ptr, cap) => {
    const written = exports.rtc_tunnel_last_error_copy(ptr, cap);
    return decoder.decode(new Uint8Array(exports.memory.buffer, ptr, written).slice());
  });
}
