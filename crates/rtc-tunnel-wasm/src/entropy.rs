//! Entropy bridge for the bare wasm target.
//!
//! The reconstructed std in `scripts/build-wasm.sh` already imports the clock
//! from the host. Randomness reaches the crypto stack through `getrandom`'s
//! custom backend, which this module implements on top of the host's
//! `rtc_tunnel.fill_random` import. Host randomness is also what backs `std`'s
//! own `fill_bytes`, so `ring`, `rand` and `std` share one source.

use getrandom04::Error as GetrandomError;

#[link(wasm_import_module = "rtc_tunnel")]
unsafe extern "C" {
    fn fill_random(dest: *mut u8, len: usize) -> u32;
}

fn host_fill(dest: *mut u8, len: usize) -> bool {
    if len == 0 {
        return true;
    }
    unsafe { fill_random(dest, len) == len as u32 }
}

/// getrandom 0.2 custom backend. Returns 0 on success, non-zero on failure.
#[no_mangle]
pub unsafe extern "Rust" fn __getrandom_custom(dest: *mut u8, len: usize) -> u32 {
    if host_fill(dest, len) {
        0
    } else {
        1
    }
}

/// getrandom 0.4 custom backend (the same symbol 0.3 used).
#[no_mangle]
pub unsafe extern "Rust" fn __getrandom_v03_custom(
    dest: *mut u8,
    len: usize,
) -> Result<(), GetrandomError> {
    if host_fill(dest, len) {
        Ok(())
    } else {
        Err(GetrandomError::new_custom(1))
    }
}
