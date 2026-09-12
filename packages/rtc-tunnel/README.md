# @oxidezap/rtc-tunnel

A provider-agnostic tunnel. A caller sees only `createRelayConnection`, `send` and `close`; the entry point decides what carries those bytes.

Zero npm runtime dependencies. Ships compiled JavaScript and type declarations.

## Usage

```ts
import { createNodeRelayProvider } from "@oxidezap/rtc-tunnel/node";

const provider = await createNodeRelayProvider();
const handle = await provider.createRelayConnection(params, {
  onOpen: () => {},
  onPacket: (data) => {},
  onClose: (reason) => {},
});
handle.send(payload);
handle.close();
```

`createRelayConnection` resolves only once the data channel is open, and rejects if the tunnel closes or times out first.

## Entry points

- `@oxidezap/rtc-tunnel` exports the transport contract and its types.
- `@oxidezap/rtc-tunnel/node` runs the wasm tunnel over `node:dgram` on Node and Bun.
- `@oxidezap/rtc-tunnel/browser` runs a native `RTCPeerConnection`.
- `@oxidezap/rtc-tunnel/advanced` exposes the low-level driver for hosts that implement `TunnelRuntime` themselves.
- `@oxidezap/rtc-tunnel/wasm` exposes the raw engine for a custom loader.

## Backpressure

`send` drops when the tunnel is not usable. When the channel's send buffer is over its cap, `createNodeRelayProvider({ backpressure: "queue" })` holds the message in a bounded queue instead of dropping it.

## Browser

A page cannot open a raw UDP socket, so the browser entry does not use the wasm tunnel. It implements the same provider contract with a native `RTCPeerConnection`.

## License

MIT. The bundled `wasm/rtc_tunnel.wasm` statically links Rust crates; their licenses are listed in `THIRD-PARTY.md`.

