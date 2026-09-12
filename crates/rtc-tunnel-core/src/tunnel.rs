use std::collections::VecDeque;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use rtc::data_channel::{RTCDataChannelId, RTCDataChannelInit, RTCDataChannelState, StreamId};
use rtc::peer_connection::configuration::media_engine::MediaEngine;
use rtc::peer_connection::configuration::setting_engine::SettingEngineBuilder;
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::event::{RTCDataChannelEvent, RTCPeerConnectionEvent};
use rtc::peer_connection::message::{RTCMessage, TaggedRTCMessage};
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::state::{RTCIceConnectionState, RTCPeerConnectionState};
use rtc::peer_connection::transport::{
    CandidateConfig, CandidateHostConfig, RTCDtlsRole, RTCDtlsTransportState, RTCIceCandidate,
    RTCIceTransportState, RTCSctpTransportState,
};
use rtc::peer_connection::{RTCPeerConnection, RTCPeerConnectionBuilder};
use rtc::sansio::Protocol;
use rtc::shared::{TaggedBytesMut, TransportContext, TransportProtocol};

use crate::config::TunnelConfig;
use crate::error::{Result, TunnelError};
use crate::event::{CloseReason, Event, SendResult};
use crate::trace::HandshakeTrace;

/// DTLS cipher suites in preference order.
///
/// On wasm32 `ring` falls back to software AES-GCM because the target has no
/// AES hardware, while ChaCha20-Poly1305 has no such penalty. AES-128-GCM stays
/// in the list because WebRTC requires it and peers without ChaCha must still
/// interoperate.
#[cfg(target_arch = "wasm32")]
const PREFERRED_CIPHER_SUITES: &[rtc::dtls::cipher_suite::CipherSuiteId] = &[
    rtc::dtls::cipher_suite::CipherSuiteId::Tls_Ecdhe_Ecdsa_With_ChaCha20_Poly1305_Sha256,
    rtc::dtls::cipher_suite::CipherSuiteId::Tls_Ecdhe_Ecdsa_With_Aes_128_Gcm_Sha256,
];

/// DTLS cipher suites in preference order. Native hosts have hardware AES, so
/// AES-GCM goes first and mirrors the reference stack.
#[cfg(not(target_arch = "wasm32"))]
const PREFERRED_CIPHER_SUITES: &[rtc::dtls::cipher_suite::CipherSuiteId] = &[
    rtc::dtls::cipher_suite::CipherSuiteId::Tls_Ecdhe_Ecdsa_With_Aes_128_Gcm_Sha256,
    rtc::dtls::cipher_suite::CipherSuiteId::Tls_Ecdhe_Ecdsa_With_ChaCha20_Poly1305_Sha256,
];

/// Default cap on bytes waiting in the data channel send buffer.
pub const DEFAULT_SEND_BUFFER_CAP: usize = 1024 * 1024;

/// A single pre-negotiated binary data channel to one known peer.
///
/// The tunnel owns no socket, spawns no task and reads no clock. The host feeds
/// it datagrams and time, and drains outgoing datagrams and events. Internally
/// it drives a sans-I/O WebRTC peer connection that is configured for exactly
/// one negotiated channel, so none of SDP negotiation, media or trickle ICE is
/// used.
pub struct Tunnel {
    pc: RTCPeerConnection,
    epoch: Instant,
    last_now: Instant,
    local_addr: SocketAddr,
    remote: SocketAddr,
    handle: RTCDataChannelId,
    handshake_deadline: Instant,
    send_buffer_cap: usize,
    opened: bool,
    finished: bool,
    dropped_datagrams: u64,
    events: VecDeque<Event>,
    trace: HandshakeTrace,
}

impl Tunnel {
    /// Builds the peer connection, opens the negotiated channel and queues the
    /// first ICE and DTLS datagrams for the host to send.
    ///
    /// `now_ms` is a monotonic millisecond counter. Only differences between
    /// successive values matter, and it must share the origin of every value
    /// later passed to [`receive`](Self::receive), [`tick`](Self::tick) and
    /// [`send`](Self::send).
    pub fn new(config: TunnelConfig, local_addr: SocketAddr, now_ms: u64) -> Result<Self> {
        if config.remote.ip().is_unspecified() {
            return Err(TunnelError::Config(
                "remote address must be concrete".into(),
            ));
        }
        if config.remote.is_ipv4() != local_addr.is_ipv4() {
            return Err(TunnelError::Config(
                "local and remote addresses must share an address family".into(),
            ));
        }
        if config.remote_fingerprint.trim().is_empty() {
            return Err(TunnelError::Config("remote fingerprint is required".into()));
        }
        if config.ice_ufrag.is_empty() || config.ice_pwd.is_empty() {
            return Err(TunnelError::Config(
                "remote ICE credentials are required".into(),
            ));
        }
        if config.stream_id > 65534 {
            return Err(TunnelError::Config("stream id must be 0..=65534".into()));
        }

        let mut tunnel = Self::offerer(config.clone(), local_addr, now_ms)?;
        let answer = RTCSessionDescription::answer(Self::remote_answer_sdp(&config))?;
        tunnel.apply_remote_answer(answer)?;
        Ok(tunnel)
    }

