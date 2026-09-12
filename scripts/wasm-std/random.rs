//! Drop-in replacement for `std/src/sys/random/unsupported.rs` on bare wasm.
//!
//! The stock file panics when `std` needs random bytes, which also makes
//! `HashMap`'s default hasher unusable. This version draws from the host
//! import `rtc_tunnel.fill_random`, the same source the crypto stack uses.
//! Non-wasm targets keep the original allocation-address fallback.
//!
//! Installed by `scripts/build-wasm.sh`; do not edit the copy under rustup.

use crate::ptr;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "rtc_tunnel")]
unsafe extern "C" {
    fn fill_random(dest: *mut u8, len: usize) -> u32;
}

pub fn fill_bytes(bytes: &mut [u8]) {
    #[cfg(target_arch = "wasm32")]
    {
        if bytes.is_empty() {
            return;
        }
        let written = unsafe { fill_random(bytes.as_mut_ptr(), bytes.len()) };
        if written != bytes.len() as u32 {
            panic!("host failed to provide random bytes");
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = bytes;
        panic!("this target does not support random data generation");
    }
}

pub fn hashmap_random_keys() -> (u64, u64) {
    #[cfg(target_arch = "wasm32")]
    {
        let mut buf = [0u8; 16];
        fill_bytes(&mut buf);
        let k1 = u64::from_ne_bytes(buf[..8].try_into().unwrap());
        let k2 = u64::from_ne_bytes(buf[8..].try_into().unwrap());
        (k1, k2)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        // Use allocation addresses for a bit of randomness. This isn't
        // particularly secure, but there isn't really an alternative.
        let stack = 0u8;
        let heap = Box::new(0u8);
        let k1 = ptr::from_ref(&stack).addr() as u64;
        let k2 = ptr::from_ref(&*heap).addr() as u64;
        (k1, k2)
    }
}
