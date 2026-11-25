#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stereoSplitDecodeArgs } from "./show_config.mjs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { manifestSourceSignature, sourceReceiptsAreCurrent } from "./sync.mjs";
import { resolveTool } from "../platform_tools.mjs";

const FFMPEG = resolveTool("ffmpeg");
const SAMPLE_RATE = 16_000;
const SLATE_DURATION_SEC = 17;
const MIN_DOMINANCE_DB = 6;
const MIN_SPEECH_ABOVE_NOISE_DB = 8;
const MAX_CHANNEL_CORRELATION = 0.985;

const WINDOWS = {
  room_tone: [[0, 2], [5, 7], [10, 12], [15, 17]],
  host_1: [2, 5],
  host_2: [7, 10],
  both: [12, 15],
};

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function db(value) {
  return value > 0 ? 20 * Math.log10(value) : -120;
}

function round(value, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function rangeStats(samples, sampleRate, startSec, endSec) {
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const end = Math.min(Math.floor(samples.length / 2), Math.floor(endSec * sampleRate));
  let leftPower = 0;
  let rightPower = 0;
  let cross = 0;
  let count = 0;
  for (let frame = start; frame < end; frame++) {
    const left = samples[frame * 2];
    const right = samples[frame * 2 + 1];
    leftPower += left * left;
    rightPower += right * right;
    cross += left * right;
    count++;
  }
  const leftRms = Math.sqrt(leftPower / Math.max(1, count));
  const rightRms = Math.sqrt(rightPower / Math.max(1, count));
  return {
    left_rms: leftRms,
    right_rms: rightRms,
    left_dbfs: round(db(leftRms)),
    right_dbfs: round(db(rightRms)),
    correlation: round(cross / Math.sqrt(Math.max(1e-18, leftPower * rightPower)), 4),
  };
}

function combinedStats(samples, sampleRate, ranges) {
  const values = ranges.map(([start, end]) => rangeStats(samples, sampleRate, start, end));
  const leftRms = Math.sqrt(values.reduce((sum, value) => sum + value.left_rms ** 2, 0) / values.length);
  const rightRms = Math.sqrt(values.reduce((sum, value) => sum + value.right_rms ** 2, 0) / values.length);
  return { left_rms: leftRms, right_rms: rightRms, left_dbfs: round(db(leftRms)), right_dbfs: round(db(rightRms)) };
}

export function analyzeChannelSlate(samples, sampleRate = SAMPLE_RATE) {
  const durationSec = samples.length / 2 / sampleRate;
  if (durationSec < SLATE_DURATION_SEC - 0.05) {
    return {
      status: "blocked",
      render_authorized: false,
      checks: { slate_duration: false },
      blocking: [`The source contains only ${durationSec.toFixed(1)}s; the required channel slate is 17s.`],
      measurements: { duration_sec: round(durationSec) },
    };
  }
  const noise = combinedStats(samples, sampleRate, WINDOWS.room_tone);
  const host1 = rangeStats(samples, sampleRate, ...WINDOWS.host_1);
  const host2 = rangeStats(samples, sampleRate, ...WINDOWS.host_2);
  const both = rangeStats(samples, sampleRate, ...WINDOWS.both);
  const speech = rangeStats(samples, sampleRate, WINDOWS.host_1[0], WINDOWS.both[1]);
  const host1Dominance = host1.left_dbfs - host1.right_dbfs;
  const host2Dominance = host2.right_dbfs - host2.left_dbfs;
  const host1AboveNoise = host1.left_dbfs - noise.left_dbfs;
  const host2AboveNoise = host2.right_dbfs - noise.right_dbfs;
  const bothLeftAboveNoise = both.left_dbfs - noise.left_dbfs;
  const bothRightAboveNoise = both.right_dbfs - noise.right_dbfs;
  const checks = {
    slate_duration: true,
    channels_are_distinct: Math.abs(speech.correlation) < MAX_CHANNEL_CORRELATION,
    host_1_left_dominance: host1Dominance >= MIN_DOMINANCE_DB,
    host_2_right_dominance: host2Dominance >= MIN_DOMINANCE_DB,
    host_1_present: host1AboveNoise >= MIN_SPEECH_ABOVE_NOISE_DB,
    host_2_present: host2AboveNoise >= MIN_SPEECH_ABOVE_NOISE_DB,
    both_hosts_present: bothLeftAboveNoise >= MIN_SPEECH_ABOVE_NOISE_DB && bothRightAboveNoise >= MIN_SPEECH_ABOVE_NOISE_DB,
  };
  const messages = {
    channels_are_distinct: `Left/right correlation ${speech.correlation} is too close to identical.`,
    host_1_left_dominance: `Host 1 channel dominance is ${round(host1Dominance)}dB; at least ${MIN_DOMINANCE_DB}dB is required.`,
    host_2_right_dominance: `Host 2 channel dominance is ${round(host2Dominance)}dB; at least ${MIN_DOMINANCE_DB}dB is required.`,
    host_1_present: `Host 1 is not clearly above the measured room tone on its assigned channel.`,
    host_2_present: `Host 2 is not clearly above the measured room tone on its assigned channel.`,
    both_hosts_present: "The two-host slate window does not contain clear speech on both assigned channels.",
  };
  const blocking = Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => messages[key] || `${key} failed.`);
  return {
    status: blocking.length ? "blocked" : "passed",
    render_authorized: false,
    checks,
    blocking,
    thresholds: {
      min_channel_dominance_db: MIN_DOMINANCE_DB,
      min_speech_above_noise_db: MIN_SPEECH_ABOVE_NOISE_DB,
      max_channel_correlation: MAX_CHANNEL_CORRELATION,
    },
    measurements: {
      duration_sec: round(durationSec),
      room_tone: { left_dbfs: noise.left_dbfs, right_dbfs: noise.right_dbfs },
      host_1_window: { ...host1, left_dominance_db: round(host1Dominance), above_noise_db: round(host1AboveNoise) },
      host_2_window: { ...host2, right_dominance_db: round(host2Dominance), above_noise_db: round(host2AboveNoise) },
      both_window: { ...both, left_above_noise_db: round(bothLeftAboveNoise), right_above_noise_db: round(bothRightAboveNoise) },
      speech_channel_correlation: speech.correlation,
    },
  };
}

