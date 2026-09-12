//! Interop test for the direct backend: `DirectTunnel` as the offerer against
//! the in-process `rtc` reference peer (passive answerer). Datagrams are moved
//! directly, no sockets, so it is deterministic.

#![cfg(feature = "direct")]

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use rtc::data_channel::{RTCDataChannelInit, RTCDataChannelState};
use rtc::peer_connection::configuration::media_engine::MediaEngine;
use rtc::peer_connection::configuration::setting_engine::SettingEngineBuilder;
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::event::{RTCDataChannelEvent, RTCPeerConnectionEvent};
use rtc::peer_connection::message::{RTCMessage, TaggedRTCMessage};
use rtc::peer_connection::state::RTCPeerConnectionState;
use rtc::peer_connection::transport::{
    CandidateConfig, CandidateHostConfig, RTCDtlsRole, RTCIceCandidate,
};
use rtc::peer_connection::{RTCPeerConnection, RTCPeerConnectionBuilder};
use rtc::sansio::Protocol;
use rtc::shared::{TaggedBytesMut, TransportContext, TransportProtocol};
use rtc_tunnel_core::direct::DirectTunnel;
use rtc_tunnel_core::TunnelConfig;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

struct ReferencePeer {
    pc: RTCPeerConnection,
    local_addr: SocketAddr,
    handle: usize,
}

impl ReferencePeer {
    fn new(local_addr: SocketAddr) -> TestResult<Self> {
        let setting = SettingEngineBuilder::new()
            .with_ice_credentials("refufrag".to_owned(), "refpwdrefpwdrefpwdrefpwd".to_owned())
            .with_answering_dtls_role(RTCDtlsRole::Server)
            .build();
        let mut pc = RTCPeerConnectionBuilder::new()
            .with_configuration(RTCConfigurationBuilder::new().build())
            .with_media_engine(MediaEngine::default())
            .with_setting_engine(setting)
            .build(Instant::now())?;
        let init = RTCDataChannelInit {
            ordered: false,
            max_retransmits: Some(0),
            negotiated: Some(0),
            ..Default::default()
        };
        let handle = pc.create_data_channel("relay", Some(init))?.id();
        Ok(Self {
            pc,
            local_addr,
            handle,
        })
    }

    fn accept_offer(&mut self, offer_sdp: String) -> TestResult<()> {
        let offer = rtc::peer_connection::sdp::RTCSessionDescription::offer(offer_sdp)?;
        self.pc.set_remote_description(Instant::now(), offer)?;
        let candidate = CandidateHostConfig {
            base_config: CandidateConfig {
                network: "udp".to_owned(),
                address: self.local_addr.ip().to_string(),
                port: self.local_addr.port(),
                component: 1,
                ..Default::default()
            },
            ..Default::default()
        }
        .new_candidate_host()?;
        self.pc
            .add_local_candidate(RTCIceCandidate::from(&candidate).to_json()?)?;
        let answer = self.pc.create_answer(None)?;
        self.pc.set_local_description(Instant::now(), answer)?;
        Ok(())
    }

    fn is_open(&mut self) -> bool {
        self.pc
            .data_channel(self.handle)
            .map(|dc| dc.ready_state() == RTCDataChannelState::Open)
            .unwrap_or(false)
    }

    fn poll_out(&mut self, sink: &mut Vec<(Bytes, SocketAddr)>) {
        while let Some(msg) = self.pc.poll_write() {
            sink.push((Bytes::from(msg.message), msg.transport.peer_addr));
        }
        while let Some(event) = self.pc.poll_event() {
            if let RTCPeerConnectionEvent::OnConnectionStateChangeEvent(
                RTCPeerConnectionState::Failed,
            ) = event
            {
                panic!("reference peer failed");
            }
            if let RTCPeerConnectionEvent::OnDataChannel(RTCDataChannelEvent::OnOpen(_)) = event {
                let _ = event;
            }
        }
    }

