#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveTool } from "../platform_tools.mjs";
import { parseLoudnormJson } from "./delivery_audio.mjs";
import { episodeProxyFingerprint } from "./episode_proxy_identity.mjs";

export const EPISODE_PROXY_AUDIT_SCHEMA = "eaol-episode-proxy-audit-v1";
export const EPISODE_PROXY_AUDIT_THRESHOLDS = Object.freeze({
  av_duration_delta_sec_max: 1 / 30,
  timeline_duration_delta_sec_max: 1,
  opening_program_loudness_delta_lu_max: 1,
  opening_true_peak_dbtp_max: -1,
  program_overlap_tolerance_sec: 0.25,
  black_min_duration_sec: 1,
  freeze_min_duration_sec: 2,
  silence_min_duration_sec: 3,
});

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, label, runCommand = spawnSync) {
  const result = runCommand(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed: ${String(result.stderr || result.stdout).trim()}`);
  return result;
}

function fileSha256(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function proxyAuditDetectionArgs(inputPath, kind) {
  const threshold = EPISODE_PROXY_AUDIT_THRESHOLDS;
  const filters = {
    black: `blackdetect=d=${threshold.black_min_duration_sec}:pix_th=0.10`,
    freeze: `freezedetect=n=-50dB:d=${threshold.freeze_min_duration_sec}`,
    silence: `silencedetect=n=-50dB:d=${threshold.silence_min_duration_sec}`,
  };
  if (!filters[kind]) throw new Error(`unknown proxy audit detector: ${kind}`);
  const mediaArgs = kind === "silence" ? ["-vn", "-af", filters[kind]] : ["-an", "-vf", filters[kind]];
  return ["-hide_banner", "-nostats", "-i", inputPath, ...mediaArgs, "-f", "null", "-"];
}

function pairedIntervals(text, startPattern, endPattern, durationPattern, fallbackEnd) {
  const starts = [...String(text || "").matchAll(startPattern)].map((match) => Number(match[1]));
  const ends = [...String(text || "").matchAll(endPattern)].map((match) => Number(match[1]));
  const durations = durationPattern
    ? [...String(text || "").matchAll(durationPattern)].map((match) => Number(match[1]))
    : [];
  return starts.map((start, index) => {
    const end = Number.isFinite(ends[index]) ? ends[index] : fallbackEnd;
    return {
      start_sec: start,
      end_sec: end,
      duration_sec: Number.isFinite(durations[index]) ? durations[index] : Math.max(0, end - start),
    };
  });
}

export function parseProxyAuditIntervals(kind, output, durationSec) {
  if (kind === "black") {
    return [...String(output || "").matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)]
      .map((match) => ({ start_sec: Number(match[1]), end_sec: Number(match[2]), duration_sec: Number(match[3]) }));
  }
  if (kind === "freeze") {
    return pairedIntervals(
      output,
      /freeze_start:\s*([\d.]+)/g,
      /freeze_end:\s*([\d.]+)/g,
      /freeze_duration:\s*([\d.]+)/g,
      durationSec,
    );
  }
  if (kind === "silence") {
    return pairedIntervals(
      output,
      /silence_start:\s*([\d.]+)/g,
      /silence_end:\s*([\d.]+)/g,
      /silence_duration:\s*([\d.]+)/g,
      durationSec,
    );
  }
  throw new Error(`unknown proxy audit detector: ${kind}`);
}

function probeProxy(path, ffprobe, runCommand) {
  const result = run(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels,start_time,duration,avg_frame_rate",
    "-of", "json", path,
  ], "proxy stream probe", runCommand);
  const parsed = JSON.parse(result.stdout);
  const video = (parsed.streams || []).find((stream) => stream.codec_type === "video");
  const audio = (parsed.streams || []).find((stream) => stream.codec_type === "audio");
  if (!video || !audio) throw new Error("proxy audit requires one video stream and one audio stream");
  return {
    duration_sec: Number(parsed.format?.duration || 0),
    video: {
      codec: String(video.codec_name || ""),
      width: Number(video.width || 0),
      height: Number(video.height || 0),
      start_sec: Number(video.start_time || 0),
      duration_sec: Number(video.duration || 0),
      average_frame_rate: String(video.avg_frame_rate || ""),
    },
    audio: {
      codec: String(audio.codec_name || ""),
      sample_rate_hz: Number(audio.sample_rate || 0),
      channels: Number(audio.channels || 0),
      start_sec: Number(audio.start_time || 0),
      duration_sec: Number(audio.duration || 0),
    },
  };
}

function loudnessArgs(inputPath, section) {
  const duration = Math.max(0, Number(section.end_sec) - Number(section.start_sec));
  return [
    "-hide_banner", "-nostats",
    "-ss", Number(section.start_sec).toFixed(6), "-t", duration.toFixed(6), "-i", inputPath,
    "-vn", "-map", "0:a:0",
    "-af", "loudnorm=I=-16:LRA=11:TP=-1:print_format=json",
    "-f", "null", "-",
  ];
}

function measureSectionLoudness(path, section, ffmpeg, runCommand) {
  const result = run(ffmpeg, loudnessArgs(path, section), `${section.type} loudness analysis`, runCommand);
  const measurement = parseLoudnormJson(result.stderr);
  return {
    integrated_lufs: measurement.input_i,
    true_peak_dbtp: measurement.input_tp,
    loudness_range_lu: measurement.input_lra,
  };
}

function unexpectedProgramEvents(events, program, tolerance) {
  if (!program) return events;
  return events.filter((event) => {
    const overlap = Math.min(Number(event.end_sec), Number(program.end_sec))
      - Math.max(Number(event.start_sec), Number(program.start_sec));
    return overlap > tolerance;
  });
}

export function episodeProxyAuditFingerprint(audit) {
  if (!audit) return null;
  // loadEpisode decorates durable receipts with runtime-only status fields.
  // They must not change the fingerprint of the saved audit evidence.
  const { fingerprint, original_status, stale, ...stable } = audit;
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function buildEpisodeProxyAudit(workDir, {
  generatedAt = new Date().toISOString(),
  ffmpeg = resolveTool("ffmpeg"),
  ffprobe = resolveTool("ffprobe"),
  runCommand = spawnSync,
} = {}) {
  const dir = resolve(workDir);
  const proxy = readJson(join(dir, "episode_proxy.json"));
  if (!proxy || proxy.status !== "complete" || proxy.quality !== "proxy") {
    throw new Error("render the current low-resolution proxy before running its metadata audit");
  }
  const path = proxy.output?.path;
  if (!path || !existsSync(path)) throw new Error("the proxy media file is missing");
  const stat = statSync(path);
  if (!stat.isFile()
    || stat.size !== Number(proxy.output?.bytes)
    || Math.round(stat.mtimeMs) !== Number(proxy.output?.modified_ms)) {
    throw new Error("the proxy media changed after its render receipt was written");
  }

  const thresholds = EPISODE_PROXY_AUDIT_THRESHOLDS;
  const streams = probeProxy(path, ffprobe, runCommand);
  run(ffmpeg, [
    "-hide_banner", "-nostats", "-v", "error", "-xerror", "-i", path,
    "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
  ], "full proxy decode", runCommand);

  const observations = {};
  for (const kind of ["black", "freeze", "silence"]) {
    const result = run(ffmpeg, proxyAuditDetectionArgs(path, kind), `${kind} detection`, runCommand);
    observations[`${kind}_intervals`] = parseProxyAuditIntervals(kind, result.stderr, streams.duration_sec);
  }

  const sections = proxy.timeline?.sections || [];
  const opening = sections.find((section) => section.type === "opening");
  const program = sections.find((section) => section.type === "program");
  const closing = sections.find((section) => section.type === "closing");
  if (!opening || !program || !closing) throw new Error("proxy audit requires opening, program, and closing timeline sections");
  const openingLoudness = measureSectionLoudness(path, opening, ffmpeg, runCommand);
  const programLoudness = measureSectionLoudness(path, program, ffmpeg, runCommand);
  const loudnessDelta = Math.abs(openingLoudness.integrated_lufs - programLoudness.integrated_lufs);
  const expectedDuration = Number(proxy.timeline?.duration_sec || 0);
  const blackUnexpected = unexpectedProgramEvents(observations.black_intervals, program, thresholds.program_overlap_tolerance_sec);
  const freezeUnexpected = unexpectedProgramEvents(observations.freeze_intervals, program, thresholds.program_overlap_tolerance_sec);
  const silenceUnexpected = unexpectedProgramEvents(observations.silence_intervals, program, thresholds.program_overlap_tolerance_sec);
  const avDurationDelta = Math.abs(streams.video.duration_sec - streams.audio.duration_sec);
  const checks = {
    exact_output_bytes: stat.size === Number(proxy.output.bytes) && Math.round(stat.mtimeMs) === Number(proxy.output.modified_ms),
    full_decode: true,
    streams: streams.video.codec === "h264"
      && streams.video.width === Number(proxy.output.width)
      && streams.video.height === Number(proxy.output.height)
      && streams.audio.codec === "aac"
      && streams.audio.sample_rate_hz === 48_000
      && streams.audio.channels === 2,
    av_duration_delta: avDurationDelta <= thresholds.av_duration_delta_sec_max,
    render_receipt: Object.values(proxy.checks || {}).length > 0 && Object.values(proxy.checks).every(Boolean),
    timeline_duration: expectedDuration > 0
      && Math.abs(streams.duration_sec - expectedDuration) <= thresholds.timeline_duration_delta_sec_max,
    expected_sections: Boolean(opening && program && closing),
    expected_ctas: Number(proxy.cta?.in_program_cue_count || 0) >= 1 && proxy.cta?.closing_overlay === true,
    opening_program_loudness: loudnessDelta <= thresholds.opening_program_loudness_delta_lu_max,
    opening_true_peak: openingLoudness.true_peak_dbtp <= thresholds.opening_true_peak_dbtp_max,
    no_unexpected_program_black: blackUnexpected.length === 0,
    no_unexpected_program_freeze: freezeUnexpected.length === 0,
    no_unexpected_program_silence: silenceUnexpected.length === 0,
  };
  const receipt = {
    schema: EPISODE_PROXY_AUDIT_SCHEMA,
    status: Object.values(checks).every(Boolean) ? "passed" : "blocked",
    generated_at: generatedAt,
    source_slug: proxy.source_slug,
    proxy_fingerprint: episodeProxyFingerprint(proxy),
    output: {
      path,
      file: basename(path),
      bytes: stat.size,
      modified_ms: Math.round(stat.mtimeMs),
      sha256: fileSha256(path),
    },
    thresholds,
    streams,
    av_duration_delta_sec: avDurationDelta,
    timeline_duration_delta_sec: Math.abs(streams.duration_sec - expectedDuration),
    loudness: {
      opening: openingLoudness,
      program: programLoudness,
      opening_program_delta_lu: loudnessDelta,
    },
    observations: {
      ...observations,
      unexpected_program_black: blackUnexpected,
      unexpected_program_freeze: freezeUnexpected,
      unexpected_program_silence: silenceUnexpected,
    },
    checks,
    acceptance_eligible: Object.values(checks).every(Boolean),
    full_render_authorized: false,
    publication_authorized: false,
  };
  receipt.fingerprint = episodeProxyAuditFingerprint(receipt);
  return receipt;
}

export function episodeProxyAuditMatches(audit, proxy) {
  if (!audit || !proxy || audit.schema !== EPISODE_PROXY_AUDIT_SCHEMA || audit.status !== "passed") return false;
  try {
    const stat = statSync(proxy.output?.path);
    return audit.fingerprint === episodeProxyAuditFingerprint(audit)
      && audit.proxy_fingerprint === episodeProxyFingerprint(proxy)
      && audit.output?.path === proxy.output?.path
      && Number(audit.output?.bytes) === Number(proxy.output?.bytes)
      && Number(audit.output?.modified_ms) === Number(proxy.output?.modified_ms)
      && stat.isFile()
      && stat.size === Number(proxy.output?.bytes)
      && Math.round(stat.mtimeMs) === Number(proxy.output?.modified_ms)
      && audit.acceptance_eligible === true
      && Object.values(audit.checks || {}).every(Boolean);
  } catch {
    return false;
  }
}

function parseRunArg(argv) {
  const index = argv.indexOf("--run");
  return index >= 0 ? argv[index + 1] : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const workDir = parseRunArg(process.argv.slice(2));
  if (!workDir) {
    console.error("usage: node studio/episode_proxy_audit.mjs --run work/<episode>");
    process.exit(1);
  }
  try {
    const receipt = buildEpisodeProxyAudit(workDir);
    writeFileSync(join(resolve(workDir), "episode_proxy_audit.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    if (receipt.status !== "passed") throw new Error(`metadata audit blocked: ${JSON.stringify(receipt.checks)}`);
    console.log(`Episode proxy metadata audit passed: ${receipt.output.path}`);
  } catch (error) {
    console.error(`FATAL: ${error.message}`);
    process.exit(1);
  }
}
