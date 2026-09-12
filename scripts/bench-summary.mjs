#!/usr/bin/env node
// Renders the benchmark report as GitHub-flavoured markdown.
//
// The runner writes `target/bench-report.json`; the paired comparison and the
// impairment suite write plain text beside it. This turns all three into one
// summary, and appends it to `$GITHUB_STEP_SUMMARY` when that is set so the
// result shows up on the run page instead of only in the logs.
//
// Usage: node scripts/bench-summary.mjs [report.json] > summary.md

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const reportPath = process.argv[2] ?? "target/bench-report.json";

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

const report = readJson(reportPath);
if (report) {
  const metrics = report.metrics ?? [];
  lines.push("## Benchmark");
  lines.push("");
  lines.push(`Generated ${report.generatedAt} on interface \`${report.host}\`.`);
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
      ["backend", "create to open p50", "p95", "samples", "ice p50", "dtls p50", "sctp p50"],
      metrics.map((m) => [
        m.name,
        ms(m.createOpenMs?.p50),
        ms(m.createOpenMs?.p95),
        m.createOpenMs?.samples ?? "-",
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
        ["backend", "cycles/s", "cycles", "rss growth", "final rss"],
        withLifecycle.map((m) => [
          m.name,
          m.lifecycle ? m.lifecycle.perSecond.toFixed(1) : "-",
          m.lifecycle?.iterations ?? "-",
          m.lifecycle ? bytes(m.lifecycle.rssGrowthBytes) : "-",
          bytes(m.memory?.at(-1)?.rssBytes),
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

for (const [title, path] of [
  ["Paired comparison (tunnel vs wrtc)", "target/bench-stats.txt"],
  ["Impairment", "target/bench-impair.txt"],
]) {
  const text = readText(path);
  if (!text) continue;
  const trimmed = normalize(text);
  if (!trimmed) continue;
  lines.push(`## ${title}`);
  lines.push("");
  lines.push("```text");
  lines.push(trimmed);
  lines.push("```");
  lines.push("");
}

if (lines.length === 0) {
  lines.push("## Benchmark");
  lines.push("");
  lines.push(`No report found at \`${basename(reportPath)}\`.`);
  lines.push("");
}

const markdown = `${lines.join("\n").trimEnd()}\n`;
process.stdout.write(markdown);
