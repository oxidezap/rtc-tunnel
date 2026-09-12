//! Validation and lifecycle tests that need no peer.

use std::net::SocketAddr;

use rtc_tunnel_core::{CloseReason, Event, SendResult, Tunnel, TunnelConfig};

fn loopback() -> SocketAddr {
    "127.0.0.1:5000".parse().unwrap()
}

fn config() -> TunnelConfig {
    TunnelConfig::new(
        loopback(),
        "ufrag".to_owned(),
        "pwd".to_owned(),
        "aa:bb:cc:dd".to_owned(),
    )
}

#[test]
fn rejects_unspecified_remote() {
    let mut cfg = config();
    cfg.remote = "0.0.0.0:5000".parse().unwrap();
    let err = match Tunnel::new(cfg, "127.0.0.1:6000".parse().unwrap(), 0) {
        Ok(_) => panic!("unspecified remote must be rejected"),
        Err(err) => err,
    };
    assert!(err.to_string().contains("remote address"));
}

#[test]
fn rejects_mixed_address_families() {
    let mut cfg = config();
    cfg.remote = "[::1]:5000".parse().unwrap();
    let err = match Tunnel::new(cfg, "127.0.0.1:6000".parse().unwrap(), 0) {
        Ok(_) => panic!("mixed families must be rejected"),
        Err(err) => err,
    };
    assert!(err.to_string().contains("address family"));
}

#[test]
fn accepts_ipv6_endpoints() {
    let cfg = TunnelConfig::new(
        "[::1]:5000".parse().unwrap(),
        "ufrag".to_owned(),
        "pwd".to_owned(),
        "aa:bb:cc:dd".to_owned(),
    );
    let tunnel = Tunnel::new(cfg, "[::1]:6000".parse().unwrap(), 0)
        .expect("IPv6 endpoints must be accepted");
    assert!(!tunnel.is_open());
}

#[test]
fn ipv6_sdp_uses_the_right_family() {
    let cfg = TunnelConfig::new(
        "[::1]:5000".parse().unwrap(),
        "ufrag".to_owned(),
        "pwd".to_owned(),
        "aa:bb:cc:dd".to_owned(),
    );
    let tunnel = Tunnel::new(cfg, "[::1]:6000".parse().unwrap(), 0).unwrap();
    let offer = tunnel.offer_sdp().expect("offer");
    assert!(
        offer.contains(" ::1 6000 typ host"),
        "offer must carry the IPv6 host candidate: {offer}"
    );
    // The direct backend also selects the SDP address family. The umbrella
    // `rtc` crate hardcodes IP4 in its own SDP, so only check it directly.
    #[cfg(feature = "direct")]
    assert!(
        offer.contains("IN IP6") && !offer.contains("IN IP4"),
        "direct offer must advertise IP6: {offer}"
    );
}

#[test]
fn rejects_empty_credentials() {
    let mut cfg = config();
    cfg.ice_ufrag.clear();
    let err = match Tunnel::new(cfg, "127.0.0.1:6000".parse().unwrap(), 0) {
        Ok(_) => panic!("empty credentials must be rejected"),
        Err(err) => err,
    };
    assert!(err.to_string().contains("credentials") || err.to_string().contains("config"));
}

#[test]
fn send_before_open_is_rejected() {
    let now = 0;
    let mut tunnel = Tunnel::new(config(), "127.0.0.1:6000".parse().unwrap(), now).unwrap();
    assert!(!tunnel.is_open());
    assert_eq!(tunnel.send(b"nope"), SendResult::NotOpen);
}

#[test]
fn first_events_are_ice_datagrams() {
    let mut tunnel = Tunnel::new(config(), "127.0.0.1:6000".parse().unwrap(), 0).unwrap();
    tunnel.tick(0);
    let mut datagrams = 0;
    while let Some(event) = tunnel.poll_event() {
        match event {
            Event::SendDatagram(_) => datagrams += 1,
            other => panic!("unexpected event before handshake: {other:?}"),
        }
    }
    assert!(datagrams > 0, "tunnel must queue an ICE connectivity check");
    assert!(tunnel.next_deadline().is_some());
}

#[test]
fn handshake_times_out_without_a_peer() {
    let mut cfg = config();
    cfg.handshake_timeout_ms = 1_000;
    let mut tunnel = Tunnel::new(cfg, "127.0.0.1:6000".parse().unwrap(), 0).unwrap();

    let mut closed = None;
    for now in (0..5_000).step_by(250) {
        tunnel.tick(now);
        while let Some(event) = tunnel.poll_event() {
            if let Event::Closed(reason) = event {
                closed = Some(reason);
            }
        }
        if closed.is_some() {
            break;
        }
    }

    assert_eq!(closed, Some(CloseReason::Timeout));
    assert!(tunnel.is_finished());
    assert_eq!(tunnel.next_deadline(), None);
    assert_eq!(tunnel.send(b"late"), SendResult::NotOpen);
}

/// Two direct tunnels open once the answerer's real ICE credentials reach the
/// offerer. Each side generates its own, so the configured guess never
/// matches; without the handoff the checks fail both ways and the handshake
/// times out. This is the regression test for the core benchmark reporting
/// `n/a`.
#[cfg(feature = "direct")]
#[test]
fn two_tunnels_open_once_answer_credentials_are_applied() {
    use rtc_tunnel_core::direct::DirectTunnel;

    fn answer_value(answer: &str, name: &str) -> String {
        answer
            .lines()
            .find_map(|line| line.strip_prefix(name).map(str::to_owned))
            .unwrap_or_else(|| panic!("answer carried no {name} line"))
    }

    fn pump(offerer: &mut DirectTunnel, answerer: &mut DirectTunnel, now: u64, received: &mut u64) {
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

    let offerer_local: SocketAddr = "127.0.0.1:41000".parse().unwrap();
    let answerer_local: SocketAddr = "127.0.0.1:41001".parse().unwrap();
    let mut offer_cfg = config();
    offer_cfg.remote = answerer_local;
    let mut answer_cfg = config();
    answer_cfg.remote = offerer_local;
    answer_cfg.disable_fingerprint_verification = true;
    offer_cfg.disable_fingerprint_verification = true;

    let mut offerer = DirectTunnel::offerer(offer_cfg, offerer_local, 0).unwrap();
    let offer = offerer.offer_sdp().expect("offer");
    let mut answerer = DirectTunnel::answerer(answer_cfg, answerer_local, &offer, 0).unwrap();
    let answer = answerer.answer_sdp().expect("answer");
    offerer.apply_remote_answer_sdp(&answer).unwrap();
    offerer
        .set_remote_ice_credentials(
            answer_value(&answer, "a=ice-ufrag:"),
            answer_value(&answer, "a=ice-pwd:"),
        )
        .unwrap();

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

    assert_eq!(offerer.send(b"hello"), SendResult::Accepted);
    while received == 0 {
        pump(&mut offerer, &mut answerer, now, &mut received);
        now += 1;
        assert!(now < 20_000, "message never arrived");
    }
}
