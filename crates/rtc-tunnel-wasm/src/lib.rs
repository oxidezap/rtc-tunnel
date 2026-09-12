//! Minimal C ABI over [`rtc_tunnel_core::Tunnel`] for bare WebAssembly.
//!
//! The core is Sans-I/O and owns no socket, task or clock. This layer only
//! marshals values across the ABI: strings are `(pointer, length)` pairs, and
//! events are pulled as a kind plus a shared payload buffer.
//!
//! # Target
//!
//! Built for `wasm32-unknown-unknown`, with the clock and randomness supplied by
//! host imports. Node, Bun or Deno owns the UDP socket; this module needs no WASI
//! or wasm-bindgen glue.

use std::alloc::{alloc, dealloc, Layout};
use std::net::SocketAddr;
use std::ptr;
use std::str;
use std::sync::Mutex;

use rtc_tunnel_core::{CloseReason, Event, SendResult, Tunnel, TunnelConfig};

#[cfg(target_family = "wasm")]
mod entropy;

/// Message describing why the last `rtc_tunnel_create` returned null.
static LAST_ERROR: Mutex<Vec<u8>> = Mutex::new(Vec::new());

fn set_last_error(message: &str) {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        slot.clear();
        slot.extend_from_slice(message.as_bytes());
    }
}

fn clear_last_error() {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        slot.clear();
    }
}

/// Length of the last create error message, zero when none.
#[no_mangle]
pub extern "C" fn rtc_tunnel_last_error_len() -> usize {
    LAST_ERROR.lock().map(|slot| slot.len()).unwrap_or(0)
}

/// Copies the last create error message into `buf`, returning bytes written.
///
/// # Safety
///
/// `buf` must point to `cap` writable bytes, or be null with `cap` zero. A null
/// `buf` is accepted and reports zero bytes written.
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_last_error_copy(buf: *mut u8, cap: usize) -> usize {
    if buf.is_null() {
        return 0;
    }
    match LAST_ERROR.lock() {
        Ok(slot) => {
            let n = slot.len().min(cap);
            ptr::copy_nonoverlapping(slot.as_ptr(), buf, n);
            n
        }
        Err(_) => 0,
    }
}

/// No event is pending.
pub const EVENT_NONE: u32 = 0;
/// Event payload is a datagram to send.
pub const EVENT_DATAGRAM: u32 = 1;
/// The channel opened.
pub const EVENT_OPENED: u32 = 2;
/// Event payload is an application message.
pub const EVENT_MESSAGE: u32 = 3;
/// The tunnel closed. See `rtc_tunnel_event_reason`.
pub const EVENT_CLOSED: u32 = 4;

/// `send` accepted the message.
pub const SEND_ACCEPTED: u32 = 0;
/// `send` refused because the send buffer is above its cap.
pub const SEND_BACKPRESSURE: u32 = 1;
/// `send` refused because the channel is not open.
pub const SEND_NOT_OPEN: u32 = 2;
/// `send` refused because the message exceeds the channel's maximum size.
pub const SEND_TOO_LARGE: u32 = 3;

/// Version of the C ABI. The loader rejects a module that reports anything else.
pub const ABI_VERSION: u32 = 1;

/// Returns the C ABI version implemented by this module.
#[no_mangle]
pub extern "C" fn rtc_tunnel_abi_version() -> u32 {
    ABI_VERSION
}

/// WASI reactor initializer. The module has no constructors to run.
#[no_mangle]
pub extern "C" fn _initialize() {}

/// Host-facing handle wrapping a [`Tunnel`]. Opaque to the host.
pub struct TunnelHandle {
    tunnel: Tunnel,
    offer: Vec<u8>,
    event_kind: u32,
    event_payload: Vec<u8>,
    event_reason: u32,
    /// Events pulled by the last `rtc_tunnel_drain_events`, kept alive so the
    /// descriptor pointers stay valid until the next drain.
    drained: Vec<Event>,
    /// Flat `[kind, ptr, len, aux]` records, four u32 per event.
    descriptors: Vec<u32>,
    /// Cached DTLS cipher suite name, resolved once the handshake selects one.
    cipher: Option<Vec<u8>>,
}

impl TunnelHandle {
    /// The negotiated DTLS cipher suite name, resolved and cached on first ask.
    ///
    /// The `rtc` backend's accessor takes `&mut self`. The suite never changes
    /// after the handshake, so the first non-empty answer is kept.
    fn cipher_name(&mut self) -> Option<&[u8]> {
        if self.cipher.is_none() {
            self.cipher = self
                .tunnel
                .negotiated_cipher_suite()
                .map(String::into_bytes);
        }
        self.cipher.as_deref()
    }
}

