/**
 * Control channel to the neutral Pion benchmark peer.
 *
 * The peer runs in its own process and speaks a line protocol. It emits READY
 * at startup with static ICE credentials and its bound port, because a
 * relay-path device under test has to synthesize its remote answer before it
 * can produce an offer. Every DUT then offers, and the peer answers.
 *
 * Spawning is kept separate from the measured handshake: callers time only the
 * connection work, never `startPeer`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");
const peerBinary = join(repoRoot, "target/bench-peer");
export const wasmPath = join(
  repoRoot,
  "target/wasm32-unknown-unknown/release/rtc_tunnel_wasm.wasm",
);

export interface PeerReady {
  host: string;
  port: number;
  ufrag: string;
  pwd: string;
}

export interface PeerSession {
  ready: PeerReady;
  /** Sends an offer without waiting for the answer, for relay-path DUTs. */
  sendOffer(offerSdp: string): void;
  /** Sends an offer and resolves with the peer's answer SDP. */
  exchange(offerSdp: string): Promise<string>;
  /** Messages the peer has echoed (echo mode) or consumed (sink mode). */
  count(): Promise<number>;
  close(): void;
}

/** Picks the interface every process should share. Override with BENCH_HOST. */
export function benchHost(): string {
  const override = process.env.BENCH_HOST;
  if (override) return override;
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

class LineChannel {
  #pending = new Map<string, (line: string) => void>();
  #buffer: Array<{ kind: string; line: string }> = [];

  constructor(stream: NodeJS.ReadableStream) {
    createInterface({ input: stream }).on("line", (line) => {
      const kind = line.split(" ")[0] ?? line;
      const waiter = this.#pending.get(kind);
      if (waiter) {
        this.#pending.delete(kind);
        waiter(line);
      } else {
        this.#buffer.push({ kind, line });
      }
    });
  }

  wait(kind: string): Promise<string> {
    const index = this.#buffer.findIndex((entry) => entry.kind === kind);
    if (index !== -1) return Promise.resolve(this.#buffer.splice(index, 1)[0]!.line);
    return new Promise((resolve) => this.#pending.set(kind, resolve));
  }
}

export async function startPeer(
  options: {
    host?: string;
    lifetimeMs?: number;
    mode?: "echo" | "sink" | "source";
    rate?: number;
    payloadBytes?: number;
  } = {},
): Promise<PeerSession> {
  const host = options.host ?? benchHost();
  const lifetimeMs = options.lifetimeMs ?? 120_000;
  const args = ["--host", host, "--lifetime", `${lifetimeMs}ms`];
  if (options.mode) args.push("--mode", options.mode);
  if (options.rate !== undefined) args.push("--rate", String(options.rate));
  if (options.payloadBytes !== undefined) args.push("--payload", String(options.payloadBytes));
  const loss = process.env.BENCH_LOSS;
  const jitter = process.env.BENCH_JITTER_MS;
  const reorder = process.env.BENCH_REORDER;
  if (loss) args.push("--loss", loss);
  if (jitter) args.push("--jitter-ms", jitter);
  if (reorder) args.push("--reorder", reorder);
  // BENCH_PEER_CPUS pins the peer to its own cores so it does not contend with
  // the DUT. Only used when set, and only when taskset is available.
  const cpus = process.env.BENCH_PEER_CPUS;
  const child = (
    cpus
      ? spawn("taskset", ["-c", cpus, peerBinary, ...args], { stdio: ["pipe", "pipe", "pipe"] })
      : spawn(peerBinary, args, { stdio: ["pipe", "pipe", "pipe"] })
  ) as ChildProcessWithoutNullStreams;
  const channel = new LineChannel(child.stdout);
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[peer] ${chunk}`);
  });

  const readyLine = await channel.wait("READY");
  const [, peerHost, port, ufrag, pwd] = readyLine.split(" ");
  const ready: PeerReady = {
    host: peerHost!,
    port: Number(port),
    ufrag: ufrag!,
    pwd: pwd!,
  };

  let closed = false;
  return {
    ready,
    sendOffer(offerSdp: string): void {
      child.stdin.write(`OFFER ${Buffer.from(offerSdp).toString("base64")}\n`);
    },
    async exchange(offerSdp: string): Promise<string> {
      child.stdin.write(`OFFER ${Buffer.from(offerSdp).toString("base64")}\n`);
      const line = await channel.wait("ANSWER");
      return Buffer.from(line.slice("ANSWER ".length), "base64").toString();
    },
    count(): Promise<number> {
      child.stdin.write("STATS\n");
      return channel.wait("COUNT").then((line) => Number(line.slice("COUNT ".length)));
    },
    close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      child.kill();
    },
  };
}
