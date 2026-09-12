//! End-to-end interoperability test: the umbrella `rtc` backend as the offerer
//! against a real sans-I/O `rtc` peer connection (passive answerer). Datagrams
//! are moved between the two in-process, so the test is fully deterministic and
//! needs no network or relay.
//!
//! Run with `--features rtc-backend`. The shipped direct backend has its own
//! interop test in `tests/direct.rs`.

#![cfg(feature = "rtc-backend")]

use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use rtc::data_channel::RTCDataChannelInit;
use rtc::data_channel::RTCDataChannelState;
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
use rtc_tunnel_core::{Event, SendResult, Tunnel, TunnelConfig};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

struct ReferencePeer {
    pc: RTCPeerConnection,
    local_addr: SocketAddr,
    handle: usize,
}

impl ReferencePeer {
    fn new(local_addr: SocketAddr, ufrag: &str, pwd: &str) -> TestResult<Self> {
        let setting = SettingEngineBuilder::new()
            .with_ice_credentials(ufrag.to_owned(), pwd.to_owned())
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

    fn accept_offer(&mut self, offer_sdp: String) -> TestResult {
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
                // fine, channel is negotiated
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

    fn send(&mut self, payload: &[u8]) -> TestResult {
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
fn tunnel_opens_channel_and_exchanges_messages() -> TestResult {
    const UFRAG: &str = "refufrag";
    const PWD: &str = "refpwdrefpwdrefpwdrefpwd";

    let ref_socket = UdpSocket::bind("127.0.0.1:0")?;
    ref_socket.set_nonblocking(true)?;
    let ref_addr = ref_socket.local_addr()?;

    let tun_socket = UdpSocket::bind("127.0.0.1:0")?;
    tun_socket.set_nonblocking(true)?;
    let tun_addr = tun_socket.local_addr()?;

    let mut reference = ReferencePeer::new(ref_addr, UFRAG, PWD)?;

    let mut config = TunnelConfig::new(
        ref_addr,
        UFRAG.to_owned(),
        PWD.to_owned(),
        "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff".to_owned(),
    );
    config.disable_fingerprint_verification = true;
    config.handshake_timeout_ms = 10_000;

    let t0 = Instant::now();
    let mut tunnel = Tunnel::new(config, tun_addr, 0)?;
    let offer = tunnel.offer_sdp().expect("tunnel must produce an offer");
    reference.accept_offer(offer)?;

    let mut tun_to_ref: Vec<(Bytes, SocketAddr)> = Vec::new();
    let mut ref_to_tun: Vec<(Bytes, SocketAddr)> = Vec::new();
    let mut tun_buf = vec![0u8; 2048];
    let mut ref_buf = vec![0u8; 2048];

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut tunnel_opened = false;
    let mut ref_got: Option<Bytes> = None;
    let mut tunnel_got: Option<Bytes> = None;
    let mut sent_from_tunnel = false;
    let mut sent_from_ref = false;

    while Instant::now() < deadline {
        let now_ms = t0.elapsed().as_millis() as u64;

        tunnel.tick(now_ms);
        reference.tick();

        let mut outgoing = Vec::new();
        while let Some(event) = tunnel.poll_event() {
            match event {
                Event::SendDatagram(bytes) => outgoing.push(bytes),
                Event::Opened => tunnel_opened = true,
                Event::Message(bytes) => tunnel_got = Some(bytes),
                Event::Closed(reason) => panic!("tunnel closed early: {reason:?}"),
            }
        }
        for bytes in outgoing {
            let _ = tun_socket.send_to(&bytes, ref_addr);
        }

        reference.poll_out(&mut ref_to_tun);

        while let Ok((n, _)) = tun_socket.recv_from(&mut tun_buf) {
            tunnel.receive(t0.elapsed().as_millis() as u64, &tun_buf[..n]);
        }
        while let Ok((n, _)) = ref_socket.recv_from(&mut ref_buf) {
            reference.read(&ref_buf[..n], tun_addr);
        }

        while let Some((bytes, peer)) = ref_to_tun.pop() {
            let _ = ref_socket.send_to(&bytes, peer);
        }
        while let Some((bytes, peer)) = tun_to_ref.pop() {
            let _ = tun_socket.send_to(&bytes, peer);
        }

        if tunnel_opened && reference.is_open() {
            if !sent_from_tunnel {
                assert_eq!(tunnel.send(b"ping-from-tunnel"), SendResult::Accepted);
                sent_from_tunnel = true;
            }
            if !sent_from_ref {
                reference.send(b"pong-from-reference")?;
                sent_from_ref = true;
            }
        }

        if let Some(msg) = reference.recv_message() {
            ref_got = Some(msg);
        }

        if ref_got.is_some() && tunnel_got.is_some() {
            break;
        }

        std::thread::sleep(Duration::from_millis(1));
    }

    assert!(tunnel_opened, "tunnel never opened");
    assert_eq!(
        ref_got.as_deref(),
        Some(&b"ping-from-tunnel"[..]),
        "reference did not receive tunnel payload"
    );
    assert_eq!(
        tunnel_got.as_deref(),
        Some(&b"pong-from-reference"[..]),
        "tunnel did not receive reference payload"
    );
    Ok(())
}
