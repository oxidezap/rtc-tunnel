//! Direct composition of `rtc-ice`, `rtc-dtls` and `rtc-sctp`, without the
//! umbrella `rtc::RTCPeerConnection`.
//!
//! This drives the protocol stack for the one path the tunnel uses: a known
//! peer, one negotiated unordered stream with zero retransmits, binary payloads.
//! Media, RTP, SRTP, trickle ICE, mDNS, full SDP parsing and renegotiation are
//! absent by construction.
//!
//! ```text
//! read:  UDP bytes -> ICE -> DTLS record -> SCTP chunk -> payload
//! write: payload -> SCTP chunk -> DTLS record -> ICE -> UDP bytes
//! ```
//!
//! The offerer drives ICE as controlling and DTLS as client. The answerer drives
//! ICE as controlled and DTLS as server. DTLS starts once ICE selects a pair;
//! SCTP starts once DTLS completes; the negotiated channel is opened locally
//! once SCTP connects.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use rtc_crypto::RTCCryptoProvider;
use rtc_dtls::config::{ClientAuthType, ConfigBuilder, ExtendedMasterSecretType, HandshakeConfig};
use rtc_dtls::endpoint::{Endpoint as DtlsEndpoint, EndpointEvent};
use rtc_dtls::extension::extension_use_srtp::SrtpProtectionProfile;
use rtc_ice::agent::agent_config::AgentConfig;
use rtc_ice::agent::{Agent, Event as IceEvent};
use rtc_ice::candidate::candidate_host::CandidateHostConfig;
use rtc_ice::candidate::{CandidateConfig as IceCandidateConfig, CandidateType};
use rtc_ice::network_type::NetworkType;
use rtc_ice::state::ConnectionState as IceState;
use rtc_sctp::{
    Association, AssociationHandle, ClientConfig, DatagramEvent, Endpoint as SctpEndpoint,
    EndpointConfig as SctpEndpointConfig, Event as SctpEvent, Payload, PayloadProtocolIdentifier,
    ReliabilityType, ServerConfig as SctpServerConfig, StreamEvent,
    TransportConfig as SctpTransportConfig,
};
use rtc_shared::{TransportContext, TransportMessage, TransportProtocol};
use sansio::Protocol as _;

use crate::config::TunnelConfig;
use crate::error::{Result, TunnelError};
use crate::event::{CloseReason, Event, SendResult};
use crate::trace::HandshakeTrace;

const DTLS_FIRST_BYTE_MIN: u8 = 20;
const DTLS_FIRST_BYTE_MAX: u8 = 63;

/// DTLS cipher suites in preference order.
///
/// On wasm32 `ring` falls back to software AES-GCM because the target has no
/// AES hardware, while ChaCha20-Poly1305 has no such penalty. AES-128-GCM stays
/// in the list because WebRTC requires it and peers without ChaCha must still
/// interoperate.
#[cfg(target_arch = "wasm32")]
const PREFERRED_CIPHER_SUITES: &[rtc_dtls::cipher_suite::CipherSuiteId] = &[
    rtc_dtls::cipher_suite::CipherSuiteId::Tls_Ecdhe_Ecdsa_With_ChaCha20_Poly1305_Sha256,
    rtc_dtls::cipher_suite::CipherSuiteId::Tls_Ecdhe_Ecdsa_With_Aes_128_Gcm_Sha256,
];

/// DTLS cipher suites in preference order. Native hosts have hardware AES, so
/// AES-GCM goes first and mirrors the reference stack.
#[cfg(not(target_arch = "wasm32"))]
const PREFERRED_CIPHER_SUITES: &[rtc_dtls::cipher_suite::CipherSuiteId] = &[
    rtc_dtls::cipher_suite::CipherSuiteId::Tls_Ecdhe_Ecdsa_With_Aes_128_Gcm_Sha256,
    rtc_dtls::cipher_suite::CipherSuiteId::Tls_Ecdhe_Ecdsa_With_ChaCha20_Poly1305_Sha256,
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Offerer,
    Answerer,
}

fn is_stun(datagram: &[u8]) -> bool {
    matches!(datagram.first(), Some(&b) if b <= 3)
}

fn is_dtls(datagram: &[u8]) -> bool {
    matches!(datagram.first(), Some(&b) if (DTLS_FIRST_BYTE_MIN..=DTLS_FIRST_BYTE_MAX).contains(&b))
}

fn network_type_of(addr: SocketAddr) -> NetworkType {
    if addr.is_ipv4() {
        NetworkType::Udp4
    } else {
        NetworkType::Udp6
    }
}

/// One negotiated data channel over directly driven ICE, DTLS and SCTP.
pub struct DirectTunnel {
    role: Role,
    ice: Agent,
    dtls: DtlsEndpoint,
    dtls_config: Option<Arc<HandshakeConfig>>,
    local_fingerprint: String,

