//! Drop-in replacement for `std/src/sys/time/unsupported.rs` on bare wasm.
//!
//! The stock file panics in `Instant::now` and `SystemTime::now`, because
//! `wasm32-unknown-unknown` has no clock. This version routes both to host
//! imports in the `rtc_tunnel` module, which the embedding process supplies.
//! Non-wasm targets keep the original panic so nothing else changes behaviour.
//!
//! Installed by `scripts/build-wasm.sh`; do not edit the copy under rustup.

use crate::time::Duration;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "rtc_tunnel")]
unsafe extern "C" {
    fn now_micros() -> u64;
    fn unix_millis() -> f64;
}

#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug, Hash)]
pub struct Instant(Duration);

#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug, Hash)]
pub struct SystemTime(Duration);

pub const UNIX_EPOCH: SystemTime = SystemTime(Duration::from_secs(0));

impl Instant {
    pub fn now() -> Instant {
        #[cfg(target_arch = "wasm32")]
        {
            Instant(Duration::from_micros(unsafe { now_micros() }))
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            panic!("time not implemented on this platform")
        }
    }

    pub fn checked_sub_instant(&self, other: &Instant) -> Option<Duration> {
        self.0.checked_sub(other.0)
    }

    pub fn checked_add_duration(&self, other: &Duration) -> Option<Instant> {
        Some(Instant(self.0.checked_add(*other)?))
    }

    pub fn checked_sub_duration(&self, other: &Duration) -> Option<Instant> {
        Some(Instant(self.0.checked_sub(*other)?))
    }
}

impl SystemTime {
    pub const MAX: SystemTime = SystemTime(Duration::MAX);

    pub const MIN: SystemTime = SystemTime(Duration::ZERO);

    pub fn now() -> SystemTime {
        #[cfg(target_arch = "wasm32")]
        {
            SystemTime(Duration::from_millis(unsafe { unix_millis() } as u64))
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            panic!("time not implemented on this platform")
        }
    }

    pub fn sub_time(&self, other: &SystemTime) -> Result<Duration, Duration> {
        self.0.checked_sub(other.0).ok_or_else(|| other.0 - self.0)
    }

    pub fn checked_add_duration(&self, other: &Duration) -> Option<SystemTime> {
        Some(SystemTime(self.0.checked_add(*other)?))
    }

    pub fn checked_sub_duration(&self, other: &Duration) -> Option<SystemTime> {
        Some(SystemTime(self.0.checked_sub(*other)?))
    }
}
