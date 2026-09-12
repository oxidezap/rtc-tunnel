# rtc-tunnel

A single pre-negotiated binary data channel to one known peer, speaking just enough ICE, DTLS and SCTP to carry it. No peer connection, no SDP negotiation, no media, no TURN discovery.

A caller sees a relay transport provider that exposes `createRelayConnection`, `send` and `close`, and gets a working data channel without a WebRTC stack on the JS side. The provider interface is implementation agnostic: the bytes can travel through the wasm tunnel over UDP or through a platform-native `RTCPeerConnection`.

## Why

The relay peer is known up front: its address, ICE credentials and DTLS fingerprint are supplied before the connection starts. That removes everything a general WebRTC stack exists to negotiate, so the tunnel carries one opaque binary stream over ICE, DTLS and SCTP and nothing else.

- The core is Sans-I/O. It owns no socket, spawns no task and reads no clock after construction; the host feeds it datagrams and time.
- The wasm build targets bare `wasm32-unknown-unknown`, with the clock and entropy supplied as host imports. No WASI, no wasm-bindgen.
- The transport and runtime are injected, so the same core runs on Node, Bun or any host that can move UDP datagrams.
- A browser cannot open a raw UDP socket, so it uses a native `RTCPeerConnection` behind the same provider interface.

## Architecture

```text
application
    |
RelayTransportProvider
    |
rtc-tunnel (Sans-I/O core)
    |
ICE -> DTLS -> SCTP
    |
UDP adapter
```

## Core

The host drives the tunnel:

```rust
pub fn receive(&mut self, now_ms: u64, datagram: &[u8]);
pub fn tick(&mut self, now_ms: u64);
pub fn send(&mut self, message: &[u8]) -> SendResult;
pub fn poll_event(&mut self) -> Option<Event>;
pub fn next_deadline(&mut self) -> Option<u64>;
```

`Tunnel::new` is the relay path: it synthesizes the passive peer's answer from `TunnelConfig` and resolves once the channel opens. `offerer` plus `apply_remote_answer_sdp` drives an explicit offer/answer with a real peer, and `answerer` builds the answer from a peer's offer.

## Adapters

Each runtime has its own entry point, so a browser bundle never resolves `node:dgram`:

- `@oxidezap/rtc-tunnel` exports the transport contract and its types.
- `@oxidezap/rtc-tunnel/node` runs the wasm tunnel over `node:dgram` on Node and Bun.
- `@oxidezap/rtc-tunnel/browser` runs a native `RTCPeerConnection`.
- `@oxidezap/rtc-tunnel/advanced` exposes the low-level driver for hosts that implement `TunnelRuntime` themselves.

`createRelayConnection` resolves only once the data channel is open, and rejects if the tunnel closes or times out first. Backpressure is a host policy (`drop` or bounded `queue`), because the core cannot tell an audio frame from a control message and should not try.

## WASM

The module imports exactly three host functions from the `rtc_tunnel` module: a monotonic clock, a wall clock and entropy. `std` on bare wasm has no clock and panics on random, so `scripts/build-wasm.sh` rebuilds `std` from source with `scripts/wasm-std/{time,random}.rs` routed to those imports.

The build is hermetic: `RUSTUP_HOME` and `CARGO_HOME` live under `target/`, so the pinned nightly and the patched std stay disposable and the developer's `~/.rustup` is untouched. The shipped artifact is built for throughput, with the crypto and SCTP crates at `opt-level=3`; `scripts/check-wasm-size.sh` enforces a size budget. `--debug` produces a development build with full diagnostics.

`WasmTunnelModule.load` instantiates once and `createTunnel` makes many tunnels from it, so a long-lived process pays compile and instantiate once.

## Backends

The core has two implementations of the same API.

- `direct` is the shipped default. It drives `rtc-ice`, `rtc-dtls` and `rtc-sctp` itself, and the umbrella `rtc` crate is absent from its dependency graph. A negotiated channel has no DCEP handshake, so the direct path opens SCTP stream 0, sets the reliability from the config, and carries binary PPID messages.
- `rtc-backend` drives the umbrella `rtc::RTCPeerConnection` and exists for the reference peer and cross-checks.

Both pass the same interop suites and produce the same observable behavior. SRTP never appears in the direct dependency graph, though the `use_srtp` DTLS extension is still offered for interoperability.

## Vendored `rtc`

`vendor/rtc` is the published `rtc` crate source with one local patch, applied in place. The patch makes the DTLS handler publish its initial flight when `connect()` produces it instead of on a later timeout; without it, connection setup waits on the next ICE timer. It is listed with its reason and removal condition in `patches/rtc/README.md`, and `scripts/verify-vendored-rtc.sh` reconstructs the source from the pinned crate plus the patches and diffs it against `vendor/rtc/src` so the tree cannot drift.

## Development

```sh
npm install
npm run build              # compile the package to dist/ with declarations
npm test                  # the package's JS/TS tests
scripts/golden.sh          # all gates: fmt, clippy, Rust tests, wasm size/freshness, build, JS tests
scripts/build-wasm.sh      # shipped wasm artifact
scripts/build-bench.sh     # benchmark dependencies
```

## Benchmarks

`npm run bench` runs the wasm tunnel, the Sans-I/O core, werift and native wrtc against the same neutral Pion peer over a real UDP path, each in its own process. `npm run bench:stats` runs a paired comparison whose verdict is the confidence interval of the per-pair throughput ratio. `npm run bench:impair` runs the tunnel under loss, jitter and reordering. The harness computes and prints current numbers; no result is recorded in the repository.

## Status

Interoperability is proven against independent peers: the umbrella backend against the `rtc` crate, the direct backend against an `rtc` reference peer, the wasm tunnel against the native reference peer, and the whole path against a neutral Pion peer over UDP and against `werift`.

IPv4 and IPv6 are both supported; the local and remote endpoints must share an address family.

The remaining milestone is validation against a live relay: capturing a real TURN Allocate exchange through the tunnel. Until that capture exists, the values in `spec/protocol.md` are inferred from the working implementation and marked unconfirmed.
