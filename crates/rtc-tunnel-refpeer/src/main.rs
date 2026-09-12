//! A passive sans-I/O reference peer for interop tests and benchmarks.
//!
//! It reads a WebRTC offer from stdin, synthesizes the answer, and echoes every
//! data channel message back. It is intentionally the "other end" of
//! `rtc-tunnel-core`: same data channel parameters, opposite DTLS role.
//!
//! Usage:
//!
//! ```text
//! rtc-tunnel-refpeer --bind 127.0.0.1:0 --ufrag X --pwd Y
//! READY <port>
//! <offer SDP on stdin>
//! OPEN
//! ```
//!
//! Diagnostics are line oriented on stdout so a host process can drive it.

use std::io::{Read, Write};
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use bytes::BytesMut;
use rtc::data_channel::RTCDataChannelInit;
use rtc::peer_connection::configuration::media_engine::MediaEngine;
use rtc::peer_connection::configuration::setting_engine::SettingEngineBuilder;
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::event::{RTCDataChannelEvent, RTCPeerConnectionEvent};
use rtc::peer_connection::message::{RTCMessage, TaggedRTCMessage};
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::state::RTCPeerConnectionState;
use rtc::peer_connection::transport::{
    CandidateConfig, CandidateHostConfig, RTCDtlsRole, RTCIceCandidate,
};
use rtc::peer_connection::RTCPeerConnectionBuilder;
use rtc::sansio::Protocol;
use rtc::shared::{TaggedBytesMut, TransportContext, TransportProtocol};

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let bind: SocketAddr = arg_value(&args, "--bind")
        .unwrap_or_else(|| "127.0.0.1:0".to_owned())
        .parse()?;
    let ufrag = arg_value(&args, "--ufrag").unwrap_or_else(|| "refufrag".to_owned());
    let pwd = arg_value(&args, "--pwd").unwrap_or_else(|| "refpwdrefpwdrefpwdrefpwd".to_owned());
    let lifetime = Duration::from_millis(
        arg_value(&args, "--lifetime-ms")
            .and_then(|v| v.parse().ok())
            .unwrap_or(60_000),
    );

    let socket = UdpSocket::bind(bind)?;
    socket.set_nonblocking(true)?;
    let local_addr = socket.local_addr()?;
    println!("READY {}", local_addr.port());
    std::io::stdout().flush()?;

    let mut offer = String::new();
    std::io::stdin().read_to_string(&mut offer)?;
    if offer.trim().is_empty() {
        eprintln!("no offer received on stdin");
        std::process::exit(2);
    }

    let setting = SettingEngineBuilder::new()
        .with_ice_credentials(ufrag.clone(), pwd.clone())
        .with_answering_dtls_role(RTCDtlsRole::Server)
        .build();
    let mut pc = RTCPeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().build())
        .with_media_engine(MediaEngine::default())
        .with_setting_engine(setting)
        .build(Instant::now())?;

    let remote = RTCSessionDescription::offer(offer)?;
    pc.set_remote_description(Instant::now(), remote)?;

    let init = RTCDataChannelInit {
        ordered: false,
        max_retransmits: Some(0),
        negotiated: Some(0),
        ..Default::default()
    };
    let handle = pc.create_data_channel("relay", Some(init))?.id();

    let candidate = CandidateHostConfig {
        base_config: CandidateConfig {
            network: "udp".to_owned(),
            address: local_addr.ip().to_string(),
            port: local_addr.port(),
            component: 1,
            ..Default::default()
        },
        ..Default::default()
    }
    .new_candidate_host()?;
    pc.add_local_candidate(RTCIceCandidate::from(&candidate).to_json()?)?;

    let answer = pc.create_answer(None)?;
    pc.set_local_description(Instant::now(), answer)?;

    // Let an active peer pick up this answer when the two are paired through a
    // harness instead of the synthesized answer bundled in the tunnel.
    println!(
        "ANSWER {}",
        base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            pc.local_description()
                .map(|d| d.sdp)
                .unwrap_or_default()
                .as_bytes()
        )
    );
    std::io::stdout().flush()?;

    let start = Instant::now();
    let mut buf = vec![0u8; 2048];
    let mut opened = false;
    let mut echoes = 0u64;

    while start.elapsed() < lifetime {
        while let Some(msg) = pc.poll_write() {
            let _ = socket.send_to(&msg.message, msg.transport.peer_addr);
        }
        while let Some(event) = pc.poll_event() {
            match event {
                RTCPeerConnectionEvent::OnDataChannel(RTCDataChannelEvent::OnOpen(_)) => {
                    if !opened {
                        opened = true;
                        println!("OPEN");
                        std::io::stdout().flush()?;
                    }
                }
                RTCPeerConnectionEvent::OnDataChannel(RTCDataChannelEvent::OnClose(_)) => {
                    println!("CHANNEL_CLOSED");
                    std::io::stdout().flush()?;
                }
                RTCPeerConnectionEvent::OnConnectionStateChangeEvent(
                    RTCPeerConnectionState::Failed,
                ) => {
                    println!("FAILED");
                    std::io::stdout().flush()?;
                    break;
                }
                _ => {}
            }
        }
        while let Some(TaggedRTCMessage { message, .. }) = pc.poll_read() {
            if let RTCMessage::DataChannelMessage(_, msg) = message {
                if let Some(mut dc) = pc.data_channel(handle) {
                    let _ = dc.send(Instant::now(), BytesMut::from(&msg.data[..]));
                    echoes += 1;
                    println!("ECHO {echoes}");
                    std::io::stdout().flush()?;
                }
            }
        }

        match socket.recv_from(&mut buf) {
            Ok((n, peer_addr)) => {
                let _ = pc.handle_read(TaggedBytesMut {
                    now: Instant::now(),
                    transport: TransportContext {
                        local_addr,
                        peer_addr,
                        ecn: None,
                        transport_protocol: TransportProtocol::UDP,
                    },
                    message: BytesMut::from(&buf[..n]),
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e.into()),
        }

        let _ = pc.handle_timeout(Instant::now());
        std::thread::sleep(Duration::from_millis(1));
    }

    let _ = pc.close();
    println!("DONE");
    std::io::stdout().flush()?;
    Ok(())
}
