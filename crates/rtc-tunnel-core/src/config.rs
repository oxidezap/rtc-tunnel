use std::net::SocketAddr;

/// Everything the tunnel needs to reach one known peer.
///
/// The peer is not discovered: its transport address, ICE credentials and DTLS
/// fingerprint are supplied up front. That is the whole reason this is a tunnel
/// and not a WebRTC stack.
#[derive(Debug, Clone)]
pub struct TunnelConfig {
    /// Remote transport address datagrams are sent to.
    pub remote: SocketAddr,
    /// Remote ICE username fragment.
    pub ice_ufrag: String,
    /// Remote ICE password.
    pub ice_pwd: String,
    /// Remote DTLS certificate fingerprint, colon separated hex.
    pub remote_fingerprint: String,
    /// Hash algorithm for `remote_fingerprint`.
    pub fingerprint_algorithm: String,
    /// Remote SCTP port.
    pub sctp_port: u16,
    /// SCTP stream the pre-negotiated channel occupies.
    pub stream_id: u16,
    /// Whether the channel preserves message order.
    pub ordered: bool,
    /// Retransmission cap for the channel.
    pub max_retransmits: Option<u16>,
    /// Time budget for ICE, DTLS and SCTP to come up.
    pub handshake_timeout_ms: u64,
    /// Skip remote certificate fingerprint verification.
    ///
    /// Only for deterministic tests and controlled environments where the peer
    /// certificate is trusted out of band. Leave off for the relay.
    pub disable_fingerprint_verification: bool,
}

impl TunnelConfig {
    pub fn new(
        remote: SocketAddr,
        ice_ufrag: String,
        ice_pwd: String,
        remote_fingerprint: String,
    ) -> Self {
        Self {
            remote,
            ice_ufrag,
            ice_pwd,
            remote_fingerprint,
            fingerprint_algorithm: "sha-256".to_owned(),
            sctp_port: 5000,
            stream_id: 0,
            ordered: false,
            max_retransmits: Some(0),
            handshake_timeout_ms: 30_000,
            disable_fingerprint_verification: false,
        }
    }
}
