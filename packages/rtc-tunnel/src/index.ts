/**
 * `@oxidezap/rtc-tunnel`
 *
 * A provider-agnostic tunnel. A caller sees only `createRelayConnection`,
 * `send` and `close`; the node and browser entry points decide whether those
 * bytes travel through a wasm Sans-I/O tunnel over a UDP socket or through a
 * platform-native `RTCPeerConnection`.
 *
 * This root entry exports only the transport contract. Runtime specific pieces
 * live behind `@oxidezap/rtc-tunnel/node` and
 * `@oxidezap/rtc-tunnel/browser`; hosts that implement `TunnelRuntime`
 * themselves use `@oxidezap/rtc-tunnel/advanced`.
 */

export type {
  RelayConnectionEvents,
  RelayConnectionHandle,
  RelayConnectionParams,
  RelayTransportContext,
  RelayTransportProvider,
} from "./provider.ts";