    sctp: Option<SctpEndpoint>,
    sctp_config: Option<SctpTransportConfig>,
    association: Option<Association>,
    association_handle: Option<AssociationHandle>,

    local_addr: SocketAddr,
    remote_addr: SocketAddr,
    sctp_port: u16,
    stream_id: u16,
    ordered: bool,
    max_retransmits: u16,

    remote_fingerprint: String,
    fingerprint_algorithm: String,
    disable_fingerprint_verification: bool,
    crypto: Arc<dyn RTCCryptoProvider>,

    dtls_started: bool,
    dtls_connected: bool,
    sctp_connected: bool,
    channel_dialed: bool,
    opened: bool,
    finished: bool,
    dropped_datagrams: u64,

    epoch: Instant,
    last_now: Instant,
    handshake_deadline: Instant,
    send_buffer_cap: usize,

    events: VecDeque<Event>,
    trace: HandshakeTrace,
}

impl DirectTunnel {
    /// Builds the offerer half. The remote parameters come from `config`, so no
    /// answer has to be parsed.
    pub fn offerer(config: TunnelConfig, local_addr: SocketAddr, now_ms: u64) -> Result<Self> {
        let mut tunnel = Self::build(Role::Offerer, config, local_addr, now_ms)?;
        tunnel.start_checks()?;
        Ok(tunnel)
    }

