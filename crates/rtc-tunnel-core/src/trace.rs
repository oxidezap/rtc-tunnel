/// First-observation times for the connection establishment phases.
///
/// Values are millisecond readings on the same clock the host feeds to
/// [`receive`](crate::Tunnel::receive) and [`tick`](crate::Tunnel::tick), with
/// the same origin as the `now_ms` passed to the constructor. A phase that has
/// not happened is `None`. Only the first observation is recorded, so the trace
/// costs nothing after the channel opens.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HandshakeTrace {
    start_ms: u64,
    ice_ms: Option<u64>,
    dtls_ms: Option<u64>,
    sctp_ms: Option<u64>,
    opened_ms: Option<u64>,
}

impl HandshakeTrace {
    pub(crate) fn new(start_ms: u64) -> Self {
        Self {
            start_ms,
            ..Self::default()
        }
    }

    #[cfg(feature = "rtc-backend")]
    pub(crate) fn observe(
        &mut self,
        now_ms: u64,
        ice_ready: bool,
        dtls_ready: bool,
        sctp_ready: bool,
        opened: bool,
    ) {
        if self.opened_ms.is_some() {
            return;
        }
        if ice_ready && self.ice_ms.is_none() {
            self.ice_ms = Some(now_ms);
        }
        if dtls_ready && self.dtls_ms.is_none() {
            self.dtls_ms = Some(now_ms);
        }
        if sctp_ready && self.sctp_ms.is_none() {
            self.sctp_ms = Some(now_ms);
        }
        if opened && self.opened_ms.is_none() {
            self.opened_ms = Some(now_ms);
        }
    }

    /// The clock reading passed to the constructor.
    pub fn start_ms(&self) -> u64 {
        self.start_ms
    }

    /// When ICE first reached a connected or completed state.
    pub fn ice_ms(&self) -> Option<u64> {
        self.ice_ms
    }

    /// When DTLS first completed its handshake.
    pub fn dtls_ms(&self) -> Option<u64> {
        self.dtls_ms
    }

    /// When SCTP first reported its association connected.
    pub fn sctp_ms(&self) -> Option<u64> {
        self.sctp_ms
    }

    /// When the data channel first became usable.
    pub fn opened_ms(&self) -> Option<u64> {
        self.opened_ms
    }

    /// Records the first ICE connected observation, in input-clock milliseconds.
    pub fn observe_ice(&mut self, now_ms: u64) {
        if self.ice_ms.is_none() {
            self.ice_ms = Some(now_ms);
        }
    }

    /// Records the first DTLS completion, in input-clock milliseconds.
    pub fn observe_dtls(&mut self, now_ms: u64) {
        if self.dtls_ms.is_none() {
            self.dtls_ms = Some(now_ms);
        }
    }

    /// Records the first SCTP association connected observation.
    pub fn observe_sctp(&mut self, now_ms: u64) {
        if self.sctp_ms.is_none() {
            self.sctp_ms = Some(now_ms);
        }
    }

    /// Records the first channel-open observation.
    pub fn observe_open(&mut self, now_ms: u64) {
        if self.opened_ms.is_none() {
            self.opened_ms = Some(now_ms);
        }
    }

    /// Whether every phase has been observed.
    pub fn is_complete(&self) -> bool {
        self.opened_ms.is_some()
    }
}
