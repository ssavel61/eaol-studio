#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stereoSplitDecodeArgs } from "./show_config.mjs";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { channelPreflightMatchesInputs } from "./channel_preflight.mjs";
import { manifestSourceSignature, sourceReceiptsAreCurrent } from "./sync.mjs";
import { timelineReceiptMatchesInputs } from "./timeline.mjs";
import { resolveTool } from "../platform_tools.mjs";

const FFMPEG = resolveTool("ffmpeg");
const SAMPLE_RATE = 16_000;
const FRAME_MS = 100;
const MIN_ACTIVE_ABOVE_NOISE_DB = 10;
const MIN_DOMINANCE_DB = 4;
const ABSOLUTE_FLOOR = 0.00018;

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function db(value) {
  return value > 0 ? 20 * Math.log10(value) : -120;
}

function round(value, places = 3) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function signaturesMatch(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function classifySpeakerFrame(leftRms, rightRms, noiseLeft, noiseRight) {
  const leftThreshold = Math.max(ABSOLUTE_FLOOR, noiseLeft * 10 ** (MIN_ACTIVE_ABOVE_NOISE_DB / 20));
  const rightThreshold = Math.max(ABSOLUTE_FLOOR, noiseRight * 10 ** (MIN_ACTIVE_ABOVE_NOISE_DB / 20));
  const leftActive = leftRms >= leftThreshold;
  const rightActive = rightRms >= rightThreshold;
  const differenceDb = db(leftRms) - db(rightRms);
  let state = "silence";
  let reason = "both_channels_below_activity_floor";
  if (leftActive && rightActive && differenceDb >= MIN_DOMINANCE_DB) {
    state = "host_1";
    reason = "host_1_channel_dominant";
  } else if (leftActive && rightActive && differenceDb <= -MIN_DOMINANCE_DB) {
    state = "host_2";
    reason = "host_2_channel_dominant";
  } else if (leftActive && rightActive) {
    state = "both";
    reason = "both_channels_active_without_safe_dominance";
  } else if (leftActive) {
    state = "host_1";
    reason = "host_1_channel_only";
  } else if (rightActive) {
    state = "host_2";
    reason = "host_2_channel_only";
  } else if (leftRms >= leftThreshold / 1.8 || rightRms >= rightThreshold / 1.8) {
    state = "uncertain";
    reason = "signal_near_activity_floor";
  }
  const margin = state === "host_1" || state === "host_2" ? Math.abs(differenceDb) : 0;
  return {
    state,
    reason,
    confidence: state === "silence" ? 0.9 : state === "uncertain" ? 0.2 : state === "both" ? 0.7 : round(Math.min(0.99, 0.55 + margin / 20), 2),
    left_dbfs: round(db(leftRms), 2),
    right_dbfs: round(db(rightRms), 2),
  };
}

export function mergeActivityFrames(frames, frameMs = FRAME_MS) {
  const segments = [];
  for (const frame of frames) {
    const previous = segments.at(-1);
    if (previous && previous.state === frame.state && previous.reason === frame.reason && previous.end_ms === frame.start_ms) {
      previous.end_ms = frame.end_ms;
      previous.duration_ms = previous.end_ms - previous.start_ms;
      previous.frame_count++;
      previous.confidence = round((previous.confidence * (previous.frame_count - 1) + frame.confidence) / previous.frame_count, 2);
      previous.left_dbfs = round((previous.left_dbfs * (previous.frame_count - 1) + frame.left_dbfs) / previous.frame_count, 2);
      previous.right_dbfs = round((previous.right_dbfs * (previous.frame_count - 1) + frame.right_dbfs) / previous.frame_count, 2);
    } else {
      segments.push({
        id: `activity_${String(segments.length + 1).padStart(5, "0")}`,
        start_ms: frame.start_ms,
        end_ms: frame.end_ms,
        duration_ms: frame.end_ms - frame.start_ms || frameMs,
        state: frame.state,
        reason: frame.reason,
        confidence: frame.confidence,
        left_dbfs: frame.left_dbfs,
        right_dbfs: frame.right_dbfs,
        frame_count: 1,
      });
    }
  }
  return segments;
}

function decodeEnvelopes(path, channels) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(FFMPEG, [
      "-v", "error", "-i", path, "-vn", ...(channels === 2 ? stereoSplitDecodeArgs() : []), "-ac", String(channels), "-ar", String(SAMPLE_RATE),
      "-f", "f32le", "-c:a", "pcm_f32le", "pipe:1",
    ]);
    const values = Array.from({ length: channels }, () => []);
    const frameBytes = (SAMPLE_RATE * FRAME_MS / 1000) * channels * 4;
    let pending = Buffer.alloc(0);
    let stderr = "";
    const consume = (buffer) => {
      for (let channel = 0; channel < channels; channel++) {
        let power = 0;
        let count = 0;
        for (let offset = channel * 4; offset + 3 < buffer.length; offset += channels * 4) {
          const sample = buffer.readFloatLE(offset);
          power += sample * sample;
          count++;
        }
        values[channel].push(Math.sqrt(power / Math.max(1, count)));
      }
    };
    child.stdout.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        consume(pending.subarray(0, frameBytes));
        pending = pending.subarray(frameBytes);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`audio extraction failed: ${stderr || `ffmpeg exited ${code}`}`));
      if (pending.length >= channels * 4) consume(pending);
      resolvePromise(values);
    });
  });
}