/// Allocates `len` bytes for the host to write into. Free with
/// [`rtc_tunnel_free`].
#[no_mangle]
pub extern "C" fn rtc_tunnel_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return ptr::null_mut();
    }
    unsafe { alloc(Layout::from_size_align_unchecked(len, 1)) }
}

/// Frees a buffer previously returned by [`rtc_tunnel_alloc`].
///
/// # Safety
///
/// `ptr` must be a pointer returned by [`rtc_tunnel_alloc`] with the same `len`,
/// or null. The allocation must not be used after this call.
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        dealloc(ptr, Layout::from_size_align_unchecked(len, 1));
    }
}

unsafe fn str_arg<'a>(ptr: *const u8, len: usize) -> Result<&'a str, ()> {
    if ptr.is_null() {
        return Err(());
    }
    str::from_utf8(slice_from(ptr, len)).map_err(|_| ())
}

unsafe fn slice_from<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

/// Creates a tunnel. Returns null on failure, for example an unparsable
/// address or missing credentials.
///
/// `remote` and `local` are `ip:port` strings. `ordered` is 0 or 1.
/// `max_retransmits` below zero means unlimited retransmissions.
///
/// # Safety
///
/// Each `(ptr, len)` pair must point to `len` readable bytes, or be null with
/// `len` zero. The bytes need not be aligned and are read only during the call.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn rtc_tunnel_create(
    remote_ptr: *const u8,
    remote_len: usize,
    ufrag_ptr: *const u8,
    ufrag_len: usize,
    pwd_ptr: *const u8,
    pwd_len: usize,
    fingerprint_ptr: *const u8,
    fingerprint_len: usize,
    fingerprint_algorithm_ptr: *const u8,
    fingerprint_algorithm_len: usize,
    local_ptr: *const u8,
    local_len: usize,
    sctp_port: u32,
    stream_id: u32,
    ordered: u32,
    max_retransmits: i32,
    handshake_timeout_ms: f64,
    disable_fingerprint_verification: u32,
    now_ms: f64,
) -> *mut TunnelHandle {
    clear_last_error();

    let remote: SocketAddr =
        match str_arg(remote_ptr, remote_len).and_then(|s| s.parse().map_err(|_| ())) {
            Ok(v) => v,
            Err(()) => {
                set_last_error("remote must be an ip:port string");
                return ptr::null_mut();
            }
        };
    let local: SocketAddr =
        match str_arg(local_ptr, local_len).and_then(|s| s.parse().map_err(|_| ())) {
            Ok(v) => v,
            Err(()) => {
                set_last_error("local must be an ip:port string");
                return ptr::null_mut();
            }
        };
    let ufrag = match str_arg(ufrag_ptr, ufrag_len) {
        Ok(v) => v,
        Err(()) => {
            set_last_error("ice ufrag must be valid utf-8");
            return ptr::null_mut();
        }
    };
    let pwd = match str_arg(pwd_ptr, pwd_len) {
        Ok(v) => v,
        Err(()) => {
            set_last_error("ice pwd must be valid utf-8");
            return ptr::null_mut();
        }
    };
    let fingerprint = match str_arg(fingerprint_ptr, fingerprint_len) {
        Ok(v) => v,
        Err(()) => {
            set_last_error("fingerprint must be valid utf-8");
            return ptr::null_mut();
        }
    };
    let fingerprint_algorithm = match str_arg(fingerprint_algorithm_ptr, fingerprint_algorithm_len)
    {
        Ok(v) => v,
        Err(()) => {
            set_last_error("fingerprint algorithm must be valid utf-8");
            return ptr::null_mut();
        }
    };

    if sctp_port > u16::MAX as u32 {
        set_last_error("sctp port must fit in u16");
        return ptr::null_mut();
    }
    if stream_id > 65534 {
        set_last_error("stream id must be 0..=65534");
        return ptr::null_mut();
    }

    let mut config = TunnelConfig::new(
        remote,
        ufrag.to_owned(),
        pwd.to_owned(),
        fingerprint.to_owned(),
    );
    config.sctp_port = sctp_port as u16;
    config.stream_id = stream_id as u16;
    config.fingerprint_algorithm = fingerprint_algorithm.to_owned();
    config.ordered = ordered != 0;
    config.max_retransmits = (max_retransmits >= 0).then_some(max_retransmits as u16);
    if handshake_timeout_ms > 0.0 {
        config.handshake_timeout_ms = handshake_timeout_ms as u64;
    }
    config.disable_fingerprint_verification = disable_fingerprint_verification != 0;

    match Tunnel::new(config, local, now_ms.max(0.0) as u64) {
        Ok(tunnel) => {
            let offer = tunnel.offer_sdp().unwrap_or_default().into_bytes();
            Box::into_raw(Box::new(TunnelHandle {
                tunnel,
                offer,
                event_kind: EVENT_NONE,
                event_payload: Vec::new(),
                event_reason: 0,
                drained: Vec::new(),
                descriptors: Vec::new(),
                cipher: None,
            }))
        }
        Err(err) => {
            set_last_error(&err.to_string());
            ptr::null_mut()
        }
    }
}

