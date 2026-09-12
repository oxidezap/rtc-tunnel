/**
 * Node and Bun runtime built on `node:dgram`, which both provide.
 *
 * The socket is connected to the remote address, so the kernel drops datagrams
 * from anywhere else. The tunnel knows one peer; a stray or spoofed packet must
 * not reach its ICE, DTLS or SCTP state.
 */

import { createSocket, type Socket } from "node:dgram";
import { performance } from "node:perf_hooks";

import type { TunnelEngine, TunnelEngineConfig } from "../engine.ts";
import type { TunnelRuntime, UdpEndpoint } from "../driver.ts";

export interface NodeRuntimeOptions {
  /** Local bind address. Defaults to `0.0.0.0`, or `::` for an IPv6 peer. */
  bindAddress?: string;
  /** Local bind port. Defaults to 0 (ephemeral). */
  bindPort?: number;
}

export function createNodeRuntime(
  createEngine: (config: TunnelEngineConfig) => TunnelEngine | Promise<TunnelEngine>,
  options: NodeRuntimeOptions = {},
): TunnelRuntime {
  return {
    now: () => performance.now(),
    setTimer(delayMs, cb) {
      const handle = setTimeout(cb, delayMs);
      return () => clearTimeout(handle);
    },
    bind: (remoteAddress, remotePort) =>
      bindEndpoint(
        remoteAddress,
        remotePort,
        options.bindAddress ?? (remoteAddress.includes(":") ? "::" : "0.0.0.0"),
        options.bindPort ?? 0,
      ),
    createEngine,
  };
}

function bindEndpoint(
  remoteAddress: string,
  remotePort: number,
  bindAddress: string,
  bindPort: number,
): Promise<UdpEndpoint> {
  return new Promise((resolve, reject) => {
    const type = remoteAddress.includes(":") ? "udp6" : "udp4";
    const socket = createSocket({ type, reuseAddr: true });
    socket.on("error", reject);
    socket.bind(bindPort, bindAddress, () => {
      // Connect so only the remote peer's datagrams are delivered. `send` then
      // needs no address and cannot be aimed anywhere else.
      socket.connect(remotePort, remoteAddress, () => {
        socket.off("error", reject);
        resolve(wrapSocket(socket));
      });
    });
  });
}

function wrapSocket(socket: Socket): UdpEndpoint {
  const messageHandlers: Array<(data: Uint8Array) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];
  let closed = false;

  socket.on("message", (message) => {
    if (closed) return;
    const view = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    for (const handler of messageHandlers) handler(view);
  });
  socket.on("error", (error) => {
    if (closed) return;
    for (const handler of errorHandlers) handler(error);
  });

  const address = socket.address();

  return {
    localAddress: address.address,
    localPort: address.port,
    send(data: Uint8Array) {
      if (closed) return;
      // No address: the socket is connected.
      socket.send(data);
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onError(handler) {
      errorHandlers.push(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      messageHandlers.length = 0;
      errorHandlers.length = 0;
      socket.close();
    },
  };
}
