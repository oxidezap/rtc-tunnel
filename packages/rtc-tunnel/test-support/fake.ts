/**
 * Deterministic in-memory engine used by tests.
 *
 * It speaks the same event shapes as the wasm engine but models the tunnel as
 * a simple state machine: input bytes become output bytes, a scripted peer can
 * "open" the channel and deliver messages, and deadlines are whatever the test
 * says. No wasm, no sockets, no timers.
 */

import {
  EVENT_CLOSED,
  EVENT_DATAGRAM,
  EVENT_MESSAGE,
  EVENT_NONE,
  EVENT_OPENED,
  SEND_ACCEPTED,
  SEND_BACKPRESSURE,
  SEND_NOT_OPEN,
  type EngineEvent,
  type TunnelEngine,
  type TunnelEngineConfig,
} from "../src/engine.ts";

export interface FakeEngineOptions {
  /** Bytes returned to the caller for every datagram fed in. */
  echoDatagram?: (data: Uint8Array) => Uint8Array | undefined;
  /** Emit an application message for every datagram fed in. */
  messagePerInput?: boolean;
  /** Cap used to decide when sends are refused for backpressure. */
  sendBufferCap?: number;
  /** Queue the open event at construction, as if the handshake had finished. */
  openImmediately?: boolean;
}

const DEFAULT_CAP = 1024 * 1024;

export class FakeTunnelEngine implements TunnelEngine {
  readonly config: TunnelEngineConfig;
  readonly outbox: Uint8Array[] = [];
  readonly sent: Uint8Array[] = [];
  readonly inputs: Uint8Array[] = [];
  opened = false;
  finished = false;
  disposed = false;
  deadline: number | null = null;
  sendBufferUsage = 0;
  #events: EngineEvent[] = [];
  #echoDatagram: (data: Uint8Array) => Uint8Array | undefined;
  #messagePerInput: boolean;
  #sendBufferCap: number;

  constructor(config: TunnelEngineConfig, options: FakeEngineOptions = {}) {
    this.config = config;
    this.#echoDatagram = options.echoDatagram ?? (() => undefined);
    this.#messagePerInput = options.messagePerInput ?? false;
    this.#sendBufferCap = options.sendBufferCap ?? DEFAULT_CAP;
    if (options.openImmediately) {
      this.opened = true;
      this.#events.push({ kind: EVENT_OPENED });
    }
  }

  /** Test hook: pretend the peer completed the handshake. */
  open(): void {
    this.opened = true;
    this.#events.push({ kind: EVENT_OPENED });
  }

  /** Test hook: deliver an application message from the peer. */
  deliver(data: Uint8Array): void {
    this.#events.push({ kind: EVENT_MESSAGE, data });
  }

  /** Test hook: close from the peer side. */
  remoteClose(reason = 1): void {
    this.finished = true;
    this.opened = false;
    this.#events.push({ kind: EVENT_CLOSED, reason });
  }

  input(_nowMs: number, data: Uint8Array): void {
    this.inputs.push(data);
    const reply = this.#echoDatagram(data);
    if (reply) {
      this.outbox.push(reply);
      this.#events.push({ kind: EVENT_DATAGRAM, data: reply });
    }
    if (this.#messagePerInput) {
      this.#events.push({ kind: EVENT_MESSAGE, data });
    }
  }

  tick(_nowMs: number): void {}

  send(data: Uint8Array): number {
    if (this.finished || !this.opened) {
      return SEND_NOT_OPEN;
    }
    if (this.sendBufferUsage >= this.#sendBufferCap) {
      return SEND_BACKPRESSURE;
    }
    this.sent.push(data);
    this.sendBufferUsage += data.length;
    this.#events.push({ kind: EVENT_DATAGRAM, data });
    return SEND_ACCEPTED;
  }

  nextDeadline(): number | null {
    return this.deadline;
  }

  pollEvent(): EngineEvent {
    return this.#events.shift() ?? { kind: EVENT_NONE };
  }

  drainEvents(max: number): EngineEvent[] {
    const out: EngineEvent[] = [];
    while (out.length < max && this.#events.length > 0) {
      out.push(this.#events.shift()!);
    }
    return out;
  }

  bufferedBytes(): number {
    return this.sendBufferUsage;
  }

  droppedDatagrams(): number {
    return 0;
  }

  isOpen(): boolean {
    return this.opened;
  }

  isFinished(): boolean {
    return this.finished;
  }

  close(): void {
    this.finished = true;
    this.opened = false;
    this.#events.push({ kind: EVENT_CLOSED, reason: 0 });
  }

  setSendBufferCap(cap: number): void {
    this.#sendBufferCap = cap;
  }

  dispose(): void {
    this.disposed = true;
    this.finished = true;
    this.opened = false;
    this.#events.length = 0;
  }

  offerSdp(): string | null {
    return null;
  }

  handshakeTrace(): null {
    return null;
  }

  negotiatedCipherSuite(): string | null {
    return this.opened ? "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256" : null;
  }
}