    /// Builds the offerer for the relay path.
    ///
    /// The peer is passive, so its answer is synthesized from `config` rather
    /// than parsed. [`apply_remote_answer_sdp`](Self::apply_remote_answer_sdp)
    /// is accepted for API parity and only refreshes the remote fingerprint.
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
        Self::offerer(config, local_addr, now_ms)
    }

    /// Builds the answerer half from the peer's offer.
    ///
    /// The tunnel becomes the DTLS server and the SCTP responder, matching the
    /// `rtc`-backed answerer. Only the fields a known peer needs are read from
    /// the offer: ICE credentials, candidate and fingerprint.
    pub fn answerer(
        config: TunnelConfig,
        local_addr: SocketAddr,
        remote_offer_sdp: &str,
        now_ms: u64,
    ) -> Result<Self> {
        if config.stream_id > 65534 {
            return Err(TunnelError::Config("stream id must be 0..=65534".into()));
        }
        let offer = ParsedOffer::parse(remote_offer_sdp)?;
        if offer.remote.is_ipv4() != local_addr.is_ipv4() {
            return Err(TunnelError::Config(
                "local and remote addresses must share an address family".into(),
            ));
        }

        let mut config = config;
        config.ice_ufrag = offer.ufrag;
        config.ice_pwd = offer.pwd;
        config.remote = offer.remote;
        if !offer.fingerprint.is_empty() {
            config.remote_fingerprint = offer.fingerprint;
        }

        let mut tunnel = Self::build(Role::Answerer, config, local_addr, now_ms)?;
        tunnel.start_checks()?;
        Ok(tunnel)
    }

    fn build(
        role: Role,
        config: TunnelConfig,
        local_addr: SocketAddr,
        now_ms: u64,
    ) -> Result<Self> {
        let crypto = rtc_crypto::default_provider()
            .map_err(|e| TunnelError::Config(format!("crypto provider: {e}")))?;

        // `now_ms` is a host counter; only differences matter. Anchor an epoch so
        // every later `receive`/`tick` maps back to the construction instant. If
        // the deadline were anchored to `epoch` instead, the handshake budget
        // would become `timeout - now_ms` and shrink to zero once the host
        // counter passed the timeout.
        let epoch = Instant::now()
            .checked_sub(Duration::from_millis(now_ms))
            .unwrap_or_else(Instant::now);
        let now = epoch + Duration::from_millis(now_ms);

        let agent_config = AgentConfig {
            local_ufrag: rtc_ice::rand::generate_ufrag(),
            local_pwd: rtc_ice::rand::generate_pwd(),
            candidate_types: vec![CandidateType::Host],
            network_types: vec![network_type_of(local_addr)],
            is_controlling: role == Role::Offerer,
            ..Default::default()
        };
        let ice = Agent::new(now, Arc::new(agent_config), crypto.clone())
            .map_err(|e| TunnelError::Config(format!("ice agent: {e}")))?;

        let mut tunnel = Self {
            role,
            ice,
            dtls: DtlsEndpoint::new(
                TransportContext::default().local_addr,
                TransportProtocol::UDP,
                None,
            ),
            dtls_config: None,
            local_fingerprint: String::new(),
            sctp: None,
            sctp_config: None,
            association: None,
            association_handle: None,
            local_addr,
            remote_addr: config.remote,
            sctp_port: config.sctp_port,
            stream_id: config.stream_id,
            ordered: config.ordered,
            max_retransmits: config.max_retransmits.unwrap_or(0),
            remote_fingerprint: config.remote_fingerprint.clone(),
            fingerprint_algorithm: config.fingerprint_algorithm.clone(),
            disable_fingerprint_verification: config.disable_fingerprint_verification,
            crypto,
            dtls_started: false,
            dtls_connected: false,
            sctp_connected: false,
            channel_dialed: false,
            opened: false,
            finished: false,
            dropped_datagrams: 0,
            epoch,
            last_now: now,
            handshake_deadline: now + Duration::from_millis(config.handshake_timeout_ms),
            send_buffer_cap: crate::DEFAULT_SEND_BUFFER_CAP,
            events: VecDeque::new(),
            trace: HandshakeTrace::new(now_ms),
        };
        tunnel.prepare_dtls()?;
        tunnel.add_candidates(&config)?;
        tunnel
            .ice
            .set_remote_credentials(config.ice_ufrag.clone(), config.ice_pwd.clone())
            .map_err(|e| TunnelError::Config(format!("remote credentials: {e}")))?;
        Ok(tunnel)
    }

    fn start_checks(&mut self) -> Result<()> {
        self.ice
            .start_connectivity_checks(
                self.last_now,
                self.role == Role::Offerer,
                self.remote_credentials_ufrag(),
                self.remote_credentials_pwd(),
            )
            .map_err(|e| TunnelError::Config(format!("start checks: {e}")))?;
        Ok(())
    }

    fn remote_credentials_ufrag(&self) -> String {
        self.ice
            .get_remote_credentials()
            .map(|c| c.ufrag.clone())
            .unwrap_or_default()
    }

    fn remote_credentials_pwd(&self) -> String {
        self.ice
            .get_remote_credentials()
            .map(|c| c.pwd.clone())
            .unwrap_or_default()
    }

    fn add_candidates(&mut self, config: &TunnelConfig) -> Result<()> {
        let host = |addr: SocketAddr| -> Result<rtc_ice::candidate::Candidate> {
            CandidateHostConfig {
                base_config: IceCandidateConfig {
                    network: "udp".to_owned(),
                    address: addr.ip().to_string(),
                    port: addr.port(),
                    component: 1,
                    ..Default::default()
                },
                ..Default::default()
            }
            .new_candidate_host()
            .map_err(|e| TunnelError::Config(format!("candidate: {e}")))
        };
        let local = host(self.local_addr)?;
        self.ice
            .add_local_candidate(local)
            .map_err(|e| TunnelError::Config(format!("local candidate: {e}")))?;
        let remote = host(config.remote)?;
        self.ice
            .add_remote_candidate(remote)
            .map_err(|e| TunnelError::Config(format!("remote candidate: {e}")))?;
        Ok(())
    }
    fn prepare_dtls(&mut self) -> Result<()> {
        let certificate = rtc_dtls::crypto::Certificate::generate_self_signed_with_alg(
            vec!["webrtc.rs".to_owned()],
            &rcgen::PKCS_ECDSA_P256_SHA256,
            self.crypto.crypto(),
        )
        .map_err(|e| TunnelError::Config(format!("certificate: {e}")))?;
        self.local_fingerprint = fingerprint_of(&certificate, self.crypto.crypto())?;

        let verify: Option<rtc_dtls::config::VerifyPeerCertificateFn> =
            if self.disable_fingerprint_verification {
                None
            } else {
                let expected = self.remote_fingerprint.to_lowercase();
                let algorithm = self.fingerprint_algorithm.clone();
                let crypto = self.crypto.clone();
                Some(Arc::new(move |certs: &[Vec<u8>], _chains| {
                    if certs.is_empty() {
                        return Err(rtc_shared::error::Error::ErrNonCertificate);
                    }
                    if algorithm != "sha-256" {
                        return Err(rtc_shared::error::Error::ErrUnsupportedFingerprintAlgorithm);
                    }
                    let hash = crypto
                        .crypto()
                        .hash(rtc_crypto::HashAlgorithm::Sha256, &certs[0])
                        .map_err(|e| rtc_shared::error::Error::Crypto(e.to_string()))?;
                    let value = hash
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<Vec<_>>()
                        .join(":");
                    if value == expected {
                        Ok(())
                    } else {
                        Err(rtc_shared::error::Error::ErrNoMatchingCertificateFingerprint)
                    }
                }))
            };

        let is_client = self.role == Role::Offerer;
        // The tunnel carries no media, but WebRTC DTLS peers still negotiate the
        // `use_srtp` extension. Offering the same profile list the umbrella path
        // offers keeps the ClientHello acceptable to a browser-style peer such
        // as Pion. No SRTP context is exported or used.
        let config = ConfigBuilder::default()
            .with_crypto_provider(self.crypto.clone())
            .with_certificates(vec![certificate])
            .with_srtp_protection_profiles(vec![
                SrtpProtectionProfile::Srtp_Aead_Aes_128_Gcm,
                SrtpProtectionProfile::Srtp_Aead_Aes_256_Gcm,
                SrtpProtectionProfile::Srtp_Aes128_Cm_Hmac_Sha1_80,
                SrtpProtectionProfile::Srtp_Aes128_Cm_Hmac_Sha1_32,
            ])
            .with_client_auth(ClientAuthType::RequireAnyClientCert)
            .with_insecure_skip_verify(true)
            .with_verify_peer_certificate(verify)
            .with_cipher_suites(PREFERRED_CIPHER_SUITES.to_vec())
            .with_extended_master_secret(ExtendedMasterSecretType::Require)
            .build(is_client, Some(self.remote_addr))
            .map_err(|e| TunnelError::Config(format!("dtls config: {e}")))?;
        let config = Arc::new(config);
        self.dtls_config = Some(config.clone());
        if !is_client {
            // The server endpoint answers inbound ClientHellos with this config.
            self.dtls.set_server_config(Some(config));
        }
        Ok(())
    }

    /// Marks the DTLS phase active. The offerer starts the client handshake;
    /// the answerer becomes active as soon as ICE selects a pair, because its
    /// server endpoint answers the peer's ClientHello.
    fn activate_dtls(&mut self) -> bool {
        if self.role != Role::Offerer {
            return true;
        }
        let Some(config) = self.dtls_config.clone() else {
            return false;
        };
        self.dtls
            .connect(self.last_now, self.remote_addr, config, None)
            .is_ok()
    }

    fn start_sctp(&mut self) -> Result<()> {
        let endpoint_config = SctpEndpointConfig::default();
        let transport_config = SctpTransportConfig::default()
            .with_max_message_size(crate::MAX_MESSAGE_SIZE as u32)
            .with_sctp_port(self.sctp_port);
        let is_client = self.role == Role::Offerer;
        let server_config =
            (!is_client).then(|| Arc::new(SctpServerConfig::new(transport_config.clone())));
        let endpoint = SctpEndpoint::new(
            TransportContext::default().local_addr,
            TransportProtocol::UDP,
            endpoint_config.into(),
            server_config,
        );
        self.sctp = Some(endpoint);
        if is_client {
            let (handle, association) = self
                .sctp
                .as_mut()
                .unwrap()
                .connect(
                    self.last_now,
                    ClientConfig::new(transport_config),
                    self.remote_addr,
                )
                .map_err(|e| TunnelError::Config(format!("sctp connect: {e}")))?;
            self.association = Some(association);
            self.association_handle = Some(handle);
        } else {
            self.sctp_config = Some(transport_config);
        }
        Ok(())
    }

    fn pump(&mut self) -> Result<()> {
        self.drain_ice_events();
        self.drain_ice_writes();

        if self.ice.get_selected_candidate_pair().is_some() && !self.dtls_started {
            self.dtls_started = self.activate_dtls();
        }
        if self.dtls_started {
            self.drain_sctp()?;
            self.drain_channel()?;
            self.drain_sctp_transmits()?;
            self.drain_dtls_transmits();
        }
        self.maybe_open();
        Ok(())
    }

    fn drain_ice_events(&mut self) {
        while let Some(event) = self.ice.poll_event() {
            if let IceEvent::ConnectionStateChange(state) = event.event {
                let instant = event.now;
                if matches!(state, IceState::Connected | IceState::Completed) {
                    self.trace.observe_ice(self.ms(instant));
                }
            }
        }
    }

    fn drain_ice_writes(&mut self) {
        while let Some(transmit) = self.ice.poll_write() {
            self.events
                .push_back(Event::SendDatagram(Bytes::from(transmit.message)));
        }
    }

    fn drain_dtls_transmits(&mut self) {
        while let Some(transmit) = self.dtls.poll_transmit() {
            self.events
                .push_back(Event::SendDatagram(Bytes::from(transmit.message)));
        }
    }

    fn feed_dtls(&mut self, now: Instant, datagram: &[u8]) -> Result<()> {
        let events = self
            .dtls
            .read(now, self.remote_addr, None, BytesMut::from(datagram))
            .map_err(|e| TunnelError::Config(format!("dtls read: {e}")))?;
        for event in events {
            match event {
                EndpointEvent::HandshakeComplete => {
                    self.dtls_connected = true;
                    self.trace.observe_dtls(self.ms(now));
                    if self.sctp.is_none() {
                        self.start_sctp()?;
                    }
                }
                EndpointEvent::ApplicationData(data) => {
                    self.feed_sctp(now, data)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn feed_sctp(&mut self, now: Instant, datagram: BytesMut) -> Result<()> {
        let Some(endpoint) = self.sctp.as_mut() else {
            return Ok(());
        };
        if let Some((handle, event)) =
            endpoint.handle(now, self.remote_addr, None, datagram.freeze())
        {
            match event {
                DatagramEvent::NewAssociation(association) => {
                    self.association = Some(association);
                    self.association_handle = Some(handle);
                }
                DatagramEvent::AssociationEvent(event) => {
                    if let Some(association) = self.association.as_mut() {
                        association.handle_event(event);
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn drain_sctp(&mut self) -> Result<()> {
        let now = self.last_now;
        let stream_id = self.stream_id;
        // One negotiated stream, so a readable event for any other id is ignored
        // and a flag beats collecting ids into a per-drain `Vec`.
        let mut readable = false;
        let mut connected = false;
        let mut lost = false;
        if let Some(association) = self.association.as_mut() {
            while let Some(event) = association.poll() {
                match event {
                    SctpEvent::Connected => connected = true,
                    SctpEvent::Stream(StreamEvent::Readable { id }) if id == stream_id => {
                        readable = true;
                    }
                    SctpEvent::Stream(StreamEvent::Readable { .. }) => {}
                    SctpEvent::AssociationLost { .. } => lost = true,
                    _ => {}
                }
            }
            while let Some(event) = association.poll_endpoint_event() {
                if let Some(endpoint) = self.sctp.as_mut() {
                    if let Some(handle) = self.association_handle {
                        endpoint.handle_event(handle, event);
                    }
                }
            }
        }
        if connected {
            self.sctp_connected = true;
            self.trace.observe_sctp(self.ms(now));
        }
        if lost {
            self.finish(CloseReason::Remote);
        }
        if readable {
            self.read_stream()?;
        }
        Ok(())
    }

    fn read_stream(&mut self) -> Result<()> {
        let stream_id = self.stream_id;
        let Some(association) = self.association.as_mut() else {
            return Ok(());
        };
        let Ok(mut stream) = association.stream(stream_id) else {
            return Ok(());
        };
        // `events` is disjoint from `association`, so messages push straight to
        // their destination.
        let events = &mut self.events;
        while let Some(chunks) = stream
            .read_sctp()
            .map_err(|e| TunnelError::Config(format!("sctp read: {e}")))?
        {
            match chunks.ppi {
                // An empty user message cannot travel as a zero-length SCTP
                // payload, so it arrives as one zero byte with a dedicated PPID
                // and must be handed up empty.
                PayloadProtocolIdentifier::BinaryEmpty | PayloadProtocolIdentifier::StringEmpty => {
                    events.push_back(Event::Message(Bytes::new()));
                }
                PayloadProtocolIdentifier::Binary | PayloadProtocolIdentifier::String => {
                    let payload = chunks
                        .to_payload(crate::MAX_MESSAGE_SIZE)
                        .map_err(|e| TunnelError::Config(format!("reassemble: {e}")))?;
                    events.push_back(Event::Message(Bytes::from(payload)));
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Opens the negotiated SCTP stream once the association is connected.
    ///
    /// A negotiated channel skips the DCEP handshake with the peer, so this only
    /// opens `stream_id` with the configured reliability and carries binary PPID
    /// messages.
    fn open_stream(&mut self) -> Result<()> {
        self.channel_dialed = true;
        let unordered = !self.ordered;
        let (reliability_type, reliability_value) = if self.max_retransmits == u16::MAX {
            (ReliabilityType::Reliable, 0)
        } else {
            (ReliabilityType::Rexmit, self.max_retransmits as u32)
        };
        let association = self
            .association
            .as_mut()
            .ok_or_else(|| TunnelError::Config("sctp association is not established".into()))?;
        let mut stream = association
            .open_stream(self.stream_id, PayloadProtocolIdentifier::Binary)
            .map_err(|e| TunnelError::Config(format!("open stream: {e}")))?;
        stream
            .set_reliability_params(unordered, reliability_type, reliability_value)
            .map_err(|e| TunnelError::Config(format!("reliability: {e}")))?;
        Ok(())
    }

    fn drain_channel(&mut self) -> Result<()> {
        if self.sctp_connected && !self.channel_dialed {
            self.open_stream()?;
        }
        Ok(())
    }

    fn drain_sctp_transmits(&mut self) -> Result<()> {
        let now = self.last_now;
        let remote = self.remote_addr;
        let dtls_started = self.dtls_started;
        // `association` and `dtls` are disjoint fields, so the transmit is
        // written straight into DTLS without a staging `Vec` per drain.
        let Some(association) = self.association.as_mut() else {
            return Ok(());
        };
        while let Some(transmit) = association.poll_transmit(now) {
            if let Payload::RawEncode(raws) = transmit.message {
                if dtls_started {
                    for raw in raws {
                        self.dtls
                            .write(now, remote, &raw)
                            .map_err(|e| TunnelError::Config(format!("dtls write: {e}")))?;
                    }
                }
            }
        }
        Ok(())
    }

    fn maybe_open(&mut self) {
        if self.opened {
            return;
        }
        // A negotiated channel is usable as soon as its stream is open on a
        // connected association; there is no DCEP handshake to wait for.
        if self.sctp_connected && self.channel_dialed {
            self.opened = true;
            self.trace.observe_open(self.ms(self.last_now));
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

    fn ms(&self, instant: Instant) -> u64 {
        instant.saturating_duration_since(self.epoch).as_millis() as u64
    }

    /// The last SDP offer generated for this half, for callers that carry it to
    /// the peer. For the relay path no answer is required.
    pub fn offer_sdp(&self) -> Option<String> {
        Some(self.render_sdp("actpass"))
    }

    /// The SDP answer, when this half is the answerer.
    pub fn answer_sdp(&self) -> Option<String> {
        if self.role == Role::Answerer {
            Some(self.render_sdp("passive"))
        } else {
            None
        }
    }

    fn render_sdp(&self, setup: &str) -> String {
        let creds = self.ice.get_local_credentials();
        let candidate = self
            .ice
            .get_local_candidates()
            .first()
            .map(|c| c.marshal())
            .unwrap_or_default();
        let (family, unspecified) = if self.local_addr.is_ipv4() {
            ("IP4", "0.0.0.0")
        } else {
            ("IP6", "::")
        };
        format!(
            "v=0\r\n\
             o=- 0 0 IN {family} {unspecified}\r\n\
             s=-\r\n\
             t=0 0\r\n\
             a=fingerprint:{algo} {fingerprint}\r\n\
             a=group:BUNDLE 0\r\n\
             m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n\
             c=IN {family} {unspecified}\r\n\
             a=setup:{setup}\r\n\
             a=mid:0\r\n\
             a=sctp-port:{sctp_port}\r\n\
             a=max-message-size:{max_message_size}\r\n\
             a=ice-ufrag:{ufrag}\r\n\
             a=ice-pwd:{pwd}\r\n\
             a=candidate:{candidate}\r\n",
            algo = self.fingerprint_algorithm,
            fingerprint = self.local_fingerprint,
            sctp_port = self.sctp_port,
            max_message_size = crate::MAX_MESSAGE_SIZE,
            ufrag = creds.ufrag,
            pwd = creds.pwd,
        )
    }

    /// Accepts the peer's answer for API parity. The remote parameters were
    /// supplied at construction, so only a changed fingerprint is applied.
    pub fn apply_remote_answer_sdp(&mut self, sdp: &str) -> Result<()> {
        if let Some(fingerprint) = parse_answer_fingerprint(sdp) {
            self.remote_fingerprint = fingerprint;
        }
        Ok(())
    }

    /// Updates the remote transport address, as when it is learned from an answer.
    pub fn set_remote(&mut self, remote: SocketAddr) {
        self.remote_addr = remote;
    }

    /// Overrides the send buffer cap.
    pub fn set_send_buffer_cap(&mut self, cap: usize) {
        self.send_buffer_cap = cap;
    }

    /// Feeds one datagram received from the configured remote address.
    pub fn receive(&mut self, now_ms: u64, datagram: &[u8]) {
        if self.finished {
            return;
        }
        let now = self.epoch + Duration::from_millis(now_ms);
        self.last_now = now;
        self.ingest(now, datagram);
        let _ = self.pump();
    }

    /// Feeds one datagram without running the protocol pump.
    ///
    /// A host that received several datagrams together can call this for each
    /// and then call [`finish_input_batch`](Self::finish_input_batch) once, so
    /// ICE, DTLS and SCTP advance once per batch. Before the channel opens this
    /// pumps each datagram itself: the handshake depends on each flight being
    /// driven immediately.
    pub fn receive_deferred(&mut self, now_ms: u64, datagram: &[u8]) {
        if self.finished {
            return;
        }
        let now = self.epoch + Duration::from_millis(now_ms);
        self.last_now = now;
        self.ingest(now, datagram);
        if !self.opened {
            let _ = self.pump();
        }
    }

    /// Runs one protocol pump for all datagrams fed since the last call.
    ///
    /// Pair with [`receive_deferred`](Self::receive_deferred). Does nothing
    /// before the channel opens, since that path pumps each datagram itself.
    pub fn finish_input_batch(&mut self) {
        if self.finished || !self.opened {
            return;
        }
        let _ = self.pump();
    }

    /// Classifies and dispatches one datagram. No pump; the caller decides when.
    fn ingest(&mut self, now: Instant, datagram: &[u8]) {
        let result = if is_stun(datagram) {
            let transport = TransportContext {
                local_addr: self.local_addr,
                peer_addr: self.remote_addr,
                ecn: None,
                transport_protocol: TransportProtocol::UDP,
            };
            self.ice
                .handle_read(TransportMessage {
                    now,
                    transport,
                    message: BytesMut::from(datagram),
                })
                .map_err(|_| ())
        } else if is_dtls(datagram) {
            if self.ice.get_selected_candidate_pair().is_none() {
                // A DTLS record before ICE nominated the pair cannot be assigned.
                Ok(())
            } else {
                if !self.dtls_started {
                    self.dtls_started = self.activate_dtls();
                }
                self.feed_dtls(now, datagram).map_err(|_| ())
            }
        } else {
            Ok(())
        };
        if result.is_err() {
            self.dropped_datagrams = self.dropped_datagrams.saturating_add(1);
        }
    }

    /// Reports the passage of time so retransmissions and checks run.
    pub fn tick(&mut self, now_ms: u64) {
        if self.finished {
            return;
        }
        let now = self.epoch + Duration::from_millis(now_ms);
        self.last_now = now;
        let _ = self.ice.handle_timeout(now);
        if self.dtls_started {
            let _ = self.dtls.handle_timeout(self.remote_addr, now);
        }
        if let Some(association) = self.association.as_mut() {
            association.handle_timeout(now);
        }
        // A timeout pass can schedule ICE checks and SCTP retransmits, so the
        // full pump must run here too. Without this, checks produced on a tick
        // never leave the process and the handshake depends on the peer
        // sending first.
        let _ = self.pump();
        if !self.opened && now >= self.handshake_deadline {
            self.finish(CloseReason::Timeout);
        }
    }

    /// Sends one application message. Returns one of the `SEND_*` codes.
    pub fn send(&mut self, data: &[u8]) -> SendResult {
        if self.finished {
            return SendResult::NotOpen;
        }
        if !self.opened {
            return SendResult::NotOpen;
        }
        if data.len() > crate::MAX_MESSAGE_SIZE {
            return SendResult::TooLarge;
        }
        let cap = self.send_buffer_cap;
        let stream_id = self.stream_id;
        // One stream lookup covers the backpressure check and the write. The
        // borrow ends before the drains, which re-borrow the association.
        let accepted = {
            let Some(association) = self.association.as_mut() else {
                return SendResult::NotOpen;
            };
            let Ok(mut stream) = association.stream(stream_id) else {
                return SendResult::NotOpen;
            };
            let buffered = stream.buffered_amount().unwrap_or(0);
            if buffered.saturating_add(data.len()) > cap {
                return SendResult::Backpressure;
            }
            if !stream.is_writable() {
                return SendResult::NotOpen;
            }
            // SCTP cannot carry a zero-length user message, so an empty payload
            // is sent as one zero byte with the BinaryEmpty PPID, which the
            // receiver turns back into an empty message.
            let (ppi, payload) = if data.is_empty() {
                (
                    PayloadProtocolIdentifier::BinaryEmpty,
                    Bytes::from_static(&[0]),
                )
            } else {
                (
                    PayloadProtocolIdentifier::Binary,
                    Bytes::copy_from_slice(data),
                )
            };
            stream.write_chunk_with_ppi(&payload, ppi).is_ok()
        };
        if !accepted {
            return SendResult::NotOpen;
        }
        let _ = self.drain_channel();
        let _ = self.drain_sctp_transmits();
        self.drain_dtls_transmits();
        SendResult::Accepted
    }

    /// Closes the tunnel locally.
    pub fn close(&mut self) {
        if self.finished {
            return;
        }
        let _ = self.ice.close();
        self.finish(CloseReason::Local);
    }

    /// Returns the next datagram or lifecycle event.
    pub fn poll_event(&mut self) -> Option<Event> {
        self.events.pop_front()
    }

    /// Next instant, in the input millisecond scale, at which `tick` should run.
    pub fn next_deadline(&mut self) -> Option<u64> {
        if self.finished {
            return None;
        }
        let mut best: Option<Instant> = if self.opened {
            None
        } else {
            Some(self.handshake_deadline)
        };
        if let Some(t) = self.ice.poll_timeout() {
            best = Some(best.map_or(t, |b| b.min(t)));
        }
        if self.dtls_started {
            if let Some(t) = self.dtls.poll_timeout(&self.remote_addr) {
                best = Some(best.map_or(t, |b| b.min(t)));
            }
        }
        if let Some(association) = self.association.as_ref() {
            if let Some(t) = association.poll_timeout() {
                best = Some(best.map_or(t, |b| b.min(t)));
            }
        }
        best.map(|t| self.ms(t))
    }

    /// Whether the data channel is open and usable.
    pub fn is_open(&self) -> bool {
        self.opened
    }

    /// Whether the tunnel has stopped.
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// Datagrams the transport rejected as malformed.
    pub fn dropped_datagrams(&self) -> u64 {
        self.dropped_datagrams
    }

    /// Bytes waiting in the data channel send buffer.
    pub fn buffered_bytes(&mut self) -> usize {
        let stream_id = self.stream_id;
        self.association
            .as_mut()
            .and_then(|a| {
                a.stream(stream_id)
                    .ok()
                    .and_then(|s| s.buffered_amount().ok())
            })
            .unwrap_or(0)
    }

    /// First-observation times for the handshake phases.
    pub fn handshake_trace(&self) -> HandshakeTrace {
        self.trace
    }

    /// The DTLS cipher suite negotiated with the peer, or `None` until the
    /// handshake selects one.
    ///
    /// The suite's IANA name, such as
    /// `TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256`. A host can log this to
    /// confirm which record protection is active, since the offered list is a
    /// preference and the peer's answer decides.
    pub fn negotiated_cipher_suite(&self) -> Option<String> {
        let remote = self.remote_addr;
        let state = self.dtls.get_connection_state(remote)?;
        state.cipher_suite().map(|suite| suite.to_string())
    }
}

struct ParsedOffer {
    ufrag: String,
    pwd: String,
    remote: SocketAddr,
    fingerprint: String,
}

impl ParsedOffer {
    /// Reads only the fields a known peer needs, so a full SDP parser is not
    /// pulled into the wasm artifact.
    fn parse(sdp: &str) -> Result<Self> {
        let mut ufrag = None;
        let mut pwd = None;
        let mut remote = None;
        let mut fingerprint = None;
        for raw in sdp.lines() {
            let line = raw.trim();
            if let Some(value) = line.strip_prefix("a=ice-ufrag:") {
                ufrag = Some(value.trim().to_owned());
            } else if let Some(value) = line.strip_prefix("a=ice-pwd:") {
                pwd = Some(value.trim().to_owned());
            } else if let Some(value) = line.strip_prefix("a=fingerprint:") {
                if let Some((_, value)) = value.split_once(' ') {
                    fingerprint = Some(value.trim().to_lowercase());
                }
            } else if let Some(value) = line.strip_prefix("a=candidate:") {
                let fields: Vec<&str> = value.split_whitespace().collect();
                if fields.len() >= 8 && fields[1] == "1" && fields[7] == "host" {
                    if let Some(addr) = parse_candidate_addr(fields[4], fields[5]) {
                        remote = Some(addr);
                    }
                }
            }
        }
        Ok(Self {
            ufrag: ufrag.ok_or_else(|| TunnelError::Config("offer has no ice-ufrag".into()))?,
            pwd: pwd.ok_or_else(|| TunnelError::Config("offer has no ice-pwd".into()))?,
            remote: remote
                .ok_or_else(|| TunnelError::Config("offer has no host candidate".into()))?,
            fingerprint: fingerprint.unwrap_or_default(),
        })
    }
}

/// Parses the address and port of an ICE host candidate. The address is bare
/// (no brackets), so IPv6 needs them added before it can parse as a
/// `SocketAddr`.
fn parse_candidate_addr(address: &str, port: &str) -> Option<SocketAddr> {
    let host = if address.contains(':') {
        format!("[{address}]:{port}")
    } else {
        format!("{address}:{port}")
    };
    host.parse().ok()
}

fn parse_answer_fingerprint(sdp: &str) -> Option<String> {
    for raw in sdp.lines() {
        let line = raw.trim();
        if let Some(value) = line.strip_prefix("a=fingerprint:") {
            if let Some((_, value)) = value.split_once(' ') {
                return Some(value.trim().to_lowercase());
            }
        }
    }
    None
}

fn fingerprint_of(
    certificate: &rtc_dtls::crypto::Certificate,
    crypto: &dyn rtc_crypto::RTCCrypto,
) -> Result<String> {
    let der = certificate
        .certificate
        .first()
        .ok_or_else(|| TunnelError::Config("certificate chain empty".into()))?;
    let hash = crypto
        .hash(rtc_crypto::HashAlgorithm::Sha256, der.as_ref())
        .map_err(|e| TunnelError::Config(format!("fingerprint: {e}")))?;
    Ok(hash
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":"))
}
