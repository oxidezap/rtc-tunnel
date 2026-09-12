#!/usr/bin/env node
// Renders the benchmark report as GitHub-flavoured markdown.
//
// The runner writes `target/bench-report.json`, the environment probe writes
// `target/bench-env.json`, and the paired comparison and impairment suites
// write plain text beside them. The paired suite ends with a `STATS_JSON`
// line and the impairment suite with a JSON line, so the summary shows tables
// instead of raw logs; both fall back to the captured text when the machine
// line is missing. Appends to `$GITHUB_STEP_SUMMARY` when the workflow
// redirects it there, so the result shows up on the run page.
//
// Usage: node scripts/bench-summary.mjs [report.json] > summary.md

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const reportPath = process.argv[2] ?? "target/bench-report.json";
const dir = dirname(reportPath);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Collapses the `\r`-based progress lines the harness prints into the final
 * frame, so the captured stdout is readable in the summary.
 */
function normalize(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    const carriage = raw.split("\r");
    const last = carriage[carriage.length - 1].trimEnd();
    if (last.trim()) lines.push(last);
  }
  return lines.join("\n").trim();
}

/** Last non-empty `PREFIX {...}` line in captured text, parsed. */
function machineLine(text, prefix) {
  const line = text
    .split("\n")
    .map((raw) => {
      const parts = raw.split("\r");
      return parts[parts.length - 1].trim();
    })
    .filter((l) => l !== "")
    .findLast((l) => l.startsWith(prefix));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(prefix.length).trim());
  } catch {
    return null;
  }
}

function bytes(value) {
  if (value === undefined || value === null) return "-";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KiB`;
  return `${sign}${(abs / (1024 * 1024)).toFixed(1)} MiB`;
}

function ms(value) {
  return value === undefined || value === null ? "-" : `${Number(value).toFixed(2)} ms`;
}

function num(value) {
  return value === undefined || value === null ? "-" : Math.round(value).toLocaleString("en-US");
}

function str(value) {
  return value === undefined || value === null || value === "" ? "-" : String(value);
}

function cipher(name) {
  if (!name) return "-";
  if (name.includes("CHACHA20_POLY1305")) return "chacha20-poly1305";
  if (name.includes("AES_128_GCM")) return "aes128-gcm";
  if (name.includes("AES_256_GCM")) return "aes256-gcm";
  return name;
}

function table(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}`;
}

const lines = [];
lines.push("# Benchmark");
lines.push("");

const report = readJson(reportPath);
const env = readJson(join(dir, "bench-env.json"));
let found = false;

if (report) {
  found = true;
  const commit = env?.commit ? `, commit \`${env.commit.slice(0, 12)}\`` : "";
  lines.push(`Generated ${report.generatedAt} on interface \`${report.host}\`${commit}.`);
  lines.push("");
}

if (env) {
  lines.push("## Environment");
  lines.push("");
  lines.push(
    table(
      ["fact", "value"],
      [
        ["os", str(env.runnerOs ?? env.platform)],
        ["image", str(env.imageVersion)],
        ["kernel", str(env.kernel)],
        ["arch", str(env.arch)],
        ["cpu", str(env.cpuModel)],
        ["logical cpus", str(env.logicalCpus)],
        ["node", str(env.node)],
        ["npm", str(env.npm)],
        ["go", str(env.go)],
        ["rustc", str(env.rustc)],
        ["wasm-opt", str(env.wasmOpt)],
        ["wasm-tools", str(env.wasmTools)],
      ],
    ),
  );
  lines.push("");
}

