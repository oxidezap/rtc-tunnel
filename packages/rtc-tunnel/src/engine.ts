/**
 * Engine boundary for the sans-I/O tunnel.
 *
 * The shipped implementation calls the wasm C ABI. The provider drives whatever
 * engine it is given, so the UDP transport and the relay interface stay
 * independent of it.
 */

export const EVENT_NONE = 0;
export const EVENT_DATAGRAM = 1;
export const EVENT_OPENED = 2;
export const EVENT_MESSAGE = 3;
export const EVENT_CLOSED = 4;

export const SEND_ACCEPTED = 0;
export const SEND_BACKPRESSURE = 1;
export const SEND_NOT_OPEN = 2;
export const SEND_TOO_LARGE = 3;

export type EngineEvent =
  | { kind: typeof EVENT_NONE }
  | { kind: typeof EVENT_DATAGRAM; data: Uint8Array }
  | { kind: typeof EVENT_OPENED }
  | { kind: typeof EVENT_MESSAGE; data: Uint8Array }
  | { kind: typeof EVENT_CLOSED; reason: number };

export interface TunnelEngineConfig {
  remoteAddress: string;
  remotePort: number;
  localAddress: string;
  localPort: number;
  iceUfrag: string;
  icePwd: string;
  fingerprint: string;
  fingerprintAlgorithm: string;
  sctpPort: number;
  streamId: number;
  ordered: boolean;
  maxRetransmits: number;
  handshakeTimeoutMs: number;
  disableFingerprintVerification: boolean;
  nowMs: number;
}

/** First-observation times for the handshake phases, on the engine's clock. */
export interface HandshakeTrace {
  startMs: number;
  iceMs?: number;
  dtlsMs?: number;
  sctpMs?: number;
  openedMs?: number;
}

export interface TunnelEngine {
  input(nowMs: number, data: Uint8Array): void;
  /**
   * Optional batched input. When present, `inputDeferred` feeds a datagram
   * without advancing the protocol and `finishInputBatch` advances it once for
   * the whole run, so several datagrams that arrived together pay one protocol
   * pump instead of one each. Engines without it fall back to `input`.
   */
  inputDeferred?(nowMs: number, data: Uint8Array): void;
  finishInputBatch?(): void;
  tick(nowMs: number): void;
  send(data: Uint8Array): number;
  nextDeadline(): number | null;
  pollEvent(): EngineEvent;
  isOpen(): boolean;
  isFinished(): boolean;
  close(): void;
  setSendBufferCap(cap: number): void;
  /** Releases engine-owned resources. Safe to call more than once. */
  dispose(): void;
  /** SDP offer generated at construction, when the engine exposes one. */
  offerSdp(): string | null;
  /** Handshake phase timings, when the engine can report them. */
  handshakeTrace(): HandshakeTrace | null;
  /**
   * IANA name of the DTLS cipher suite the handshake negotiated, such as
   * `TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256`. `null` before the
   * handshake selects one, or when the engine cannot report it.
   */
  negotiatedCipherSuite(): string | null;
  /**
   * Pulls up to `max` events in one boundary crossing. Returns fewer than `max`
   * when the queue is empty. Optional: engines without a batched path fall back
   * to repeated `pollEvent`.
   */
  drainEvents?(max: number): EngineEvent[];
  /** Bytes waiting in the send buffer, when the engine can report them. */
  bufferedBytes?(): number;
  /** Datagrams rejected as malformed, when the engine can report them. */
  droppedDatagrams?(): number;
}
