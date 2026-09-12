//! Sans-I/O single binary data channel over ICE, DTLS and SCTP.
//!
//! This crate does not know what runs on the channel. It only knows how to
//! bring up one pre-negotiated, unordered, unreliable SCTP stream to a peer
//! whose transport address, ICE credentials and DTLS fingerprint are supplied
//! up front, then move opaque byte messages across it.
//!
//! No sockets, no threads, no async runtime, no clock reads after
//! construction. The host owns all of those and drives the tunnel with
//! [`Tunnel::receive`], [`Tunnel::tick`], [`Tunnel::send`] and
//! [`Tunnel::poll_event`].
//!
//! Two backends implement the same API. `direct` drives `rtc-ice`, `rtc-dtls`
//! and `rtc-sctp` itself and is the shipped default; the umbrella `rtc` crate
//! does not appear in its dependency graph. `rtc-backend` drives the umbrella
//! peer connection and exists for the reference peer and cross-checks.

mod config;
#[cfg(feature = "direct")]
pub mod direct;
mod error;
mod event;
mod trace;
#[cfg(feature = "rtc-backend")]
mod tunnel;

pub use config::TunnelConfig;
pub use error::{Result, TunnelError};
pub use event::{CloseReason, Event, SendResult};
pub use trace::HandshakeTrace;

/// Default cap on bytes waiting in the data channel send buffer.
pub const DEFAULT_SEND_BUFFER_CAP: usize = 1024 * 1024;

/// SCTP `max-message-size` ceiling advertised for the single channel, matching
/// the relay contract.
pub const MAX_MESSAGE_SIZE: usize = 262144;

#[cfg(feature = "rtc-backend")]
pub use tunnel::Tunnel;

#[cfg(not(feature = "rtc-backend"))]
#[cfg(feature = "direct")]
pub use direct::DirectTunnel as Tunnel;
