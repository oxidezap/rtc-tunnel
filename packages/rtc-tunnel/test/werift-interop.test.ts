import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Independent interoperability: `werift`, a separate WebRTC implementation,
 * offers to the Rust tunnel. werift offers `actpass` and the tunnel answers
 * `active`, so the tunnel is the DTLS and SCTP initiator.
 *
 * The native reference peer in the other interop test uses the same `rtc` crate
 * as the tunnel, so a shared bug could hide there. This test would not.
 *
 * Skipped when werift or the answerer binary is absent, so the suite still
 * runs without extra installs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const answererPath = join(root, "target/debug/rtc-tunnel-answerer");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** First non-internal IPv4 on this host, or loopback if there is none. */
function localIpv4(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

interface Answerer {
  child: ChildProcessWithoutNullStreams;
  waitFor(prefix: string, timeoutMs: number): Promise<string>;
}

function startAnswerer(bindIp: string): Answerer {
  const child = spawn(answererPath, ["--bind", `${bindIp}:0`, "--lifetime-ms", "30000"]);
  let buffer = "";
  const lines: string[] = [];
  const waiters: Array<{ prefix: string; resolve: (line: string) => void }> = [];

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(line);
      const waiterIndex = waiters.findIndex((w) => line.startsWith(w.prefix));
      if (waiterIndex !== -1) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        waiter!.resolve(line);
      }
    }
  });

  return {
    child,
    waitFor(prefix, timeoutMs) {
      const existing = lines.find((l) => l.startsWith(prefix));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for '${prefix}'`)),
          timeoutMs,
        );
        waiters.push({
          prefix,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
  };
}

test("rust tunnel interoperates with werift", { timeout: 40000 }, async (t) => {
  if (!(await exists(answererPath))) {
    t.skip("rtc-tunnel-answerer not built");
    return;
  }
  let werift: typeof import("werift");
  try {
    werift = await import("werift");
  } catch {
    t.skip("werift not installed");
    return;
  }

  const bindIp = localIpv4();
  const answerer = startAnswerer(bindIp);
  let pc: InstanceType<typeof werift.RTCPeerConnection> | undefined;
  try {
    pc = new werift.RTCPeerConnection({ iceServers: [], iceUseIpv6: false });

    const channel = pc.createDataChannel("relay", {
      negotiated: true,
      id: 0,
      ordered: false,
      maxRetransmits: 0,
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise<void>((resolve) => {
      if (pc!.iceGatheringState === "complete") return resolve();
      const timer = setTimeout(resolve, 5000);
      pc!.iceGatheringStateChange.subscribe((state: string) => {
        if (state === "complete") {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const offerSdp = pc.localDescription?.sdp;
    assert.ok(offerSdp && offerSdp.includes("a=candidate:"), "werift offer has a candidate");
    answerer.child.stdin.write(`OFFER ${Buffer.from(offerSdp).toString("base64")}\n`);

    const answerLine = await answerer.waitFor("ANSWER ", 10000);
    const answerSdp = Buffer.from(answerLine.slice("ANSWER ".length), "base64").toString("utf8");
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("data channel never opened")), 15000);
      if (channel.readyState === "open") {
        clearTimeout(timer);
        resolve();
        return;
      }
      channel.stateChanged.subscribe((state: string) => {
        if (state === "open") {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const received: Buffer[] = [];
    channel.onMessage.subscribe((data: string | Buffer) => {
      received.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    channel.send(Buffer.from("werift-to-tunnel"));

    const deadline = Date.now() + 10000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(received.length, 1, "expected the echoed message");
    assert.equal(received[0]!.toString("utf8"), "werift-to-tunnel");
  } finally {
    await pc?.close().catch(() => {});
    answerer.child.kill();
    answerer.child.stdin.destroy();
  }
});