    fn recv_message(&mut self) -> Option<Bytes> {
        while let Some(TaggedRTCMessage { message, .. }) = self.pc.poll_read() {
            if let RTCMessage::DataChannelMessage(_, msg) = message {
                return Some(Bytes::from(msg.data));
            }
        }
        None
    }

    fn send(&mut self, payload: &[u8]) -> TestResult<()> {
        if let Some(mut dc) = self.pc.data_channel(self.handle) {
            dc.send(Instant::now(), BytesMut::from(payload))?;
        }
        Ok(())
    }

    fn read(&mut self, datagram: &[u8], peer: SocketAddr) {
        let _ = self.pc.handle_read(TaggedBytesMut {
            now: Instant::now(),
            transport: TransportContext {
                local_addr: self.local_addr,
                peer_addr: peer,
                ecn: None,
                transport_protocol: TransportProtocol::UDP,
            },
            message: BytesMut::from(datagram),
        });
    }

    fn tick(&mut self) {
        let _ = self.pc.handle_timeout(Instant::now());
    }
}

#[test]
fn direct_tunnel_opens_channel_against_rtc_peer() -> TestResult {
    run_interop("127.0.0.1:47000", "127.0.0.1:47001")
}

#[test]
fn direct_tunnel_opens_channel_over_ipv6() -> TestResult {
    run_interop("[::1]:47000", "[::1]:47001")
}

