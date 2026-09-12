//! A passive-side tunnel endpoint that answers a real WebRTC peer's offer.
//!
//! The tunnel answers `setup:active`, so it becomes the DTLS client and starts
//! the SCTP association. That is the arrangement a browser-style peer expects:
//! it offers `actpass` and answers `setup:passive`, then waits for the tunnel
//! to bring SCTP up.
//!
//! Protocol, line oriented:
//!
//! ```text
//! ... stdin: OFFER <base64 sdp> ...
//! PORT <local udp port>
//! ANSWER <base64 sdp>
//! OPEN
//! MSG <n> <base64 payload>   (each received message is echoed back)
//! CLOSED <reason>
//! ```

use std::io::{BufRead, Write};
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rtc_tunnel_core::{CloseReason, Event, SendResult, Tunnel, TunnelConfig};

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn candidate_address(sdp: &str) -> Option<SocketAddr> {
    for line in sdp.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("a=candidate:") else {
            continue;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() < 6 {
            continue;
        }
        if fields[1] != "1" || !fields[2].eq_ignore_ascii_case("udp") {
            continue;
        }
        if let Ok(addr) = format!("{}:{}", fields[4], fields[5]).parse() {
            return Some(addr);
        }
    }
    None
}

fn close_name(reason: CloseReason) -> &'static str {
    match reason {
        CloseReason::Local => "local",
        CloseReason::Remote => "remote",
        CloseReason::Timeout => "timeout",
        CloseReason::Failure => "failure",
    }
}

fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let _ = env_logger::try_init();
    let args: Vec<String> = std::env::args().collect();
    let bind: SocketAddr = arg_value(&args, "--bind")
        .unwrap_or_else(|| "127.0.0.1:0".to_owned())
        .parse()?;
    let stream_id: u16 = arg_value(&args, "--stream-id")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let lifetime = Duration::from_millis(
        arg_value(&args, "--lifetime-ms")
            .and_then(|v| v.parse().ok())
            .unwrap_or(60_000),
    );

    let socket = UdpSocket::bind(bind)?;
    socket.set_nonblocking(true)?;
    let local_addr = socket.local_addr()?;

    // Read the peer's offer before building the answer.
    let mut offer_sdp = None;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        let Some(encoded) = line.strip_prefix("OFFER ") else {
            continue;
        };
        offer_sdp = Some(String::from_utf8(B64.decode(encoded.trim())?)?);
        break;
    }
    let offer_sdp = offer_sdp.ok_or("no OFFER line received")?;
    let peer = candidate_address(&offer_sdp).ok_or("offer carried no usable candidate")?;

    let mut config = TunnelConfig::new(peer, String::new(), String::new(), String::new());
    config.stream_id = stream_id;
    config.disable_fingerprint_verification = true;

    let mut tunnel = Tunnel::answerer(config, local_addr, &offer_sdp, 0)?;

    println!("PORT {}", local_addr.port());
    let answer = tunnel
        .answer_sdp()
        .ok_or("tunnel did not produce an answer")?;
    println!("ANSWER {}", B64.encode(answer.as_bytes()));
    std::io::stdout().flush()?;

    let start = Instant::now();
    let mut buf = vec![0u8; 2048];
    let mut echoes = 0u64;

    while start.elapsed() < lifetime {
        let now_ms = start.elapsed().as_millis() as u64;
        tunnel.tick(now_ms);

        let mut outgoing = Vec::new();
        let mut terminal = None;
        while let Some(event) = tunnel.poll_event() {
            match event {
                Event::SendDatagram(bytes) => outgoing.push(bytes),
                Event::Opened => {
                    println!("OPEN");
                    std::io::stdout().flush()?;
                }
                Event::Message(bytes) => {
                    if let SendResult::Accepted = tunnel.send(&bytes) {
                        echoes += 1;
                        println!("MSG {} {}", echoes, B64.encode(&bytes));
                        std::io::stdout().flush()?;
                    }
                }
                Event::Closed(reason) => terminal = Some(close_name(reason)),
            }
        }
        for bytes in outgoing {
            let _ = socket.send_to(&bytes, peer);
        }
        if let Some(name) = terminal {
            println!("CLOSED {name}");
            std::io::stdout().flush()?;
            break;
        }

        match socket.recv_from(&mut buf) {
            Ok((n, _)) => tunnel.receive(start.elapsed().as_millis() as u64, &buf[..n]),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e.into()),
        }

        std::thread::sleep(Duration::from_millis(1));
    }

    Ok(())
}
