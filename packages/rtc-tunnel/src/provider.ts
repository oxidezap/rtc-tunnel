/**
 * The relay transport contract.
 *
 * A caller knows a connection only through these shapes. It does not know
 * whether the bytes travel over a browser RTCPeerConnection, a Node
 * werift/wrtc instance, or a wasm tunnel driven by a UDP socket.
 */

export interface RelayConnectionParams {
  /** Relay host to reach, as an IPv4 or IPv6 literal. */
  address: string;
  /** Relay UDP port. */
  port: number;
  /** Remote ICE username fragment. */
  iceUfrag: string;
  /** Remote ICE password. */
  icePwd: string;
  /** Remote DTLS certificate fingerprint, colon separated hex. */
  fingerprint: string;
  /** Fingerprint hash algorithm. Only `sha-256` is supported. */
  fingerprintAlgorithm?: string;
  /** Remote SCTP port. Defaults to 5000. */
  sctpPort?: number;
  /** SCTP stream id of the pre-negotiated channel. Defaults to 0. */
  streamId?: number;
  /** Whether the channel preserves order. Defaults to false. */
  ordered?: boolean;
  /** Retransmission cap. Defaults to 0. */
  maxRetransmits?: number;
  /** Handshake budget in milliseconds. Defaults to 30000. */
  handshakeTimeoutMs?: number;
}

export interface RelayConnectionEvents {
  onOpen(): void;
  onPacket(data: Uint8Array): void;
  onClose(reason?: string): void;
}

export interface RelayConnectionHandle {
  send(data: Uint8Array): void;
  close(): void;
  /** Live transport counters, when the provider can report them. */
  stats?(): {
    bufferedBytes: number;
    droppedDatagrams: number;
    refusedSends: number;
    /** IANA name of the negotiated DTLS cipher suite, once known. */
    cipherSuite?: string;
  };
}

/** Address the host bound its UDP socket to, if it has one. */
export interface RelayTransportContext {
  /** Local `ip:port` the transport sends from, when the provider owns a socket. */
  localAddress?: string;
}

export interface RelayTransportProvider {
  createRelayConnection(
    params: RelayConnectionParams,
    events: RelayConnectionEvents,
    context?: RelayTransportContext,
  ): Promise<RelayConnectionHandle>;
}