if (report) {
  const metrics = report.metrics ?? [];
  lines.push("## Comparative");
  lines.push("");
  lines.push(
    "Shared runners are noisy; treat absolute numbers as informational and watch the paired ratios and trends.",
  );
  lines.push("");

  const fp = report.footprint ?? {};
  lines.push("### Artifact footprint");
  lines.push("");
  lines.push(
    table(
      ["artifact", "size"],
      [
        ["wasm raw", bytes(fp.wasmRawBytes)],
        ["wasm gzip", bytes(fp.wasmGzipBytes)],
        ["wasm brotli", bytes(fp.wasmBrotliBytes)],
        ["refpeer binary", bytes(fp.rustReleaseBinaryBytes)],
        ["pion peer binary", bytes(fp.peerBinaryBytes)],
      ],
    ),
  );
  lines.push("");

  lines.push("### Cold start");
  lines.push("");
  lines.push(
    table(
      ["backend", "state", "import", "compile", "instantiate"],
      metrics.map((m) => [
        m.name,
        m.available ? "ok" : "n/a",
        ms(m.cold?.importMs),
        ms(m.cold?.compileMs),
        ms(m.cold?.instantiateMs),
      ]),
    ),
  );
  lines.push("");

  lines.push("### Connection");
  lines.push("");
  lines.push(
    table(
      ["backend", "create to open p50", "p95", "samples", "open failures", "ice p50", "dtls p50", "sctp p50"],
      metrics.map((m) => [
        m.name,
        ms(m.createOpenMs?.p50),
        ms(m.createOpenMs?.p95),
        m.createOpenMs?.samples ?? "-",
        m.openFailures ?? "-",
        ms(m.stages?.iceMs),
        ms(m.stages?.dtlsMs),
        ms(m.stages?.sctpMs),
      ]),
    ),
  );
  lines.push("");

  lines.push("### Traffic");
  lines.push("");
  lines.push(
    table(
      ["backend", "rtt256 p50", "rtt256 p99", "msgs/s", "MiB/s", "window", "refused", "cipher"],
      metrics.map((m) => {
        const tp = m.throughput?.video ?? Object.values(m.throughput ?? {})[0];
        return [
          m.name,
          ms(m.rttByPayload?.["256"]?.p50),
          ms(m.rttByPayload?.["256"]?.p99),
          num(tp?.messagesPerSecond),
          tp ? (tp.bytesPerSecond / (1024 * 1024)).toFixed(2) : "-",
          tp?.window ?? "-",
          tp?.backpressure ?? "-",
          cipher(m.cipherSuite),
        ];
      }),
    ),
  );
  lines.push("");

  const withLifecycle = metrics.filter((m) => m.lifecycle || m.memory?.length);
  if (withLifecycle.length > 0) {
    lines.push("### Lifecycle");
    lines.push("");
    lines.push(
      table(
        ["backend", "cycles/s", "cycles", "rss growth", "final rss", "final pss", "peak rss"],
        withLifecycle.map((m) => [
          m.name,
          m.lifecycle ? m.lifecycle.perSecond.toFixed(1) : "-",
          m.lifecycle?.iterations ?? "-",
          m.lifecycle ? bytes(m.lifecycle.rssGrowthBytes) : "-",
          bytes(m.memory?.at(-1)?.rssBytes),
          bytes(m.memory?.at(-1)?.pssBytes),
          m.lifecycle ? bytes(m.lifecycle.peakRssBytes) : "-",
        ]),
      ),
    );
    lines.push("");
  }

  const boundary = metrics.filter((m) => m.boundary);
  if (boundary.length > 0) {
    lines.push("### Wasm boundary (per delivered message)");
    lines.push("");
    lines.push(
      table(
        ["backend", "crossings", "input", "send", "pollEvent", "allocs/1k"],
        boundary.map((m) => [
          m.name,
          m.boundary.crossingsPerMessage.toFixed(2),
          m.boundary.inputCallsPerMessage.toFixed(2),
          m.boundary.sendCallsPerMessage.toFixed(2),
          m.boundary.pollEventCallsPerMessage.toFixed(2),
          m.boundary.allocationsPer1kMessages.toFixed(2),
        ]),
      ),
    );
    lines.push("");
  }

  const burst = metrics.filter((m) => m.burst);
  if (burst.length > 0) {
    lines.push("### Keyframe burst (audio latency while a burst drains)");
    lines.push("");
    lines.push(
      table(
        ["backend", "burst kB", "drain ms", "max queued B", "refused", "audio base p50", "audio burst p50", "audio burst p99", "audio after p50"],
        burst.map((m) => [
          m.name,
          (m.burst.burstBytes / 1024).toFixed(0),
          m.burst.drainMs.toFixed(1),
          num(m.burst.maxBufferedBytes),
          num(m.burst.refusedSends),
          ms(m.burst.audioBaselineP50),
          ms(m.burst.audioDuringBurstP50),
          ms(m.burst.audioDuringBurstP99),
          ms(m.burst.audioAfterP50),
        ]),
      ),
    );
    lines.push("");
  }

  const cadence = metrics.filter((m) => m.cadence);
  if (cadence.length > 0) {
    lines.push("### Call cadence (50 audio/s + 300 video/s)");
    lines.push("");
    lines.push(
      table(
        ["backend", "delivered", "msg/s", "cpu ms/msg", "msg/cpu-s"],
        cadence.map((m) => [
          m.name,
          m.cadence.delivered,
          Math.round(m.cadence.messagesPerSecond),
          m.cadence.cpuMsPerMessage.toFixed(3),
          Math.round(m.cadence.messagesPerCpuSecond),
        ]),
      ),
    );
    lines.push("");
  }

  const notes = metrics.filter((m) => m.note);
  if (notes.length > 0) {
    lines.push("### Notes");
    lines.push("");
    for (const m of notes) lines.push(`- **${m.name}**: ${m.note}`);
    lines.push("");
  }
}