    /// Builds the offerer half of a session without a remote peer yet.
    ///
    /// The tunnel creates the pre-negotiated channel, advertises its local
    /// candidate and produces an offer, but applies no remote answer. Use
    /// [`offer_sdp`](Self::offer_sdp) to carry the offer to the peer, then
    /// [`apply_remote_answer`](Self::apply_remote_answer) with the peer's
    /// answer.
    ///
    /// This is the same setup [`new`](Self::new) performs; the relay path just
    /// synthesizes the answer instead of waiting for a real one.
    pub fn offerer(config: TunnelConfig, local_addr: SocketAddr, now_ms: u64) -> Result<Self> {
        if config.stream_id > 65534 {
            return Err(TunnelError::Config("stream id must be 0..=65534".into()));
        }

        let epoch = Instant::now()
            .checked_sub(Duration::from_millis(now_ms))
            .unwrap_or_else(Instant::now);
        let now = epoch + Duration::from_millis(now_ms);

        let setting_engine = SettingEngineBuilder::new()
            .with_disable_certificate_fingerprint_verification(
                config.disable_fingerprint_verification,
            )
            .with_dtls_cipher_suites(PREFERRED_CIPHER_SUITES.to_vec())
            .build();

        let mut pc = RTCPeerConnectionBuilder::new()
            .with_configuration(RTCConfigurationBuilder::new().build())
            .with_media_engine(MediaEngine::default())
            .with_setting_engine(setting_engine)
            .build(now)?;

        let init = RTCDataChannelInit {
            ordered: config.ordered,
            max_retransmits: config.max_retransmits,
            negotiated: Some(config.stream_id as StreamId),
            ..Default::default()
        };
        let handle = pc.create_data_channel("relay", Some(init))?.id();

        let local_candidate = CandidateHostConfig {
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
        pc.add_local_candidate(RTCIceCandidate::from(&local_candidate).to_json()?)?;

        let offer = pc.create_offer(None)?;
        pc.set_local_description(now, offer)?;

        let mut tunnel = Self {
            pc,
            epoch,
            last_now: now,
            local_addr,
            remote: config.remote,
            handle,
            handshake_deadline: now + Duration::from_millis(config.handshake_timeout_ms),
            send_buffer_cap: DEFAULT_SEND_BUFFER_CAP,
            opened: false,
            finished: false,
            dropped_datagrams: 0,
            events: VecDeque::new(),
            trace: HandshakeTrace::new(now_ms),
        };
        tunnel.drain();
        Ok(tunnel)
    }

    /// Applies the peer's SDP answer and starts the handshake.
    pub fn apply_remote_answer(&mut self, answer: RTCSessionDescription) -> Result<()> {
        self.pc.set_remote_description(self.last_now, answer)?;
        self.drain();
        Ok(())
    }

    /// Applies the peer's SDP answer from its SDP text.
    pub fn apply_remote_answer_sdp(&mut self, sdp: &str) -> Result<()> {
        let answer = RTCSessionDescription::answer(sdp.to_owned())?;
        self.apply_remote_answer(answer)
    }

    /// Builds the answerer half of a session from the peer's offer.
    ///
    /// The tunnel advertises `setup:passive`, so it is the DTLS server and,
    /// through that, the SCTP association responder. A peer that offers starts
    /// SCTP itself, so this is the arrangement that pairs with peers who drive
    /// the association from their side. The resulting SDP is available from
    /// [`answer_sdp`](Self::answer_sdp).
    pub fn answerer(
        config: TunnelConfig,
        local_addr: SocketAddr,
        remote_offer_sdp: &str,
        now_ms: u64,
    ) -> Result<Self> {
        if config.stream_id > 65534 {
            return Err(TunnelError::Config("stream id must be 0..=65534".into()));
        }

        let epoch = Instant::now()
            .checked_sub(Duration::from_millis(now_ms))
            .unwrap_or_else(Instant::now);
        let now = epoch + Duration::from_millis(now_ms);

        let setting_engine = SettingEngineBuilder::new()
            .with_disable_certificate_fingerprint_verification(
                config.disable_fingerprint_verification,
            )
            .with_answering_dtls_role(RTCDtlsRole::Server)
            .with_dtls_cipher_suites(PREFERRED_CIPHER_SUITES.to_vec())
            .build();

        let mut pc = RTCPeerConnectionBuilder::new()
            .with_configuration(RTCConfigurationBuilder::new().build())
            .with_media_engine(MediaEngine::default())
            .with_setting_engine(setting_engine)
            .build(now)?;

        let init = RTCDataChannelInit {
            ordered: config.ordered,
            max_retransmits: config.max_retransmits,
            negotiated: Some(config.stream_id as StreamId),
            ..Default::default()
        };
        let handle = pc.create_data_channel("relay", Some(init))?.id();

        let offer = RTCSessionDescription::offer(remote_offer_sdp.to_owned())?;
        pc.set_remote_description(now, offer)?;

        let local_candidate = CandidateHostConfig {
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
        pc.add_local_candidate(RTCIceCandidate::from(&local_candidate).to_json()?)?;

        let answer = pc.create_answer(None)?;
        pc.set_local_description(now, answer)?;

        let mut tunnel = Self {
            pc,
            epoch,
            last_now: now,
            local_addr,
            remote: config.remote,
            handle,
            handshake_deadline: now + Duration::from_millis(config.handshake_timeout_ms),
            send_buffer_cap: DEFAULT_SEND_BUFFER_CAP,
            opened: false,
            finished: false,
            dropped_datagrams: 0,
            events: VecDeque::new(),
            trace: HandshakeTrace::new(now_ms),
        };
        tunnel.drain();
        Ok(tunnel)
    }

    /// The SDP answer produced by [`answerer`](Self::answerer).
    pub fn answer_sdp(&self) -> Option<String> {
        self.pc.local_description().map(|d| d.sdp)
    }

    /// Updates the remote transport address.
    ///
    /// Only needed when the peer's address is learned from its answer, as in
    /// offer/answer with a real peer.
    pub fn set_remote(&mut self, remote: SocketAddr) {
        self.remote = remote;
    }

    /// Overrides the send buffer cap used for [`SendResult::Backpressure`].
    pub fn set_send_buffer_cap(&mut self, cap: usize) {
        self.send_buffer_cap = cap;
    }

    /// Feeds one datagram received from the configured remote address.
    pub fn receive(&mut self, now_ms: u64, datagram: &[u8]) {
        if self.finished {
            return;
        }
        let now = self.instant(now_ms);
        self.last_now = now;
        if self
            .pc
            .handle_read(TaggedBytesMut {
                now,
                transport: TransportContext {
                    local_addr: self.local_addr,
                    peer_addr: self.remote,
                    ecn: None,
                    transport_protocol: TransportProtocol::UDP,
                },
                message: BytesMut::from(datagram),
            })
            .is_err()
        {
            self.dropped_datagrams = self.dropped_datagrams.saturating_add(1);
        }
        self.drain();
    }

    /// Feeds one datagram without draining the peer connection.
    ///
    /// Call [`finish_input_batch`](Self::finish_input_batch) once after a run of
    /// these. Before the channel opens this drains each datagram itself, so the
    /// handshake is unaffected.
    pub fn receive_deferred(&mut self, now_ms: u64, datagram: &[u8]) {
        if self.finished {
            return;
        }
        let now = self.instant(now_ms);
        self.last_now = now;
        if !self.opened {
            self.receive(now_ms, datagram);
            return;
        }
        if self
            .pc
            .handle_read(TaggedBytesMut {
                now,
                transport: TransportContext {
                    local_addr: self.local_addr,
                    peer_addr: self.remote,
                    ecn: None,
                    transport_protocol: TransportProtocol::UDP,
                },
                message: BytesMut::from(datagram),
            })
            .is_err()
        {
            self.dropped_datagrams = self.dropped_datagrams.saturating_add(1);
        }
    }

    /// Drains once for every datagram fed since the last call.
    pub fn finish_input_batch(&mut self) {
        if self.finished || !self.opened {
            return;
        }
        self.drain();
    }

    /// Reports the passage of time so retransmissions and ICE checks run.
    pub fn tick(&mut self, now_ms: u64) {
        if self.finished {
            return;
        }
        let now = self.instant(now_ms);
        self.last_now = now;
        let _ = self.pc.handle_timeout(now);
        if !self.opened && now >= self.handshake_deadline {
            self.finish(CloseReason::Timeout);
            return;
        }
        self.drain();
    }

    /// Sends one application message on the channel.
    ///
    /// Time is taken from the most recent [`receive`](Self::receive) or
    /// [`tick`](Self::tick).
    pub fn send(&mut self, message: &[u8]) -> SendResult {
        if self.finished {
            return SendResult::NotOpen;
        }
        if !self.opened {
            self.maybe_open();
            if !self.opened {
                return SendResult::NotOpen;
            }
        }
        if message.len() > crate::MAX_MESSAGE_SIZE {
            return SendResult::TooLarge;
        }
        let Some(dc) = self.pc.data_channel(self.handle) else {
            return SendResult::NotOpen;
        };
        // Charge the message against the cap before accepting it, so a single
        // large message cannot overshoot the cap the check just verified.
        if dc.outstanding_bytes().saturating_add(message.len()) > self.send_buffer_cap {
            return SendResult::Backpressure;
        }
        let accepted = self
            .pc
            .data_channel(self.handle)
            .map(|mut dc| dc.send(self.last_now, BytesMut::from(message)).is_ok())
            .unwrap_or(false);
        self.drain();
        if accepted {
            SendResult::Accepted
        } else {
            SendResult::NotOpen
        }
    }

    /// Closes the tunnel locally.
    pub fn close(&mut self) {
        if self.finished {
            return;
        }
        let _ = self.pc.close();
        self.finish(CloseReason::Local);
    }

    /// Returns the next datagram or lifecycle event.
    pub fn poll_event(&mut self) -> Option<Event> {
        self.events.pop_front()
    }

    /// Next instant, in the same millisecond scale as the input, at which
    /// [`tick`](Self::tick) should be called.
    pub fn next_deadline(&mut self) -> Option<u64> {
        if self.finished {
            return None;
        }
        let mut best: Option<Instant> = if self.opened {
            None
        } else {
            Some(self.handshake_deadline)
        };
        if let Some(t) = self.pc.poll_timeout() {
            best = Some(best.map_or(t, |b| b.min(t)));
        }
        best.map(|t| self.ms_since_epoch(t))
    }

    /// Whether the data channel is open and usable.
    pub fn is_open(&self) -> bool {
        self.opened
    }

    /// The generated SDP offer, for hosts that need to carry it to the peer.
    ///
    /// The relay path does not need this: the peer is passive and its side of
    /// the session is synthesized from [`TunnelConfig`].
    pub fn offer_sdp(&self) -> Option<String> {
        self.pc.local_description().map(|d| d.sdp)
    }

    /// Whether the tunnel has stopped.
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// Datagrams the transport rejected as malformed.
    ///
    /// A non-zero, growing count on a live tunnel means something is feeding
    /// it bytes that are not this connection's, or corrupting them.
    pub fn dropped_datagrams(&self) -> u64 {
        self.dropped_datagrams
    }

    /// Bytes waiting in the data channel send buffer.
    ///
    /// This is the queue depth the host can watch under load. Zero before the
    /// channel opens and zero once everything has been acknowledged and sent.
    pub fn buffered_bytes(&mut self) -> usize {
        self.pc
            .data_channel(self.handle)
            .map(|dc| dc.outstanding_bytes())
            .unwrap_or(0)
    }

    fn instant(&self, now_ms: u64) -> Instant {
        self.epoch + Duration::from_millis(now_ms)
    }

    fn ms_since_epoch(&self, t: Instant) -> u64 {
        t.saturating_duration_since(self.epoch).as_millis() as u64
    }

    fn refresh_opened(&mut self) {
        let open = self
            .pc
            .data_channel(self.handle)
            .map(|dc| dc.ready_state() == RTCDataChannelState::Open)
            .unwrap_or(false);
        if open {
            self.opened = true;
        }
    }

    /// Emits `Opened` once the data channel is usable.
    ///
    /// For a negotiated channel the local ready state flips to `Open` at
    /// `SCTPHandshakeComplete`, before the peer-connection layer surfaces its
    /// `OnOpen` event, so this checks the ready state directly.
    fn maybe_open(&mut self) {
        if self.opened {
            return;
        }
        self.refresh_opened();
        if self.opened {
            self.events.push_back(Event::Opened);
        }
    }

    fn finish(&mut self, reason: CloseReason) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.events.push_back(Event::Closed(reason));
    }

    fn drain(&mut self) {
        self.drain_writes();
        while let Some(ev) = self.pc.poll_event() {
            if self.finished {
                break;
            }
            match ev {
                RTCPeerConnectionEvent::OnDataChannel(RTCDataChannelEvent::OnOpen(_)) => {
                    if !self.opened {
                        self.opened = true;
                        self.events.push_back(Event::Opened);
                    }
                }
                RTCPeerConnectionEvent::OnDataChannel(RTCDataChannelEvent::OnClose(_)) => {
                    self.finish(CloseReason::Remote);
                }
                RTCPeerConnectionEvent::OnDataChannel(_) => {}
                RTCPeerConnectionEvent::OnConnectionStateChangeEvent(state) => match state {
                    RTCPeerConnectionState::Connected => self.maybe_open(),
                    RTCPeerConnectionState::Failed => self.finish(CloseReason::Failure),
                    RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Closed => {
                        self.finish(CloseReason::Remote)
                    }
                    _ => {}
                },
                RTCPeerConnectionEvent::OnIceConnectionStateChangeEvent(
                    RTCIceConnectionState::Failed,
                ) => self.finish(CloseReason::Failure),
                _ => {}
            }
        }
        // A handler event can enqueue output; the DTLS handshake does exactly
        // that when the event selecting the ICE pair starts DTLS.
        self.drain_writes();
        while let Some(TaggedRTCMessage { message, .. }) = self.pc.poll_read() {
            if self.finished {
                break;
            }
            if let RTCMessage::DataChannelMessage(_, msg) = message {
                self.events.push_back(Event::Message(Bytes::from(msg.data)));
            }
        }
        self.maybe_open();
        self.sample_handshake();
    }

    fn drain_writes(&mut self) {
        while let Some(msg) = self.pc.poll_write() {
            self.events
                .push_back(Event::SendDatagram(Bytes::from(msg.message)));
        }
    }

    /// First-observation times for the ICE, DTLS, SCTP and open phases.
    ///
    /// Values are on the same clock as the `now_ms` passed to the constructor.
    /// A phase that has not happened is `None`. Sampling stops once the channel
    /// opens, so this adds no cost on the data path.
    pub fn handshake_trace(&self) -> HandshakeTrace {
        self.trace
    }

    /// The DTLS cipher suite negotiated with the peer, or `None` until the
    /// handshake selects one.
    ///
    /// The suite's IANA name, such as
    /// `TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256`. The peer connection
    /// records this in its transport statistics during the handshake.
    pub fn negotiated_cipher_suite(&mut self) -> Option<String> {
        let now = self.last_now;
        let report = self.pc.get_stats(now, rtc::statistics::StatsSelector::None);
        report
            .transport()
            .map(|transport| transport.dtls_cipher.clone())
            .filter(|cipher| !cipher.is_empty())
    }

    fn sample_handshake(&mut self) {
        if self.trace.is_complete() {
            return;
        }
        let now_ms = self.ms_since_epoch(self.last_now);
        let (ice, dtls, sctp) = match self.pc.sctp() {
            Some(sctp) => {
                let ice = matches!(
                    sctp.transport().ice_transport().state(),
                    RTCIceTransportState::Connected | RTCIceTransportState::Completed
                );
                let dtls = matches!(sctp.transport().state(), RTCDtlsTransportState::Connected);
                let sctp = matches!(sctp.state(), RTCSctpTransportState::Connected);
                (ice, dtls, sctp)
            }
            None => (false, false, false),
        };
        self.trace.observe(now_ms, ice, dtls, sctp, self.opened);
    }

    fn remote_answer_sdp(config: &TunnelConfig) -> String {
        let (family, unspecified) = if config.remote.is_ipv4() {
            ("IP4", "0.0.0.0")
        } else {
            ("IP6", "::")
        };
        format!(
            "v=0\r\n\
             o=- 0 0 IN {family} {unspecified}\r\n\
             s=-\r\n\
             t=0 0\r\n\
             a=group:BUNDLE 0\r\n\
             a=msid-semantic: WMS\r\n\
             m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n\
             c=IN {family} {unspecified}\r\n\
             a=mid:0\r\n\
             a=sctp-port:{sctp_port}\r\n\
             a=max-message-size:262144\r\n\
             a=ice-ufrag:{ufrag}\r\n\
             a=ice-pwd:{pwd}\r\n\
             a=setup:passive\r\n\
             a=fingerprint:{algo} {fingerprint}\r\n\
             a=candidate:1 1 udp 2130706431 {ip} {port} typ host\r\n\
             a=end-of-candidates\r\n",
            sctp_port = config.sctp_port,
            ufrag = config.ice_ufrag,
            pwd = config.ice_pwd,
            algo = config.fingerprint_algorithm,
            fingerprint = config.remote_fingerprint,
            ip = config.remote.ip(),
            port = config.remote.port(),
        )
    }
}