function decodeSlate(source) {
  const result = spawnSync(FFMPEG, [
    "-v", "error", "-t", String(SLATE_DURATION_SEC), "-i", source.path, "-vn",
    ...stereoSplitDecodeArgs(), "-ac", "2", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-c:a", "pcm_f32le", "pipe:1",
  ], { encoding: null, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw new Error(`ffmpeg failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${source.label} slate extraction failed: ${String(result.stderr || "")}`);
  return new Float32Array(result.stdout.buffer, result.stdout.byteOffset, Math.floor(result.stdout.byteLength / 4));
}

export function channelPreflightMatchesInputs(receipt, manifest) {
  if (!receipt || !manifest || !sourceReceiptsAreCurrent(manifest.sources || [])) return false;
  if (receipt.source_id === "isolated_masters") {
    const sources = (manifest.sources || []).filter((item) => ["host_1_audio", "host_2_audio"].includes(item.id));
    return sources.length === 2
      && Array.isArray(receipt.source_signatures)
      && receipt.source_signatures.length === 2
      && receipt.source_signatures.every((signature, index) => signature === manifestSourceSignature(sources[index]));
  }
  const source = (manifest.sources || []).find((item) => item.id === receipt.source_id);
  return Boolean(source && receipt.source_signature === manifestSourceSignature(source));
}

export function buildChannelPreflight({ manifest, sourceId = "primary_camera", analyzedAt = new Date().toISOString() }) {
  if (!sourceReceiptsAreCurrent(manifest?.sources || [])) throw new Error("source files changed after intake; run source checks again");
  if (sourceId === "isolated_masters") {
    const sources = ["host_1_audio", "host_2_audio"].map((id) => (manifest.sources || []).find((item) => item.id === id));
    if (sources.some((source) => !source)) throw new Error("both assigned isolated transmitter masters are required");
    if (sources.some((source) => Number(source.audio?.channels || 0) !== 1)) {
      throw new Error("the assigned transmitter-master path expects two mono audio sources");
    }
    const sourceSignatures = sources.map(manifestSourceSignature);
    const checks = {
      host_1_isolated_role_assigned: true,
      host_2_isolated_role_assigned: true,
      sources_are_distinct: sourceSignatures[0] !== sourceSignatures[1],
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(["isolated_masters", sourceSignatures, checks])).digest("hex");
    return {
      schema: "eaol-channel-preflight-v1",
      analyzed_at: analyzedAt,
      source_id: "isolated_masters",
      source_label: "Assigned Host 1 + Host 2 transmitter masters",
      source_signatures: sourceSignatures,
      fingerprint,
      status: Object.values(checks).every(Boolean) ? "passed" : "blocked",
      render_authorized: false,
      evidence_mode: "assigned_isolated_transmitter_masters",
      checks,
      blocking: checks.sources_are_distinct ? [] : ["Host 1 and Host 2 must use different transmitter masters."],
      measurements: { source_count: sources.length, channels_per_source: sources.map((source) => source.audio.channels) },
      role_assignment_requires_review: true,
      next_step: "Build source-bound speaker activity, then review the labeled transcript. Swap roles if the two source assignments were reversed.",
    };
  }
  const source = (manifest.sources || []).find((item) => item.id === sourceId);
  if (!source) throw new Error(`source ${sourceId} is not attached to this episode`);
  if (!source.audio) throw new Error(`${source.label} has no audio stream`);
  if (Number(source.audio.channels || 0) < 2) throw new Error(`${source.label} is mono; a stereo split recording needs one host per channel (see audio.channel_mapping in show.config.json)`);
  const analysis = analyzeChannelSlate(decodeSlate(source));
  const sourceSignature = manifestSourceSignature(source);
  return {
    schema: "eaol-channel-preflight-v1",
    analyzed_at: analyzedAt,
    source_id: source.id,
    source_label: source.label,
    source_signature: sourceSignature,
    fingerprint: createHash("sha256").update(JSON.stringify([sourceSignature, analysis.checks, analysis.measurements])).digest("hex"),
    ...analysis,
    next_step: analysis.status === "passed"
      ? "Build source-bound speaker activity. Camera direction remains locked until that receipt and the camera plan exist."
      : "Correct the microphone routing or the channel mapping in show.config.json, or repeat the slate. Do not infer speakers or build an automatic camera plan.",
  };
}

function main() {
  const args = process.argv.slice(2);
  const runIndex = args.indexOf("--run");
  const sourceIndex = args.indexOf("--source");
  if (runIndex < 0 || !args[runIndex + 1]) fail("Usage: node studio/channel_preflight.mjs --run work/<episode> [--source primary_camera]");
  const workDir = resolve(args[runIndex + 1]);
  const manifestPath = join(workDir, "episode.json");
  if (!existsSync(manifestPath)) fail(`${basename(workDir)} has no episode receipt`);
  try {
    const receipt = buildChannelPreflight({
      manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
      sourceId: sourceIndex >= 0 && args[sourceIndex + 1] ? args[sourceIndex + 1] : "primary_camera",
    });
    writeFileSync(join(workDir, "channel_preflight.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Channel preflight: ${receipt.status} · ${receipt.source_label}`);
    for (const problem of receipt.blocking) console.log(`BLOCKED: ${problem}`);
    if (receipt.status !== "passed") process.exitCode = 1;
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
