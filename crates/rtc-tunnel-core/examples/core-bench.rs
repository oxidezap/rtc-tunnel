//! Sans-I/O core benchmark: two `Tunnel`s wired directly, no sockets, no JS.
//!
//! This isolates the Rust cost of `send`, `receive` and `poll_event` from the
//! host integration. Compare its throughput with the product benchmark to tell
//! whether a slowdown lives in the protocol code or in the JS/UDP boundary.
//!
//! Run with `cargo run --release --example core-bench`.

use std::net::SocketAddr;
use std::time::Instant;

use rtc_tunnel_core::{Event, SendResult, Tunnel, TunnelConfig};

const OFFERER: &str = "127.0.0.1:41000";
const ANSWERER: &str = "127.0.0.1:41001";

fn config(remote: &str) -> TunnelConfig {
    let mut config = TunnelConfig::new(
        remote.parse::<SocketAddr>().unwrap(),
        "u".repeat(4),
        "p".repeat(22),
        "aa:bb".to_owned(),
    );
    config.disable_fingerprint_verification = true;
    config
}

/// Moves every queued datagram between the two tunnels, counting messages.
fn pump(offerer: &mut Tunnel, answerer: &mut Tunnel, now: u64, received: &mut u64) {
    let mut moved = true;
    while moved {
        moved = false;
        while let Some(event) = offerer.poll_event() {
            if let Event::SendDatagram(bytes) = event {
                answerer.receive(now, &bytes);
                moved = true;
            }
        }
        while let Some(event) = answerer.poll_event() {
            match event {
                Event::SendDatagram(bytes) => {
                    offerer.receive(now, &bytes);
                    moved = true;
                }
                Event::Message(_) => *received += 1,
                _ => {}
            }
        }
    }
}

fn main() {
    let offerer_local: SocketAddr = OFFERER.parse().unwrap();
    let answerer_local: SocketAddr = ANSWERER.parse().unwrap();

    let mut offerer = Tunnel::offerer(config(ANSWERER), offerer_local, 0).unwrap();
    let offer = offerer.offer_sdp().unwrap();
    let mut answerer = Tunnel::answerer(config(OFFERER), answerer_local, &offer, 0).unwrap();
    let answer = answerer.answer_sdp().unwrap();
    offerer.apply_remote_answer_sdp(&answer).unwrap();

    let mut now = 0u64;
    let mut received = 0u64;
    while !(offerer.is_open() && answerer.is_open()) {
        pump(&mut offerer, &mut answerer, now, &mut received);
        assert!(
            !offerer.is_finished() && !answerer.is_finished(),
            "handshake failed"
        );
        now += 1;
        offerer.tick(now);
        answerer.tick(now);
        assert!(now < 20_000, "handshake timed out");
    }
    let handshake_ms = now;

    let payload_bytes = std::env::var("CORE_PAYLOAD")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1200usize);
    let window = std::env::var("CORE_WINDOW")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(128usize);
    let total = std::env::var("CORE_MESSAGES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200_000usize);

    let payload = vec![7u8; payload_bytes];
    let mut sent = 0usize;
    let mut delivered = 0u64;
    let mut backpressure = 0u64;
    let start = Instant::now();
    while delivered < total as u64 {
        while sent < total && sent - (delivered as usize) < window {
            match offerer.send(&payload) {
                SendResult::Accepted => sent += 1,
                SendResult::Backpressure => {
                    backpressure += 1;
                    break;
                }
                SendResult::TooLarge => panic!("benchmark payload exceeds max-message-size"),
                SendResult::NotOpen => panic!("channel closed during throughput"),
            }
        }
        pump(&mut offerer, &mut answerer, now, &mut delivered);
        now += 1;
    }
    let seconds = start.elapsed().as_secs_f64();
    let per_second = delivered as f64 / seconds;

    println!(
        "core: handshake {handshake_ms}ms, {delivered} messages of {payload_bytes}B in {seconds:.3}s = {per_second:.0} msg/s ({:.1} MiB/s), backpressure {backpressure}",
        (delivered as f64 * payload_bytes as f64) / seconds / (1024.0 * 1024.0)
    );
    println!(
        "BENCH_JSON {{\"name\":\"rtc-tunnel core (sans-io)\",\"available\":true,\"note\":\"two tunnels wired directly, no socket\",\"throughput\":{{\"core\":{{\"window\":{window},\"payloadBytes\":{payload_bytes},\"messages\":{delivered},\"seconds\":{seconds:.6},\"messagesPerSecond\":{per_second:.3},\"bytesPerSecond\":{:.3},\"backpressure\":{backpressure}}}}}}}",
        (delivered as f64 * payload_bytes as f64) / seconds
    );
}
