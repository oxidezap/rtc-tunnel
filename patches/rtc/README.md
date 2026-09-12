# `rtc` local patches

`vendor/rtc` is the published `rtc` 0.21.0-rc.2 source with the library manifest kept and the example and test targets dropped. It is not a fork. Patches are applied in place and listed here with a reason and a removal condition.

## 0001: publish the DTLS initial flight when it is produced

File: `src/peer_connection/handler/dtls.rs`.

`DtlsHandler::handle_event` starts the DTLS client handshake from `ICESelectedCandidatePairChange` and calls `dtls_endpoint.connect(...)`, which queues the ClientHello as a transmit. The handler only drained `poll_transmit()` in `handle_timeout`, so the queued flight waited for the next scheduled timer. During ICE establishment that timer is `rtc-ice`'s 200 ms check interval, so a caller that advances time on `poll_timeout()` alone saw the handshake stall for up to that interval.

The patch drains `poll_transmit()` immediately after `connect()`, attaching the output to the event that produced it.

Removal condition: `rtc-tunnel` no longer builds on `rtc::RTCPeerConnection` (the direct backend does not use this handler).

## Applying an update

1. Replace `vendor/rtc/src` and the license files from the new registry source.
2. Reapply each patch below.
3. Update `vendor/rtc/Cargo.toml` if upstream changed a library dependency or feature.
4. Run `scripts/verify-vendored-rtc.sh` and `scripts/golden.sh`.