function sourceAtTimeline(envelope, track, timelineMs) {
  if (!track || timelineMs < Number(track.timeline_start_ms || 0) || timelineMs >= Number(track.timeline_end_ms || 0)) return 0;
  const rate = Number(track.alignment?.playback_rate || 1);
  const sourceMs = Number(track.source_in_ms || 0) + (timelineMs - Number(track.timeline_start_ms || 0)) * rate;
  return envelope[Math.max(0, Math.floor(sourceMs / FRAME_MS))] || 0;
}

function alignedNoiseFloor(envelope, track, durationMs) {
  const values = [];
  for (let timelineMs = 0; timelineMs < durationMs; timelineMs += FRAME_MS) {
    const value = sourceAtTimeline(envelope, track, timelineMs + FRAME_MS / 2);
    if (Number.isFinite(value) && value > 0) values.push(value);
  }
  if (!values.length) return ABSOLUTE_FLOOR;
  values.sort((left, right) => left - right);
  const quietCount = Math.max(1, Math.ceil(values.length * 0.2));
  const quiet = values.slice(0, quietCount);
  return Math.max(ABSOLUTE_FLOOR, Math.sqrt(quiet.reduce((sum, value) => sum + value * value, 0) / quiet.length));
}

export async function buildSpeakerActivity({ manifest, timeline, channelPreflight, generatedAt = new Date().toISOString() }) {
  if (!sourceReceiptsAreCurrent(manifest?.sources || [])) throw new Error("source files changed after intake; run source checks again");
  if (!channelPreflightMatchesInputs(channelPreflight, manifest) || channelPreflight.status !== "passed") {
    throw new Error("pass the current microphone channel slate before building speaker activity");
  }
  const tracks = new Map((timeline?.tracks || []).map((track) => [track.source_id, track]));
  const host1 = (manifest.sources || []).find((source) => source.id === "host_1_audio");
  const host2 = (manifest.sources || []).find((source) => source.id === "host_2_audio");
  let mode;
  let leftEnvelope;
  let rightEnvelope;
  let leftTrack;
  let rightTrack;
  const evidenceSources = [];
  if (host1 && host2 && tracks.has(host1.id) && tracks.has(host2.id)) {
    mode = "isolated_transmitter_masters";
    [leftEnvelope] = await decodeEnvelopes(host1.path, 1);
    [rightEnvelope] = await decodeEnvelopes(host2.path, 1);
    leftTrack = tracks.get(host1.id);
    rightTrack = tracks.get(host2.id);
    evidenceSources.push(host1.id, host2.id);
  } else {
    mode = "validated_receiver_stereo_fallback";
    const source = (manifest.sources || []).find((item) => item.id === channelPreflight.source_id);
    [leftEnvelope, rightEnvelope] = await decodeEnvelopes(source.path, 2);
    leftTrack = tracks.get(source.id);
    rightTrack = leftTrack;
    evidenceSources.push(source.id);
  }
  if (!leftTrack || !rightTrack) throw new Error("the speaker evidence source is missing from the confirmed timeline");
  const durationMs = Number(timeline.reference_duration_ms || 0);
  const noiseLeft = alignedNoiseFloor(leftEnvelope, leftTrack, durationMs);
  const noiseRight = alignedNoiseFloor(rightEnvelope, rightTrack, durationMs);
  const frames = [];
  for (let startMs = 0; startMs < durationMs; startMs += FRAME_MS) {
    const endMs = Math.min(durationMs, startMs + FRAME_MS);
    const leftRms = sourceAtTimeline(leftEnvelope, leftTrack, startMs + FRAME_MS / 2);
    const rightRms = sourceAtTimeline(rightEnvelope, rightTrack, startMs + FRAME_MS / 2);
    frames.push({ start_ms: startMs, end_ms: endMs, ...classifySpeakerFrame(leftRms, rightRms, noiseLeft, noiseRight) });
  }
  const segments = mergeActivityFrames(frames);
  const stateCounts = Object.fromEntries(["host_1", "host_2", "both", "silence", "uncertain"].map((state) => [
    state,
    segments.filter((segment) => segment.state === state).reduce((sum, segment) => sum + segment.duration_ms, 0),
  ]));
  const inputSignatures = (manifest.sources || []).map(manifestSourceSignature);
  const receipt = {
    schema: "eaol-speaker-activity-v1",
    status: "ready",
    generated_at: generatedAt,
    timeline_generated_at: timeline.generated_at,
    channel_preflight_fingerprint: channelPreflight.fingerprint,
    input_signatures: inputSignatures,
    evidence_mode: mode,
    evidence_source_ids: evidenceSources,
    frame_ms: FRAME_MS,
    thresholds: { min_active_above_noise_db: MIN_ACTIVE_ABOVE_NOISE_DB, min_dominance_db: MIN_DOMINANCE_DB },
    noise_floor_dbfs: { host_1: round(db(noiseLeft), 2), host_2: round(db(noiseRight), 2) },
    state_duration_ms: stateCounts,
    segments,
    render_authorized: false,
  };
  receipt.fingerprint = createHash("sha256").update(JSON.stringify([
    receipt.timeline_generated_at, receipt.channel_preflight_fingerprint, receipt.input_signatures, receipt.evidence_mode, receipt.segments,
  ])).digest("hex");
  return receipt;
}

