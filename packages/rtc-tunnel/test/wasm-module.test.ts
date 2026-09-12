import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { WasmTunnelModule } from "../src/engine/wasm.ts";
import { SEND_NOT_OPEN, type TunnelEngineConfig } from "../src/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(
  here,
  "..",
  "..",
  "..",
  "target/wasm32-unknown-unknown/release/rtc_tunnel_wasm.wasm",
);

function config(localPort: number): TunnelEngineConfig {
  return {
    remoteAddress: "127.0.0.1",
    remotePort: 40000,
    localAddress: "127.0.0.1",
    localPort,
    iceUfrag: "u",
    icePwd: "p",
    fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
    fingerprintAlgorithm: "sha-256",
    sctpPort: 5000,
    streamId: 0,
    ordered: false,
    maxRetransmits: 0,
    handshakeTimeoutMs: 1000,
    disableFingerprintVerification: true,
    nowMs: 0,
  };
}

test("one module instance hosts many independent tunnels", async () => {
  const bytes = await readFile(wasmPath);
  const module = await WasmTunnelModule.load(bytes);

  const first = module.createTunnel(config(41000));
  const second = module.createTunnel(config(41001));

  // Both produced their own offer and neither is open yet.
  assert.ok(first.offerSdp()?.includes("m=application"));
  assert.ok(second.offerSdp()?.includes("m=application"));
  assert.equal(first.isOpen(), false);
  assert.equal(second.isOpen(), false);
  assert.equal(first.send(new Uint8Array([1])), SEND_NOT_OPEN);

  // Disposing one must not disturb the other.
  first.dispose();
  first.dispose();
  assert.ok(second.offerSdp()?.includes("m=application"));

  second.dispose();
});

test("module reports why a configuration was rejected", async () => {
  const bytes = await readFile(wasmPath);
  const module = await WasmTunnelModule.load(bytes);
  const bad = { ...config(0), localAddress: "not-an-address" };
  assert.throws(() => module.createTunnel(bad), /local must be an ip:port string/);
});
