#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveTool } from "../platform_tools.mjs";

export const RSS_AUDIO_TARGET = Object.freeze({
  integrated_lufs: -16,
  integrated_tolerance_lu: 1,
  true_peak_dbtp_max: -1,
  loudness_range_lu: 11,
  sample_rate_hz: 48_000,
  channels: 2,
  codec: "mp3",
  bitrate_kbps: 192,
});

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, label, runCommand = spawnSync) {
  const result = runCommand(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed: ${String(result.stderr || result.stdout).trim()}`);
  return result;
}

export function parseLoudnormJson(output) {
  const text = String(output || "");
  const matches = [...text.matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/g)];
  if (!matches.length) throw new Error("FFmpeg loudness analysis did not return a measurement receipt");
  let parsed;
  try {
    parsed = JSON.parse(matches.at(-1)[0]);
  } catch {
    throw new Error("FFmpeg loudness analysis returned an unreadable measurement receipt");
  }
  const required = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"];
  const numbers = Object.fromEntries(required.map((key) => [key, Number(parsed[key])]));
  if (Object.values(numbers).some((value) => !Number.isFinite(value))) {
    throw new Error("FFmpeg loudness analysis returned incomplete measurements");
  }
  return numbers;
}

function durationArgs(durationSec) {
  if (durationSec == null) return [];
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("the full-render receipt must have a positive finite duration");
  return ["-t", durationSec.toFixed(6)];
}

export function loudnessAnalysisArgs(inputPath, durationSec = null) {
  const target = RSS_AUDIO_TARGET;
  return [
    "-hide_banner", "-nostats", "-i", inputPath,
    "-map", "0:a:0",
    "-af", `loudnorm=I=${target.integrated_lufs}:LRA=${target.loudness_range_lu}:TP=${target.true_peak_dbtp_max}:print_format=json`,
    ...durationArgs(durationSec), "-f", "null", "-",
  ];
}

export function normalizedAudioArgs({ inputPath, outputPath, title, measurement, durationSec = null }) {
  const target = RSS_AUDIO_TARGET;
  const filter = [
    `loudnorm=I=${target.integrated_lufs}`,
    `LRA=${target.loudness_range_lu}`,
    `TP=${target.true_peak_dbtp_max}`,
    `measured_I=${measurement.input_i}`,
    `measured_LRA=${measurement.input_lra}`,
    `measured_TP=${measurement.input_tp}`,
    `measured_thresh=${measurement.input_thresh}`,
    `offset=${measurement.target_offset}`,
    "linear=true",
    "print_format=summary",
  ].join(":");
  return [
    "-hide_banner", "-y", "-v", "error", "-i", inputPath,
    "-map", "0:a:0", "-vn", "-af", filter,
    "-ar", String(target.sample_rate_hz), "-ac", String(target.channels),
    "-c:a", "libmp3lame", "-b:a", `${target.bitrate_kbps}k`,
    "-metadata", `title=${String(title || "Podcast episode")}`,
    ...durationArgs(durationSec), outputPath,
  ];
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

function probeAudio(path, ffprobe, runCommand) {
  const result = run(ffprobe, [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
    "-of", "json", path,
  ], "RSS audio probe", runCommand);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("RSS audio probe returned unreadable output");
  }
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error("RSS audio output has no audio stream");
  return {
    codec: String(stream.codec_name || ""),
    sample_rate_hz: Number(stream.sample_rate),
    channels: Number(stream.channels),
    duration_sec: Number(parsed.format?.duration || 0),
  };
}

function renderSignature(render) {
  return {
    assembly_fingerprint: render.assembly_fingerprint,
    path: render.output.path,
    bytes: Number(render.output.bytes),
    modified_ms: Number(render.output.modified_ms),
  };
}

export function deliveryAudioMatchesRender(receipt, render) {
  if (!receipt || !render || receipt.status !== "complete") return false;
  const expected = renderSignature(render);
  if (JSON.stringify(receipt.source_render) !== JSON.stringify(expected)) return false;
  try {
    const stat = statSync(receipt.output.path);
    return stat.isFile()
      && stat.size === Number(receipt.output.bytes)
      && Math.round(stat.mtimeMs) === Number(receipt.output.modified_ms)
      && Object.values(receipt.checks || {}).every(Boolean);
  } catch {
    return false;
  }
}

export function renderRssAudio(workDir, {
  generatedAt = new Date().toISOString(),
  ffmpeg = resolveTool("ffmpeg"),
  ffprobe = resolveTool("ffprobe"),
  runCommand = spawnSync,
} = {}) {
  const dir = String(workDir || "");
  const render = readJson(join(dir, "episode_render.json"));
  if (!render || render.status !== "complete" || render.quality !== "full" || render.full_render_authorized !== true) {
    throw new Error("a current approved full-episode render is required before creating RSS audio");
  }
  const inputPath = render.output?.path;
  if (!inputPath || !existsSync(inputPath)) throw new Error("the approved full-episode render is not available locally");
  const inputStat = statSync(inputPath);
  if (!inputStat.isFile()
    || inputStat.size !== Number(render.output?.bytes)
    || Math.round(inputStat.mtimeMs) !== Number(render.output?.modified_ms)) {
    throw new Error("the full-episode render changed after its receipt was written");
  }

  const assembly = readJson(join(dir, "episode_assembly.json"));
  if (!assembly || assembly.plan_fingerprint !== render.assembly_fingerprint) {
    throw new Error("the approved episode recipe no longer matches the full render");
  }

  // A joined AAC stream can expose decoder tail samples beyond its presentation
  // endpoint. RSS must end at the current video's endpoint, without padding a
  // short source or relaxing the independent duration check below.
  const durationSec = Number(render.output?.duration_sec);
  durationArgs(durationSec);
  const firstPass = run(ffmpeg, loudnessAnalysisArgs(inputPath, durationSec), "input loudness analysis", runCommand);
  const measurement = parseLoudnormJson(firstPass.stderr);
  const outputDir = join(dir, "episode");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, "episode_audio_rss.mp3");
  run(ffmpeg, normalizedAudioArgs({ inputPath, outputPath, title: assembly.title, measurement, durationSec }), "RSS audio render", runCommand);

  const verificationRun = run(ffmpeg, loudnessAnalysisArgs(outputPath), "RSS audio verification", runCommand);
  const verified = parseLoudnormJson(verificationRun.stderr);
  const outputProbe = probeAudio(outputPath, ffprobe, runCommand);
  const outputStat = statSync(outputPath);
  const integratedMinimum = RSS_AUDIO_TARGET.integrated_lufs - RSS_AUDIO_TARGET.integrated_tolerance_lu;
  const integratedMaximum = RSS_AUDIO_TARGET.integrated_lufs + RSS_AUDIO_TARGET.integrated_tolerance_lu;
  const checks = {
    integrated_loudness: verified.input_i >= integratedMinimum && verified.input_i <= integratedMaximum,
    true_peak: verified.input_tp <= RSS_AUDIO_TARGET.true_peak_dbtp_max,
    output_bytes: outputStat.isFile() && outputStat.size > 0,
    codec: outputProbe.codec === RSS_AUDIO_TARGET.codec,
    sample_rate: outputProbe.sample_rate_hz === RSS_AUDIO_TARGET.sample_rate_hz,
    channels: outputProbe.channels === RSS_AUDIO_TARGET.channels,
    duration: Math.abs(outputProbe.duration_sec - durationSec) <= 1,
  };
  if (Object.values(checks).some((value) => !value)) {
    throw new Error(`RSS audio technical checks failed: ${JSON.stringify(checks)}`);
  }
  const receipt = {
    schema: "eaol-delivery-audio-v1",
    status: "complete",
    generated_at: generatedAt,
    source_slug: render.source_slug,
    source_render: renderSignature(render),
    presentation_duration_sec: durationSec,
    target: RSS_AUDIO_TARGET,
    input_measurement: {
      integrated_lufs: measurement.input_i,
      true_peak_dbtp: measurement.input_tp,
      loudness_range_lu: measurement.input_lra,
    },
    output_measurement: {
      integrated_lufs: verified.input_i,
      true_peak_dbtp: verified.input_tp,
      loudness_range_lu: verified.input_lra,
    },
    output: {
      path: outputPath,
      file: basename(outputPath),
      bytes: outputStat.size,
      modified_ms: Math.round(outputStat.mtimeMs),
      sha256: fileSha256(outputPath),
      codec: outputProbe.codec,
      bitrate_kbps: RSS_AUDIO_TARGET.bitrate_kbps,
      sample_rate_hz: outputProbe.sample_rate_hz,
      channels: outputProbe.channels,
      duration_sec: outputProbe.duration_sec,
    },
    checks,
    rss_ready: true,
    external_copy_authorized: false,
    upload_authorized: false,
    publication_authorized: false,
  };
  writeFileSync(join(dir, "delivery_audio.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function parseRunArg(argv) {
  const index = argv.indexOf("--run");
  return index >= 0 ? argv[index + 1] : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const workDir = parseRunArg(process.argv.slice(2));
  if (!workDir) {
    console.error("usage: node studio/delivery_audio.mjs --run work/<episode>");
    process.exit(1);
  }
  try {
    const receipt = renderRssAudio(workDir);
    console.log(`RSS audio complete: ${receipt.output.path}`);
  } catch (error) {
    console.error(`FATAL: ${error.message}`);
    process.exit(1);
  }
}
