import type { RelayConnectionParams } from "./provider.ts";

const SHA256_FINGERPRINT = /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/;

function isInteger(value: number): boolean {
  return Number.isInteger(value);
}

/**
 * Validates public relay parameters before they reach the wasm ABI.
 *
 * JavaScript numbers cross into WebAssembly as i32/u32 and silently wrap, so an
 * out-of-range port or retransmit count would otherwise become a different
 * value on the other side.
 */
export function validateRelayParams(params: RelayConnectionParams): void {
  if (typeof params.address !== "string" || params.address.length === 0) {
    throw new TypeError("relay address must be a non-empty string");
  }
  if (!isInteger(params.port) || params.port < 1 || params.port > 65535) {
    throw new RangeError(`relay port must be an integer in 1..=65535, got ${params.port}`);
  }
  if (params.iceUfrag.length === 0) {
    throw new TypeError("iceUfrag must be non-empty");
  }
  if (params.icePwd.length === 0) {
    throw new TypeError("icePwd must be non-empty");
  }
  if (!SHA256_FINGERPRINT.test(params.fingerprint.toLowerCase())) {
    throw new TypeError("fingerprint must be 32 colon-separated hex SHA-256 bytes");
  }
  const algorithm = params.fingerprintAlgorithm ?? "sha-256";
  if (algorithm !== "sha-256") {
    throw new TypeError(`fingerprintAlgorithm must be 'sha-256', got '${algorithm}'`);
  }
  if (params.sctpPort !== undefined && (!isInteger(params.sctpPort) || params.sctpPort < 1 || params.sctpPort > 65535)) {
    throw new RangeError(`sctpPort must be an integer in 1..=65535, got ${params.sctpPort}`);
  }
  if (params.streamId !== undefined && (!isInteger(params.streamId) || params.streamId < 0 || params.streamId > 65534)) {
    throw new RangeError(`streamId must be an integer in 0..=65534, got ${params.streamId}`);
  }
  if (params.maxRetransmits !== undefined && (!isInteger(params.maxRetransmits) || params.maxRetransmits < 0 || params.maxRetransmits > 65535)) {
    throw new RangeError(`maxRetransmits must be an integer in 0..=65535, got ${params.maxRetransmits}`);
  }
  if (params.handshakeTimeoutMs !== undefined && (!Number.isFinite(params.handshakeTimeoutMs) || params.handshakeTimeoutMs <= 0)) {
    throw new RangeError(`handshakeTimeoutMs must be a finite number > 0, got ${params.handshakeTimeoutMs}`);
  }
}
