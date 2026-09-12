import { test } from "node:test";
import assert from "node:assert/strict";

import { createBrowserRelayProvider } from "../src/browser.ts";

const params = {
  address: "203.0.113.7",
  port: 3478,
  iceUfrag: "ufrag",
  icePwd: "pwd",
  fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
  handshakeTimeoutMs: 5000,
};

class FakeDataChannel {
  readyState = "connecting";
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Uint8Array[] = [];
  closed = false;
  send(data: ArrayBufferView<ArrayBuffer>) {
    this.sent.push(new Uint8Array(data.buffer));
  }
  close() {
    this.closed = true;
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
}

class FakePeerConnection {
  static last: FakePeerConnection;
  connectionState = "connecting";
  onconnectionstatechange: (() => void) | null = null;
  channel: FakeDataChannel;
  closed = false;
  constructor(_config: unknown) {
    FakePeerConnection.last = this;
    this.channel = new FakeDataChannel();
  }
  createDataChannel(): FakeDataChannel {
    return this.channel;
  }
  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "v=0" });
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  setRemoteDescription() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

function install(): void {
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePeerConnection;
}

test("browser provider resolves only once the channel is open", async () => {
  install();
  const provider = createBrowserRelayProvider();
  const pending = provider.createRelayConnection(params, {
    onOpen: () => {},
    onPacket: () => {},
    onClose: () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  const channel = FakePeerConnection.last.channel;
  assert.equal(channel.readyState, "connecting");

  channel.open();
  const handle = await pending;
  handle.send(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...channel.sent[0]!], [1, 2, 3]);
});

test("browser provider rejects when the channel fails before opening", async () => {
  install();
  const provider = createBrowserRelayProvider();
  const pending = provider.createRelayConnection(params, {
    onOpen: () => {},
    onPacket: () => {},
    onClose: () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  FakePeerConnection.last.connectionState = "failed";
  FakePeerConnection.last.onconnectionstatechange?.();

  await assert.rejects(pending, /closed before opening: failed/);
});

test("browser provider reports close exactly once", async () => {
  install();
  const provider = createBrowserRelayProvider();
  const closures: Array<string | undefined> = [];
  const pending = provider.createRelayConnection(params, {
    onOpen: () => {},
    onPacket: () => {},
    onClose: (reason) => closures.push(reason),
  });

  await new Promise((resolve) => setImmediate(resolve));
  const pc = FakePeerConnection.last;
  pc.channel.open();
  const handle = await pending;

  handle.close();
  pc.channel.onclose?.();
  pc.connectionState = "disconnected";
  pc.onconnectionstatechange?.();

  assert.deepEqual(closures, ["local"]);
});
