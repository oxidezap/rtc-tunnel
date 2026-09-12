use bytes::Bytes;

/// Why the tunnel stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseReason {
    /// The local endpoint closed the tunnel.
    Local,
    /// The peer or the transport closed the tunnel.
    Remote,
    /// The handshake did not finish inside the configured budget.
    Timeout,
    /// The transport reported a failure.
    Failure,
}

/// Something the tunnel wants the host to do or know.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Send these bytes to the configured remote address.
    SendDatagram(Bytes),
    /// The data channel is usable.
    Opened,
    /// An application message arrived on the channel.
    Message(Bytes),
    /// The tunnel is finished. No further events follow.
    Closed(CloseReason),
}

/// Outcome of a send attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendResult {
    /// The message was accepted for transmission.
    Accepted,
    /// The channel is up but its send buffer is over the configured cap.
    Backpressure,
    /// The message is larger than the channel's maximum message size.
    TooLarge,
    /// The channel is not open, so the payload was dropped.
    NotOpen,
}