const statsText = readText(join(dir, "bench-stats.txt"));
if (statsText) {
  found = true;
  lines.push("## Paired rtc-tunnel vs wrtc");
  lines.push("");
  const stats = machineLine(statsText, "STATS_JSON ");
  if (stats) {
    const affinity = stats.affinity?.pinned
      ? `pinned (DUT ${stats.affinity.dut}, peer ${stats.affinity.peer ?? "any"})`
      : `unpinned (${stats.affinity?.logicalCpus ?? "?"} logical CPUs; alternating pair order is the control)`;
    lines.push(`CPU affinity: ${affinity}.`);
    lines.push("");
    lines.push(
      table(
        ["measure", "value"],
        [
          ["tunnel median", `${num(stats.tunnelMedian)} msg/s`],
          ["wrtc median", `${num(stats.wrtcMedian)} msg/s`],
          ["median ratio", stats.ratioMedian ?? "-"],
          ["ratio p25 / p75", `${stats.ratioP25 ?? "-"} / ${stats.ratioP75 ?? "-"}`],
          ["ratio 95% CI", `${stats.ciLow ?? "-"} .. ${stats.ciHigh ?? "-"}`],
          ["pairs", `${stats.completePairs ?? "-"} of ${stats.pairs ?? "-"}`],
          ["tunnel ahead in", str(stats.wins)],
          ["verdict", str(stats.verdict)],
        ],
      ),
    );
    lines.push("");
  } else {
    const trimmed = normalize(statsText);
    if (trimmed) {
      lines.push("```text");
      lines.push(trimmed);
      lines.push("```");
      lines.push("");
    }
  }
}

const impairText = readText(join(dir, "bench-impair.txt"));
if (impairText) {
  found = true;
  lines.push("## Impairment");
  lines.push("");
  lines.push("Robustness signal, not a gate: zero open failures is the healthy shape.");
  lines.push("");
  const impair = machineLine(impairText, "");
  const profiles = Array.isArray(impair?.profiles) ? impair.profiles : null;
  if (profiles) {
    lines.push(
      table(
        ["profile", "open p50", "open p95", "open failures", "video msg/s", "refused", "rss MiB"],
        profiles.map((p) =>
          p.state === "failed"
            ? [p.profile, "failed", "failed", "-", "-", "-", `-`]
            : [
                p.profile,
                str(p["open p50 ms"]),
                str(p["open p95 ms"]),
                str(p["open fail"]),
                str(p["video msg/s"]),
                str(p.refused),
                str(p["rss MiB"]),
              ],
        ),
      ),
    );
    lines.push("");
  } else {
    const trimmed = normalize(impairText);
    if (trimmed) {
      lines.push("```text");
      lines.push(trimmed);
      lines.push("```");
      lines.push("");
    }
  }
}

if (!found) {
  lines.push(`No report found at \`${basename(reportPath)}\`.`);
  lines.push("");
}

const markdown = `${lines.join("\n").trimEnd()}\n`;
process.stdout.write(markdown);