/// Destroys a tunnel created by [`rtc_tunnel_create`].
/// # Safety
///
/// `tunnel` must be a pointer returned by [`rtc_tunnel_create`], or null. It
/// must not be used again after this call.
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_destroy(tunnel: *mut TunnelHandle) {
    if !tunnel.is_null() {
        drop(Box::from_raw(tunnel));
    }
}

/// Feeds one datagram received from the remote address.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a no-op).
/// `data` must point to `data_len` readable bytes, or be null with `data_len`
/// zero.
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_input(
    tunnel: *mut TunnelHandle,
    now_ms: f64,
    data_ptr: *const u8,
    data_len: usize,
) {
    if tunnel.is_null() {
        return;
    }
    (*tunnel)
        .tunnel
        .receive(now_ms.max(0.0) as u64, slice_from(data_ptr, data_len));
}

/// Feeds one datagram without advancing the protocol.
///
/// Call [`rtc_tunnel_finish_input_batch`] once after a run of these to advance
/// the ICE, DTLS and SCTP layers a single time for the whole batch. Before the
/// channel opens this pumps each datagram itself, so the handshake is
/// unaffected.
///
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a no-op).
/// `data` must point to `data_len` readable bytes, or be null with `data_len`
/// zero.
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_input_deferred(
    tunnel: *mut TunnelHandle,
    now_ms: f64,
    data_ptr: *const u8,
    data_len: usize,
) {
    if tunnel.is_null() {
        return;
    }
    (*tunnel)
        .tunnel
        .receive_deferred(now_ms.max(0.0) as u64, slice_from(data_ptr, data_len));
}

/// Advances the protocol once for every datagram fed since the last call.
///
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a no-op).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_finish_input_batch(tunnel: *mut TunnelHandle) {
    if tunnel.is_null() {
        return;
    }
    (*tunnel).tunnel.finish_input_batch();
}

/// Reports the passage of time.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a no-op).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_tick(tunnel: *mut TunnelHandle, now_ms: f64) {
    if tunnel.is_null() {
        return;
    }
    (*tunnel).tunnel.tick(now_ms.max(0.0) as u64);
}

/// Sends one message. Returns one of `SEND_*`.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null reports
/// `SEND_NOT_OPEN`). `data` must point to `data_len` readable bytes, or be null
/// with `data_len` zero.
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_send(
    tunnel: *mut TunnelHandle,
    data_ptr: *const u8,
    data_len: usize,
) -> u32 {
    if tunnel.is_null() {
        return SEND_NOT_OPEN;
    }
    match (*tunnel).tunnel.send(slice_from(data_ptr, data_len)) {
        SendResult::Accepted => SEND_ACCEPTED,
        SendResult::Backpressure => SEND_BACKPRESSURE,
        SendResult::TooLarge => SEND_TOO_LARGE,
        SendResult::NotOpen => SEND_NOT_OPEN,
    }
}

/// Next deadline in milliseconds on the input clock, or `-1` if none.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns
/// `-1`).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_next_deadline(tunnel: *mut TunnelHandle) -> f64 {
    if tunnel.is_null() {
        return -1.0;
    }
    (*tunnel)
        .tunnel
        .next_deadline()
        .map(|ms| ms as f64)
        .unwrap_or(-1.0)
}

/// Whether the channel is open.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns 0).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_is_open(tunnel: *mut TunnelHandle) -> u32 {
    if tunnel.is_null() {
        return 0;
    }
    u32::from((*tunnel).tunnel.is_open())
}

