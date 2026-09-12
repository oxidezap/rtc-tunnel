/// <reference lib="dom" />

/**
 * Browser entry point, backed by the native `RTCPeerConnection`.
 *
 * A page cannot open a raw UDP socket, so the browser path does not use the
 * wasm tunnel. It implements the same `RelayTransportProvider` contract, so a
 * caller does not branch on platform.
 *
 * The channel is pre-negotiated (its id is fixed by the relay contract),
 * unordered and configured with zero retransmissions, matching the semantics the
 * wasm tunnel drives over SCTP.
 */

import type {
  RelayConnectionEvents,
  RelayConnectionHandle,
  RelayConnectionParams,
  RelayTransportProvider,
  RelayTransportContext,
} from "./provider.ts";
import { validateRelayParams } from "./validate.ts";

export function createBrowserRelayProvider(): RelayTransportProvider {
  return {
    createRelayConnection(
      params: RelayConnectionParams,
      events: RelayConnectionEvents,
      _context?: RelayTransportContext,
    ): Promise<RelayConnectionHandle> {
      validateRelayParams(params);
      return openBrowserConnection(params, events);
    },
  };
}

function openBrowserConnection(
  params: RelayConnectionParams,
  events: RelayConnectionEvents,
): Promise<RelayConnectionHandle> {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const channel = pc.createDataChannel(dataChannelLabel(params), {
      negotiated: true,
      id: params.streamId ?? 0,
      ordered: params.ordered ?? false,
      maxRetransmits: params.maxRetransmits ?? 0,
    });
    channel.binaryType = "arraybuffer";

    const timeoutMs = params.handshakeTimeoutMs ?? 30_000;
    let settled = false;
    let opened = false;
    let closed = false;

    const timer = setTimeout(() => fail("timeout"), timeoutMs);

    /** Reports the first failure and frees both the channel and the peer connection. */
    function fail(reason: string): void {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      channel.close();
      pc.close();
      if (!settled) {
        settled = true;
        reject(new Error(`browser relay closed before opening: ${reason}`));
      } else if (opened) {
        events.onClose(reason);
      }
    }

    channel.onopen = () => {
      if (closed) return;
      opened = true;
      clearTimeout(timer);
      settled = true;
      resolve({
        send(data: Uint8Array) {
          if (closed || channel.readyState !== "open") return;
          channel.send(data as ArrayBufferView<ArrayBuffer>);
        },
        close() {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          channel.close();
          pc.close();
          events.onClose("local");
        },
      });
      events.onOpen();
    };
    channel.onmessage = (event: MessageEvent) => {
      if (closed) return;
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        events.onPacket(new Uint8Array(data));
      }
    };
    channel.onclose = () => {
      if (closed) return;
      // Local close reports through the handle, so only a peer-initiated close
      // reaches here first.
      fail("remote");
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        fail(pc.connectionState);
      }
    };

    const remote = remoteDescription(params);
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => pc.setRemoteDescription(remote))
      .catch((error: unknown) => {
        fail(error instanceof Error ? error.message : String(error));
      });
  });
}

function dataChannelLabel(params: RelayConnectionParams): string {
  return params.sctpPort !== undefined ? `relay-${params.sctpPort}` : "relay";
}

function remoteDescription(params: RelayConnectionParams): RTCSessionDescriptionInit {
  const fingerprintAlgorithm = params.fingerprintAlgorithm ?? "sha-256";
  const sctpPort = params.sctpPort ?? 5000;
  const isIpv6 = params.address.includes(":");
  const family = isIpv6 ? "IP6" : "IP4";
  const unspecified = isIpv6 ? "::" : "0.0.0.0";
  const sdp = [
    "v=0",
    `o=- 0 0 IN ${family} ${unspecified}`,
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    `c=IN ${family} ${unspecified}`,
    "a=mid:0",
    `a=sctp-port:${sctpPort}`,
    `a=ice-ufrag:${params.iceUfrag}`,
    `a=ice-pwd:${params.icePwd}`,
    "a=setup:passive",
    `a=fingerprint:${fingerprintAlgorithm} ${params.fingerprint}`,
    `a=candidate:1 1 udp 2130706431 ${params.address} ${params.port} typ host`,
    "a=end-of-candidates",
    "",
  ].join("\r\n");

  return { type: "answer", sdp };
}