fn run_interop(ref_addr: &str, tun_addr: &str) -> TestResult {
    let ref_addr: SocketAddr = ref_addr.parse()?;
    let tun_addr: SocketAddr = tun_addr.parse()?;

    let mut reference = ReferencePeer::new(ref_addr)?;

    let mut config = TunnelConfig::new(
        ref_addr,
        "refufrag".to_owned(),
        "refpwdrefpwdrefpwdrefpwd".to_owned(),
        "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff"
            .to_owned(),
    );
    config.disable_fingerprint_verification = true;
    // A large `now_ms` covers the deadline regression: the budget used to be
    // `timeout - now_ms` and failed instantly once the host counter passed it.
    config.handshake_timeout_ms = 5000;
    let start_ms: u64 = 3_600_000;

    let t0 = Instant::now();
    let mut tunnel = DirectTunnel::offerer(config, tun_addr, start_ms)?;
    let offer = tunnel.offer_sdp().expect("offer");
    reference.accept_offer(offer)?;

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut tunnel_opened = false;
    let mut tunnel_got: Option<Vec<u8>> = None;
    let mut ref_got: Option<Bytes> = None;
    let mut sent_from_tunnel = false;
    let mut sent_from_ref = false;

    while Instant::now() < deadline {
        let now_ms = start_ms + t0.elapsed().as_millis() as u64;
        tunnel.tick(now_ms);
        reference.tick();

        // Drain every datagram the tunnel wants to send, into the peer.
        let mut to_reference = Vec::new();
        while let Some(event) = tunnel.poll_event() {
            if let rtc_tunnel_core::Event::SendDatagram(bytes) = event {
                to_reference.push(bytes);
            }
        }
        for datagram in to_reference {
            reference.read(&datagram, tun_addr);
        }

        // Move reference output back to the tunnel.
        let mut ref_out: Vec<(Bytes, SocketAddr)> = Vec::new();
        reference.poll_out(&mut ref_out);
        for (bytes, _peer) in ref_out {
            tunnel.receive(now_ms, &bytes);
        }

        if tunnel.is_open() && reference.is_open() {
            tunnel_opened = true;
            if !sent_from_tunnel {
                assert_eq!(
                    tunnel.send(b"ping-from-direct"),
                    rtc_tunnel_core::SendResult::Accepted
                );
                sent_from_tunnel = true;
            }
            if !sent_from_ref {
                reference.send(b"pong-from-reference")?;
                sent_from_ref = true;
            }
        }

        // Drain tunnel output again so the ping reaches the peer.
        let mut to_reference = Vec::new();
        while let Some(event) = tunnel.poll_event() {
            match event {
                rtc_tunnel_core::Event::SendDatagram(bytes) => to_reference.push(bytes),
                rtc_tunnel_core::Event::Message(bytes) => tunnel_got = Some(bytes.to_vec()),
                _ => {}
            }
        }
        for datagram in to_reference {
            reference.read(&datagram, tun_addr);
        }

        if let Some(msg) = reference.recv_message() {
            ref_got = Some(msg);
        }
        if tunnel_got.is_some() && ref_got.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }

    assert!(tunnel_opened, "direct tunnel never opened");
    assert_eq!(
        ref_got.as_deref(),
        Some(&b"ping-from-direct"[..]),
        "reference did not receive direct tunnel payload"
    );
    assert_eq!(
        tunnel_got.as_deref(),
        Some(&b"pong-from-reference"[..]),
        "direct tunnel did not receive reference payload"
    );

    // SCTP cannot carry a zero-length user message, so an empty payload travels
    // as one zero byte with the BinaryEmpty PPID and must arrive empty.
    let mut ref_empty: Option<Bytes> = None;
    let mut tunnel_empty: Option<Vec<u8>> = None;
    let mut sent_empty_from_tunnel = false;
    let mut sent_empty_from_ref = false;
    let empty_deadline = Instant::now() + Duration::from_secs(10);

    while Instant::now() < empty_deadline {
        let now_ms = start_ms + t0.elapsed().as_millis() as u64;
        tunnel.tick(now_ms);
        reference.tick();

        if !sent_empty_from_tunnel {
            assert_eq!(tunnel.send(b""), rtc_tunnel_core::SendResult::Accepted);
            sent_empty_from_tunnel = true;
        }
        if !sent_empty_from_ref {
            reference.send(b"")?;
            sent_empty_from_ref = true;
        }

        let mut to_reference = Vec::new();
        while let Some(event) = tunnel.poll_event() {
            match event {
                rtc_tunnel_core::Event::SendDatagram(bytes) => to_reference.push(bytes),
                rtc_tunnel_core::Event::Message(bytes) => tunnel_empty = Some(bytes.to_vec()),
                _ => {}
            }
        }
        for datagram in to_reference {
            reference.read(&datagram, tun_addr);
        }
        let mut ref_out: Vec<(Bytes, SocketAddr)> = Vec::new();
        reference.poll_out(&mut ref_out);
        for (bytes, _peer) in ref_out {
            tunnel.receive(now_ms, &bytes);
        }
        if let Some(msg) = reference.recv_message() {
            if msg.is_empty() {
                ref_empty = Some(msg);
            }
        }
        // One more drain so the reference's empty reply reaches the tunnel.
        let mut to_reference = Vec::new();
        while let Some(event) = tunnel.poll_event() {
            match event {
                rtc_tunnel_core::Event::SendDatagram(bytes) => to_reference.push(bytes),
                rtc_tunnel_core::Event::Message(bytes) => tunnel_empty = Some(bytes.to_vec()),
                _ => {}
            }
        }
        for datagram in to_reference {
            reference.read(&datagram, tun_addr);
        }
        if ref_empty.is_some() && tunnel_empty.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }

    assert_eq!(
        ref_empty.as_deref(),
        Some(&b""[..]),
        "reference did not receive the empty tunnel message as empty"
    );
    assert_eq!(
        tunnel_empty.as_deref(),
        Some(&b""[..]),
        "direct tunnel did not receive the empty reference message as empty"
    );

    // The negotiated max-message-size boundary: one byte under and exactly at
    // the limit are accepted, one over is rejected as TooLarge rather than
    // silently coerced or reported as NotOpen.
    let max = rtc_tunnel_core::MAX_MESSAGE_SIZE;
    let under = vec![7u8; max - 1];
    let at = vec![7u8; max];
    let over = vec![7u8; max + 1];
    assert_eq!(tunnel.send(&under), rtc_tunnel_core::SendResult::Accepted);
    assert_eq!(tunnel.send(&at), rtc_tunnel_core::SendResult::Accepted);
    assert_eq!(tunnel.send(&over), rtc_tunnel_core::SendResult::TooLarge);

    Ok(())
}
