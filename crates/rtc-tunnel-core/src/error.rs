use std::fmt;

/// Reasons a tunnel cannot be created or driven.
#[derive(Debug)]
pub enum TunnelError {
    /// The peer connection engine rejected the operation.
    #[cfg(feature = "rtc-backend")]
    PeerConnection(rtc::shared::error::Error),
    /// A configuration value is unusable.
    Config(String),
}

impl fmt::Display for TunnelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            #[cfg(feature = "rtc-backend")]
            Self::PeerConnection(err) => write!(f, "peer connection error: {err}"),
            Self::Config(msg) => write!(f, "invalid tunnel config: {msg}"),
        }
    }
}

impl std::error::Error for TunnelError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            #[cfg(feature = "rtc-backend")]
            Self::PeerConnection(err) => Some(err),
            Self::Config(_) => None,
        }
    }
}

#[cfg(feature = "rtc-backend")]
impl From<rtc::shared::error::Error> for TunnelError {
    fn from(err: rtc::shared::error::Error) -> Self {
        Self::PeerConnection(err)
    }
}

/// Result alias for tunnel operations.
pub type Result<T, E = TunnelError> = std::result::Result<T, E>;
