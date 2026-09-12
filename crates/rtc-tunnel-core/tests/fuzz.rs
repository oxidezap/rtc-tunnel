//! Malformed input must never panic the tunnel.

use std::net::SocketAddr;

use rtc_tunnel_core::{Tunnel, TunnelConfig};

fn config() -> TunnelConfig {
    TunnelConfig::new(
        "127.0.0.1:5000".parse().unwrap(),
        "ufrag".to_owned(),
        "pwd".to_owned(),
        "aa:bb:cc:dd".to_owned(),
    )
}

fn xorshift(state: &mut u64) -> u64 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    x
}

#[test]
fn random_datagrams_do_not_panic() {
    let local: SocketAddr = "127.0.0.1:6000".parse().unwrap();
    let mut tunnel = Tunnel::new(config(), local, 0).unwrap();
    let mut state = 0x2545_F491_4F6C_DD1D_u64;
    let mut max_events = 0usize;

    for i in 0..5_000u64 {
        let len = (xorshift(&mut state) % 2048) as usize;
        let mut datagram = vec![0u8; len];
        for byte in &mut datagram {
            *byte = xorshift(&mut state) as u8;
        }
        tunnel.tick(i);
        tunnel.receive(i, &datagram);

        let mut drained = 0usize;
        while tunnel.poll_event().is_some() {
            drained += 1;
            assert!(drained < 100_000, "event queue grew without bound");
        }
        max_events = max_events.max(drained);
    }

    // Random bytes may legitimately trip a fatal protocol error, so reaching
    // `finished` is not a failure. The invariants are: no panic, no unbounded
    // event growth, and a consistent terminal state.
    assert!(max_events < 100_000);
    let _ = tunnel.next_deadline();
    let _ = tunnel.send(b"after-fuzz");
}

#[test]
fn truncated_handshake_datagrams_do_not_panic() {
    let local: SocketAddr = "127.0.0.1:6000".parse().unwrap();
    let mut tunnel = Tunnel::new(config(), local, 0).unwrap();

    for prefix in [0u8, 1, 20, 22, 23, 64, 100] {
        for len in 0..80usize {
            let datagram = vec![prefix; len];
            tunnel.receive(0, &datagram);
            while tunnel.poll_event().is_some() {}
        }
    }
    let _ = tunnel.next_deadline();
    let _ = tunnel.send(b"after-truncation");
}
