import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRelayParams } from "../src/validate.ts";

const valid = {
  address: "203.0.113.7",
  port: 3478,
  iceUfrag: "ufrag",
  icePwd: "pwd",
  fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
};

test("accepts well formed params", () => {
  assert.doesNotThrow(() => validateRelayParams(valid));
});

test("rejects a port outside 1..65535", () => {
  assert.throws(() => validateRelayParams({ ...valid, port: 0 }), /port/);
  assert.throws(() => validateRelayParams({ ...valid, port: 65536 }), /port/);
  assert.throws(() => validateRelayParams({ ...valid, port: 1.5 }), /port/);
});

test("rejects a malformed fingerprint", () => {
  assert.throws(() => validateRelayParams({ ...valid, fingerprint: "aa:bb" }), /fingerprint/);
});

test("rejects an unsupported fingerprint algorithm", () => {
  assert.throws(
    () => validateRelayParams({ ...valid, fingerprintAlgorithm: "sha-1" }),
    /fingerprintAlgorithm/,
  );
});

test("rejects empty credentials", () => {
  assert.throws(() => validateRelayParams({ ...valid, iceUfrag: "" }), /iceUfrag/);
  assert.throws(() => validateRelayParams({ ...valid, icePwd: "" }), /icePwd/);
});

test("rejects out of range sctpPort, streamId and maxRetransmits", () => {
  assert.throws(() => validateRelayParams({ ...valid, sctpPort: 0 }), /sctpPort/);
  assert.throws(() => validateRelayParams({ ...valid, streamId: 65535 }), /streamId/);
  assert.throws(() => validateRelayParams({ ...valid, maxRetransmits: 70000 }), /maxRetransmits/);
});

test("rejects a non positive handshake timeout", () => {
  assert.throws(() => validateRelayParams({ ...valid, handshakeTimeoutMs: 0 }), /handshakeTimeoutMs/);
  assert.throws(
    () => validateRelayParams({ ...valid, handshakeTimeoutMs: Number.POSITIVE_INFINITY }),
    /handshakeTimeoutMs/,
  );
});
