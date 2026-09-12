import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRelayTransportProvider,
  type TunnelRuntime,
  type UdpEndpoint,
} from "../src/driver.ts";
import { FakeTunnelEngine } from "../test-support/fake.ts";
import type { TunnelEngine, TunnelEngineConfig } from "../src/engine.ts";

class TestEndpoint implements UdpEndpoint {
  readonly sent: Uint8Array[] = [];
  readonly localAddress = "127.0.0.1";
  readonly localPort = 40000;
  closed = false;
  #message: ((data: Uint8Array) => void) | null = null;

  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  onMessage(handler: (data: Uint8Array) => void): void {
    this.#message = handler;
  }
  onError(): void {}
  close(): void {
    this.closed = true;
  }
  receive(data: Uint8Array): void {
    this.#message?.(data);
  }
}

interface Harness {
  runtime: TunnelRuntime;
  endpoint: TestEndpoint;
  engine(): FakeTunnelEngine;
}

function makeRuntime(): Harness {
  const endpoint = new TestEndpoint();
  let engine: FakeTunnelEngine | null = null;
  const runtime: TunnelRuntime = {
    now: () => 0,
    // Timers never fire in these tests; every pump is driven explicitly by a
    // datagram so the handshake cannot advance on a hidden clock.
    setTimer: () => () => {},
    bind: () => Promise.resolve(endpoint),
    createEngine: (config: TunnelEngineConfig): TunnelEngine => {
      engine = new FakeTunnelEngine(config);
      return engine;
    },
  };
  return { runtime, endpoint, engine: () => engine! };
}

const params = {
  address: "203.0.113.7",
  port: 3478,
  iceUfrag: "ufrag",
  icePwd: "pwd",
  fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
};

