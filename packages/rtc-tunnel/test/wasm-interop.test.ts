import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createNodeRuntime } from "../src/runtime/node.ts";
import { createRelayTransportProvider } from "../src/driver.ts";
import { WasmTunnelEngine } from "../src/engine/wasm.ts";
import type { TunnelEngine, TunnelEngineConfig } from "../src/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

// RTC_TUNNEL_WASM selects a specific artifact, for testing a build without
// overwriting the canonical output.
const wasmPath =
  process.env.RTC_TUNNEL_WASM ??
  join(root, "target/wasm32-unknown-unknown/release/rtc_tunnel_wasm.wasm");
const refpeerPath = join(root, "target/debug/rtc-tunnel-refpeer");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface RunningRefpeer {
  child: ChildProcessWithoutNullStreams;
  port: number;
}

function startRefpeer(bind: string): Promise<RunningRefpeer> {
  return new Promise((resolve, reject) => {
    const child = spawn(refpeerPath, [
      "--bind",
      bind,
      "--ufrag",
      "refufrag",
      "--pwd",
      "refpwdrefpwdrefpwdrefpwd",
      "--lifetime-ms",
      "30000",
    ]);
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /READY (\d+)/.exec(buffer);
      if (match) {
        child.stdout.off("data", onData);
        resolve({ child, port: Number(match[1]) });
      }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
  });
}

async function interop(address: string, wasmBytes: Uint8Array): Promise<void> {
  const refpeer = await startRefpeer(address === "::1" ? "[::1]:0" : `${address}:0`);

  let handle: { send(data: Uint8Array): void; close(): void } | null = null;
  try {
    const runtime = createNodeRuntime(async (config: TunnelEngineConfig): Promise<TunnelEngine> => {
      const engine = await WasmTunnelEngine.create(config, wasmBytes);
      const offer = engine.offerSdp();
      assert.ok(offer && offer.includes("m=application"), "engine must produce an SDP offer");
      refpeer.child.stdin.write(offer);
      refpeer.child.stdin.end();
      return engine;
    });

    const packets: Uint8Array[] = [];
    let opened = false;
    let closed: string | undefined;

    const provider = createRelayTransportProvider(runtime, {
      insecureSkipFingerprintVerification: true,
    });
    handle = await provider.createRelayConnection(
      {
        address,
        port: refpeer.port,
        iceUfrag: "refufrag",
        icePwd: "refpwdrefpwdrefpwdrefpwd",
        fingerprint:
          "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
        handshakeTimeoutMs: 20000,
      },
      {
        onOpen: () => {
          opened = true;
        },
        onPacket: (data) => packets.push(data),
        onClose: (reason) => {
          closed = reason;
        },
      },
    );

    const deadline = Date.now() + 20000;
    while (!opened && closed === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(closed, undefined, `tunnel closed during handshake: ${closed}`);
    assert.ok(opened, "tunnel never opened");

    handle.send(new TextEncoder().encode("wasm-to-native"));
    const echoDeadline = Date.now() + 10000;
    while (packets.length === 0 && Date.now() < echoDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(packets.length, 1, "expected one echoed packet");
    assert.equal(new TextDecoder().decode(packets[0]!), "wasm-to-native");
  } finally {
    handle?.close();
    refpeer.child.kill();
    refpeer.child.stdin.destroy();
  }
}

test(
  "wasm tunnel completes a handshake and exchanges messages with a native peer",
  { timeout: 40000 },
  async () => {
    if (!(await exists(wasmPath)) || !(await exists(refpeerPath))) {
      throw new Error(
        `missing artifacts:\n  ${wasmPath}\n  ${refpeerPath}\n` +
          "build with: cargo build --release -p rtc-tunnel-wasm --target wasm32-unknown-unknown && cargo build -p rtc-tunnel-refpeer",
      );
    }

    const wasmBytes = await readFile(wasmPath);
    await interop("127.0.0.1", wasmBytes);
  },
);

test("wasm tunnel completes a handshake over ipv6", { timeout: 40000 }, async () => {
  if (!(await exists(wasmPath)) || !(await exists(refpeerPath))) {
    throw new Error("build the wasm artifact and rtc-tunnel-refpeer first");
  }

  const wasmBytes = await readFile(wasmPath);
  await interop("::1", wasmBytes);
});
