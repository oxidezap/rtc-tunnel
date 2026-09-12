import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocket, type SocketType } from "node:dgram";

import { createNodeRuntime } from "../src/runtime/node.ts";
import { createRelayTransportProvider } from "../src/driver.ts";
import { FakeTunnelEngine } from "../test-support/fake.ts";
import type { TunnelEngine, TunnelEngineConfig } from "../src/engine.ts";

async function roundTrip(type: SocketType, address: string): Promise<void> {
  let server: ReturnType<typeof createSocket>;
  try {
    server = createSocket(type);
  } catch {
    return; // address family unavailable on this host
  }
  const received: Uint8Array[] = [];
  let clientPort = 0;
  let clientAddress = "";
  server.on("message", (msg, info) => {
    received.push(new Uint8Array(msg));
    clientPort = info.port;
    clientAddress = info.address;
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.bind(0, address, () => resolve());
  });
  const serverPort = server.address().port;

  let engine: FakeTunnelEngine | null = null;
  const runtime = createNodeRuntime((config: TunnelEngineConfig): TunnelEngine => {
    engine = new FakeTunnelEngine(config, { openImmediately: true });
    return engine;
  });

  const provider = createRelayTransportProvider(runtime);
  const handle = await provider.createRelayConnection(
    {
      address,
      port: serverPort,
      iceUfrag: "ufrag",
      icePwd: "pwd",
      fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
    },
    { onOpen: () => {}, onPacket: () => {}, onClose: () => {} },
  );

  handle.send(new Uint8Array([1, 2, 3]));
  const deadline = Date.now() + 2000;
  while (received.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(received.length, 1);
  assert.deepEqual([...received[0]!], [1, 2, 3]);

  server.send(new Uint8Array([9, 9, 9]), clientPort, clientAddress);
  const inboundDeadline = Date.now() + 2000;
  while (engine!.inputs.length === 0 && Date.now() < inboundDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(engine!.inputs.length, 1);
  assert.deepEqual([...engine!.inputs[0]!], [9, 9, 9]);

  handle.close();
  server.close();
}

test("node runtime moves datagrams over udp4", async () => {
  await roundTrip("udp4", "127.0.0.1");
});

test("node runtime moves datagrams over udp6", async () => {
  await roundTrip("udp6", "::1");
});