/** Lets `bind` and `createEngine` settle without advancing any tunnel state. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("createRelayConnection resolves only after the channel opens", async () => {
  const { runtime, endpoint, engine } = makeRuntime();
  const provider = createRelayTransportProvider(runtime);
  let opened = 0;

  const pending = provider.createRelayConnection(params, {
    onOpen: () => opened++,
    onPacket: () => {},
    onClose: () => {},
  });

  await settle();
  assert.equal(engine().isOpen(), false);

  engine().open();
  endpoint.receive(new Uint8Array([0]));
  const handle = await pending;

  assert.equal(opened, 1);
  handle.send(new Uint8Array([4, 5]));
  assert.equal(engine().sent.length, 1);
});

test("createRelayConnection rejects when the tunnel closes before opening", async () => {
  const { runtime, endpoint, engine } = makeRuntime();
  const provider = createRelayTransportProvider(runtime);
  let closeCalls = 0;

  const pending = provider.createRelayConnection(params, {
    onOpen: () => {},
    onPacket: () => {},
    onClose: () => {
      closeCalls++;
    },
  });

  await settle();
  engine().remoteClose(2);
  endpoint.receive(new Uint8Array([0]));

  await assert.rejects(pending, /closed before opening: timeout/);
  // The channel never opened, so onOpen/onClose stay balanced and the failure
  // is reported only through the rejected promise.
  assert.equal(closeCalls, 0);
  assert.equal(endpoint.closed, true);
});

test("provider surfaces open, packets and outgoing datagrams", async () => {
  const { runtime, endpoint, engine } = makeRuntime();
  // `off` keeps input synchronous so the assertions below are deterministic.
  const provider = createRelayTransportProvider(runtime, { inputBatch: "off" });
  const packets: Uint8Array[] = [];
  let closed: string | undefined;

  const pending = provider.createRelayConnection(params, {
    onOpen: () => {},
    onPacket: (data) => packets.push(data),
    onClose: (reason) => (closed = reason),
  });
  await settle();
  engine().open();
  endpoint.receive(new Uint8Array([0]));
  const handle = await pending;

  engine().deliver(new Uint8Array([1, 2, 3]));
  endpoint.receive(new Uint8Array([9, 9]));

  assert.equal(packets.length, 1);
  assert.deepEqual([...packets[0]!], [1, 2, 3]);

  handle.close();
  assert.equal(closed, "local");
  assert.equal(endpoint.closed, true);
});

test("outgoing datagrams reach the endpoint", async () => {
  const { runtime, endpoint, engine } = makeRuntime();
  // `sendBatch: off` drains synchronously so the assertion is deterministic.
  const provider = createRelayTransportProvider(runtime, { sendBatch: "off" });

  const pending = provider.createRelayConnection(params, {
    onOpen: () => {},
    onPacket: () => {},
    onClose: () => {},
  });
  await settle();
  engine().open();
  endpoint.receive(new Uint8Array([0]));
  const handle = await pending;

  handle.send(new Uint8Array([7, 7]));
  assert.equal(endpoint.sent.length, 1);
  assert.deepEqual([...endpoint.sent[0]!], [7, 7]);
});

test("batched send drains every queued message on the next turn", async () => {
  const { runtime, endpoint, engine } = makeRuntime();
  // The default coalesces the host-side drain. The engine still receives every
  // send immediately, so ordering and backpressure are unchanged, and all
  // output datagrams must appear by the next event-loop turn.
  const provider = createRelayTransportProvider(runtime);

  const pending = provider.createRelayConnection(params, {
    onOpen: () => {},
    onPacket: () => {},
    onClose: () => {},
  });
  await settle();
  engine().open();
  endpoint.receive(new Uint8Array([0]));
  const handle = await pending;

  handle.send(new Uint8Array([1]));
  handle.send(new Uint8Array([2]));
  handle.send(new Uint8Array([3]));
  assert.equal(engine().sent.length, 3);

  await settle();
  assert.equal(endpoint.sent.length, 3);
  assert.deepEqual(
    endpoint.sent.map((d) => [...d]),
    [[1], [2], [3]],
  );

  handle.close();
});

test("batched input delivers every datagram before the flush settles", async () => {
  const { runtime, endpoint, engine } = makeRuntime();
  // The default batches input to the engine in one event-loop turn. Every
  // datagram received in that turn must still reach the engine, in order.
  const provider = createRelayTransportProvider(runtime);
  const packets: Uint8Array[] = [];

  const pending = provider.createRelayConnection(params, {
    onOpen: () => {},
    onPacket: (data) => packets.push(data),
    onClose: () => {},
  });
  await settle();
  engine().open();
  endpoint.receive(new Uint8Array([0]));
  const handle = await pending;

  endpoint.receive(new Uint8Array([1]));
  endpoint.receive(new Uint8Array([2]));
  endpoint.receive(new Uint8Array([3]));
  // No flush has run yet in this synchronous turn.
  assert.equal(engine().inputs.length, 1);

  await settle();
  assert.equal(engine().inputs.length, 4);
  assert.deepEqual(
    engine()
      .inputs.slice(1)
      .map((d) => [...d]),
    [[1], [2], [3]],
  );

  handle.close();
});

test("drop policy discards on backpressure", async () => {
  const { runtime, endpoint, engine } = makeRuntime();
  const provider = createRelayTransportProvider(runtime, { backpressure: "drop" });

  const pending = provider.createRelayConnection(params, {
    onOpen: () => {},
    onPacket: () => {},
    onClose: () => {},
  });
  await settle();
  engine().open();
  endpoint.receive(new Uint8Array([0]));
  const handle = await pending;

  engine().setSendBufferCap(0);
  handle.send(new Uint8Array([1, 2]));
  assert.equal(engine().sent.length, 0);
  assert.equal(endpoint.sent.length, 0);
});

test("queue policy holds then flushes on backpressure", async () => {
  const { runtime, endpoint, engine } = makeRuntime();
  const provider = createRelayTransportProvider(runtime, {
    backpressure: "queue",
    maxQueuedBytes: 1024,
    inputBatch: "off",
  });

  const pending = provider.createRelayConnection(params, {
    onOpen: () => {},
    onPacket: () => {},
    onClose: () => {},
  });
  await settle();
  engine().open();
  endpoint.receive(new Uint8Array([0]));
  const handle = await pending;

  engine().setSendBufferCap(0);
  handle.send(new Uint8Array([1, 2]));
  assert.equal(engine().sent.length, 0);

  engine().setSendBufferCap(1024);
  endpoint.receive(new Uint8Array([0]));
  assert.equal(engine().sent.length, 1);
  assert.deepEqual([...engine().sent[0]!], [1, 2]);
});

test("engine is disposed exactly once when the tunnel closes", async () => {
  const { runtime, endpoint, engine } = makeRuntime();
  const provider = createRelayTransportProvider(runtime);

  const pending = provider.createRelayConnection(params, {
    onOpen: () => {},
    onPacket: () => {},
    onClose: () => {},
  });
  await settle();
  engine().open();
  endpoint.receive(new Uint8Array([0]));
  const handle = await pending;

  assert.equal(engine().disposed, false);
  handle.close();
  assert.equal(engine().disposed, true);
  // A second close must not touch the engine again.
  const afterFirst = engine().disposed;
  handle.close();
  assert.equal(engine().disposed, afterFirst);
});

test("endpoint is closed when engine creation fails", async () => {
  const endpoint = new TestEndpoint();
  const runtime: TunnelRuntime = {
    now: () => 0,
    setTimer: () => () => {},
    bind: () => Promise.resolve(endpoint),
    createEngine: () => {
      throw new Error("wasm rejected the module");
    },
  };
  const provider = createRelayTransportProvider(runtime);

  await assert.rejects(
    provider.createRelayConnection(params, {
      onOpen: () => {},
      onPacket: () => {},
      onClose: () => {},
    }),
    /wasm rejected the module/,
  );
  assert.equal(endpoint.closed, true, "socket must not leak when engine creation throws");
});