export function speakerActivityMatchesInputs(receipt, manifest, timeline, channelPreflight) {
  if (!receipt || !manifest || !timeline || !channelPreflight || !sourceReceiptsAreCurrent(manifest.sources || [])) return false;
  return receipt.timeline_generated_at === timeline.generated_at
    && receipt.channel_preflight_fingerprint === channelPreflight.fingerprint
    && signaturesMatch(receipt.input_signatures, (manifest.sources || []).map(manifestSourceSignature));
}

async function main() {
  const args = process.argv.slice(2);
  const runIndex = args.indexOf("--run");
  if (runIndex < 0 || !args[runIndex + 1]) fail("Usage: node studio/speaker_activity.mjs --run work/<episode>");
  const workDir = resolve(args[runIndex + 1]);
  try {
    const manifest = JSON.parse(readFileSync(join(workDir, "episode.json"), "utf8"));
    const sync = JSON.parse(readFileSync(join(workDir, "sync.json"), "utf8"));
    const syncReview = JSON.parse(readFileSync(join(workDir, "sync_review.json"), "utf8"));
    const timeline = JSON.parse(readFileSync(join(workDir, "timeline.json"), "utf8"));
    const channelPreflight = JSON.parse(readFileSync(join(workDir, "channel_preflight.json"), "utf8"));
    if (!timelineReceiptMatchesInputs(timeline, manifest, sync, syncReview)) throw new Error("build the current confirmed timeline first");
    const receipt = await buildSpeakerActivity({ manifest, timeline, channelPreflight });
    writeFileSync(join(workDir, "speaker_activity.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Speaker activity: ${receipt.segments.length} evidence segments · ${receipt.evidence_mode}`);
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