/// Whether the tunnel has finished.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns 1).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_is_finished(tunnel: *mut TunnelHandle) -> u32 {
    if tunnel.is_null() {
        return 1;
    }
    u32::from((*tunnel).tunnel.is_finished())
}

/// Datagrams the transport rejected as malformed.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns 0).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_dropped_datagrams(tunnel: *mut TunnelHandle) -> f64 {
    if tunnel.is_null() {
        return 0.0;
    }
    (*tunnel).tunnel.dropped_datagrams() as f64
}

/// Closes the tunnel.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a no-op).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_close(tunnel: *mut TunnelHandle) {
    if !tunnel.is_null() {
        (*tunnel).tunnel.close();
    }
}

/// Sets the send buffer cap in bytes.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a no-op).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_set_send_buffer_cap(tunnel: *mut TunnelHandle, cap: usize) {
    if !tunnel.is_null() {
        (*tunnel).tunnel.set_send_buffer_cap(cap);
    }
}

/// Length of the SDP offer generated at construction.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns 0).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_offer_len(tunnel: *mut TunnelHandle) -> usize {
    if tunnel.is_null() {
        return 0;
    }
    (*tunnel).offer.len()
}

/// Copies the SDP offer into `buf`, returning the number of bytes written.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null. `buf` must point
/// to `cap` writable bytes, or be null with `cap` zero.
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_offer_copy(
    tunnel: *mut TunnelHandle,
    buf: *mut u8,
    cap: usize,
) -> usize {
    if tunnel.is_null() || buf.is_null() {
        return 0;
    }
    let offer = &(*tunnel).offer;
    let n = offer.len().min(cap);
    ptr::copy_nonoverlapping(offer.as_ptr(), buf, n);
    n
}

/// Advances to the next pending event. Returns one of `EVENT_*`.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null reports
/// `EVENT_NONE`).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_poll_event(tunnel: *mut TunnelHandle) -> u32 {
    if tunnel.is_null() {
        return EVENT_NONE;
    }
    let handle = &mut *tunnel;
    handle.event_kind = EVENT_NONE;
    handle.event_payload.clear();
    handle.event_reason = 0;
    match handle.tunnel.poll_event() {
        None => EVENT_NONE,
        Some(Event::SendDatagram(bytes)) => {
            handle.event_payload = bytes.to_vec();
            handle.event_kind = EVENT_DATAGRAM;
            EVENT_DATAGRAM
        }
        Some(Event::Opened) => {
            handle.event_kind = EVENT_OPENED;
            EVENT_OPENED
        }
        Some(Event::Message(bytes)) => {
            handle.event_payload = bytes.to_vec();
            handle.event_kind = EVENT_MESSAGE;
            EVENT_MESSAGE
        }
        Some(Event::Closed(reason)) => {
            handle.event_reason = match reason {
                CloseReason::Local => 0,
                CloseReason::Remote => 1,
                CloseReason::Timeout => 2,
                CloseReason::Failure => 3,
            };
            handle.event_kind = EVENT_CLOSED;
            EVENT_CLOSED
        }
    }
}

/// Pointer to the current event payload. Valid until the next
/// `rtc_tunnel_poll_event`.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns
/// null). The returned pointer is valid until the next `rtc_tunnel_poll_event`.
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_event_ptr(tunnel: *mut TunnelHandle) -> *const u8 {
    if tunnel.is_null() {
        return ptr::null();
    }
    (*tunnel).event_payload.as_ptr()
}

/// Length of the current event payload.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns 0).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_event_len(tunnel: *mut TunnelHandle) -> usize {
    if tunnel.is_null() {
        return 0;
    }
    (*tunnel).event_payload.len()
}

/// Close reason for `EVENT_CLOSED`.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns 0).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_event_reason(tunnel: *mut TunnelHandle) -> u32 {
    if tunnel.is_null() {
        return 0;
    }
    (*tunnel).event_reason
}

/// Kind of the current event.
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null reports
/// `EVENT_NONE`).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_event_kind(tunnel: *mut TunnelHandle) -> u32 {
    if tunnel.is_null() {
        return EVENT_NONE;
    }
    (*tunnel).event_kind
}

fn close_reason_code(reason: CloseReason) -> u32 {
    match reason {
        CloseReason::Local => 0,
        CloseReason::Remote => 1,
        CloseReason::Timeout => 2,
        CloseReason::Failure => 3,
    }
}

/// Pulls up to `max` events in one call and keeps them for inspection.
///
/// Returns the number of events. The host then reads `count * 4` u32 values
/// from [`rtc_tunnel_events_ptr`], four per event: `kind`, payload pointer,
/// payload length, and an auxiliary value (the close reason for `EVENT_CLOSED`,
/// zero otherwise). Payload pointers are valid until the next drain. This lets
/// a burst of datagrams cross the boundary in one call instead of one
/// `rtc_tunnel_poll_event` per event.
///
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns 0).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_drain_events(tunnel: *mut TunnelHandle, max: u32) -> u32 {
    if tunnel.is_null() {
        return 0;
    }
    let handle = &mut *tunnel;
    handle.drained.clear();
    while handle.drained.len() < max as usize {
        match handle.tunnel.poll_event() {
            Some(event) => handle.drained.push(event),
            None => break,
        }
    }
    // Reuse the descriptor buffer across drains so a steady stream does not
    // allocate a fresh `Vec` per drain.
    handle.descriptors.clear();
    let required = handle.drained.len() * 4;
    if handle.descriptors.capacity() < required {
        handle
            .descriptors
            .reserve(required - handle.descriptors.capacity());
    }
    for event in &handle.drained {
        let (kind, ptr, len, aux) = match event {
            Event::SendDatagram(bytes) => {
                (EVENT_DATAGRAM, bytes.as_ptr() as u32, bytes.len() as u32, 0)
            }
            Event::Opened => (EVENT_OPENED, 0, 0, 0),
            Event::Message(bytes) => (EVENT_MESSAGE, bytes.as_ptr() as u32, bytes.len() as u32, 0),
            Event::Closed(reason) => (EVENT_CLOSED, 0, 0, close_reason_code(reason.clone())),
        };
        handle.descriptors.extend_from_slice(&[kind, ptr, len, aux]);
    }
    (handle.descriptors.len() / 4) as u32
}

/// Pointer to the descriptor array produced by [`rtc_tunnel_drain_events`].
///
/// Four u32 per event. Valid until the next drain.
///
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns
/// null).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_events_ptr(tunnel: *mut TunnelHandle) -> *const u32 {
    if tunnel.is_null() {
        return ptr::null();
    }
    (*tunnel).descriptors.as_ptr()
}

/// Bytes currently waiting in the data channel send buffer.
///
/// Exposes the channel's outstanding byte count, so a host can watch queue
/// depth under load. Zero before the channel opens.
///
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns 0).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_buffered_bytes(tunnel: *mut TunnelHandle) -> f64 {
    if tunnel.is_null() {
        return 0.0;
    }
    (*tunnel).tunnel.buffered_bytes() as f64
}

/// Millisecond reading on the input clock when a handshake stage was first seen.
///
/// `stage` is 0 start, 1 ICE, 2 DTLS, 3 SCTP, 4 channel open. Returns -1 when
/// the stage has not happened or the stage index is unknown.
///
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns -1).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_stage_ms(tunnel: *mut TunnelHandle, stage: u32) -> f64 {
    if tunnel.is_null() {
        return -1.0;
    }
    let trace = (*tunnel).tunnel.handshake_trace();
    let value = match stage {
        0 => Some(trace.start_ms()),
        1 => trace.ice_ms(),
        2 => trace.dtls_ms(),
        3 => trace.sctp_ms(),
        4 => trace.opened_ms(),
        _ => None,
    };
    value.map(|ms| ms as f64).unwrap_or(-1.0)
}

/// Length of the negotiated DTLS cipher suite name, zero when none is known.
///
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null (a null returns 0).
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_cipher_len(tunnel: *mut TunnelHandle) -> usize {
    if tunnel.is_null() {
        return 0;
    }
    (*tunnel).cipher_name().map(|s| s.len()).unwrap_or(0)
}

/// Copies the negotiated DTLS cipher suite name into `buf`, returning bytes
/// written. Zero when the handshake has not selected a suite yet.
///
/// # Safety
///
/// `tunnel` must come from [`rtc_tunnel_create`], or be null. `buf` must point
/// to `cap` writable bytes, or be null with `cap` zero.
#[no_mangle]
pub unsafe extern "C" fn rtc_tunnel_cipher_copy(
    tunnel: *mut TunnelHandle,
    buf: *mut u8,
    cap: usize,
) -> usize {
    if tunnel.is_null() || buf.is_null() {
        return 0;
    }
    let Some(name) = (*tunnel).cipher_name() else {
        return 0;
    };
    let n = name.len().min(cap);
    ptr::copy_nonoverlapping(name.as_ptr(), buf, n);
    n
}
