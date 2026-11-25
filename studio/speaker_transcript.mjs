#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { manifestSourceSignature, sourceReceiptsAreCurrent } from "./sync.mjs";
import { timelineReceiptMatchesInputs } from "./timeline.mjs";
import { resolveTool } from "../platform_tools.mjs";
import { resetCandidateReviewContext } from "./review_context.mjs";

const FFMPEG = resolveTool("ffmpeg");
const WHISPER = resolveTool("whisper");

const STUDIO_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(STUDIO_DIR);
const REQUIRED_ROLES = [
  { source_id: "host_1_audio", speaker_id: "host_1", speaker_label: "Host 1" },
  { source_id: "host_2_audio", speaker_id: "host_2", speaker_label: "Host 2" },
];
const MIN_DOMINANCE_DB = 4;

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function signaturesMatch(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function timestampMs(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(String(value || ""));
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match.map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function timestamp(value, separator = ".") {
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const milliseconds = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(milliseconds).padStart(3, "0")}`;
}

export function parseSrt(text) {
  return String(text || "").replace(/\r/g, "").trim().split(/\n{2,}/).flatMap((block) => {
    const lines = block.split("\n");
    const match = lines[1]?.match(/^(\d{2}:\d{2}:\d{2}[,.]\d{3}) --> (\d{2}:\d{2}:\d{2}[,.]\d{3})$/);
    if (!match || lines.length < 3) return [];
    const startMs = timestampMs(match[1]);
    const endMs = timestampMs(match[2]);
    if (startMs === null || endMs === null || endMs <= startMs) return [];
    return [{ start_ms: startMs, end_ms: endMs, text: lines.slice(2).join(" ").trim() }];
  }).filter((cue) => cue.text);
}

function timelineTrack(timeline, sourceId) {
  const track = (timeline.tracks || []).find((item) => item.source_id === sourceId);
  if (!track) throw new Error(`${sourceId} is missing from the aligned timeline`);
  return track;
}

export function mapCuesToTimeline(cues, track, role) {
  const rate = Number(track.alignment?.playback_rate || 1);
  const offset = Number(track.alignment?.start_offset_ms || 0);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`${role.speaker_label} has an invalid timeline rate`);
  return cues.flatMap((cue) => {
    const startMs = Math.max(Number(track.timeline_start_ms || 0), (cue.start_ms - offset) / rate);
    const endMs = Math.min(Number(track.timeline_end_ms || Infinity), (cue.end_ms - offset) / rate);
    if (endMs <= startMs) return [];
    return [{
      speaker_id: role.speaker_id,
      speaker_label: role.speaker_label,
      source_id: role.source_id,
      start_ms: Math.round(startMs),
      end_ms: Math.round(endMs),
      start: timestamp(startMs),
      end: timestamp(endMs),
      text: cue.text,
    }];
  });
}

function db(value) {
  return value > 0 ? 20 * Math.log10(value) : -120;
}

export function filterSegmentsByDominance(segments, measureDominance, minDominanceDb = MIN_DOMINANCE_DB) {
  if (typeof measureDominance !== "function") return { segments, suppressed: [] };
  const kept = [];
  const suppressed = [];
  for (const segment of segments) {
    const measurement = measureDominance(segment) || {};
    const hostOneRms = Number(measurement.host_1_rms || 0);
    const hostTwoRms = Number(measurement.host_2_rms || 0);
    const dominanceDb = db(hostOneRms) - db(hostTwoRms);
    const otherTrackDominates = segment.speaker_id === "host_1"
      ? dominanceDb <= -minDominanceDb
      : dominanceDb >= minDominanceDb;
    const annotated = {
      ...segment,
      dominance_db: Number(dominanceDb.toFixed(2)),
      dominance_decision: otherTrackDominates ? "suppressed_as_bleed" : Math.abs(dominanceDb) >= minDominanceDb ? "assigned_track_dominant" : "overlap_or_uncertain",
    };
    if (otherTrackDominates) suppressed.push(annotated);
    else kept.push(annotated);
  }
  return { segments: kept, suppressed };
}

function overlapsForSegments(segments) {
  const overlaps = [];
  for (let index = 1; index < segments.length; index++) {
    const current = segments[index];
    for (let priorIndex = index - 1; priorIndex >= 0; priorIndex--) {
      const previous = segments[priorIndex];
      if (current.speaker_id !== previous.speaker_id && current.start_ms < previous.end_ms) {
        overlaps.push({
          first_segment: priorIndex + 1,
          second_segment: index + 1,
          overlap_ms: Math.min(previous.end_ms, current.end_ms) - current.start_ms,
        });
      }
    }
  }
  return overlaps;
}

export function mergeSpeakerCues({ timeline, hostCues, measureDominance = null }) {
  const mapped = REQUIRED_ROLES.flatMap((role) => mapCuesToTimeline(
    hostCues[role.source_id] || [],
    timelineTrack(timeline, role.source_id),
    role,
  )).sort((left, right) => left.start_ms - right.start_ms || left.speaker_id.localeCompare(right.speaker_id));
  const filtered = filterSegmentsByDominance(mapped, measureDominance);
  return { segments: filtered.segments, suppressed: filtered.suppressed, overlaps: overlapsForSegments(filtered.segments) };
}

function readPcm16MonoWav(path) {
  const buffer = readFileSync(path);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${basename(path)} is not a readable PCM WAV`);
  }
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (id === "fmt " && size >= 16) {
      channels = buffer.readUInt16LE(payload + 2);
      sampleRate = buffer.readUInt32LE(payload + 4);
      bitsPerSample = buffer.readUInt16LE(payload + 14);
    } else if (id === "data") {
      dataOffset = payload;
      dataBytes = Math.min(size, buffer.length - payload);
      break;
    }
    offset = payload + size + (size % 2);
  }
  if (channels !== 1 || bitsPerSample !== 16 || !sampleRate || dataOffset < 0) {
    throw new Error(`${basename(path)} must be mono 16-bit PCM WAV for dominance review`);
  }
  return { buffer, sampleRate, dataOffset, sampleCount: Math.floor(dataBytes / 2) };
}

function rmsForTimelineRange(audio, track, startMs, endMs) {
  const rate = Number(track.alignment?.playback_rate || 1);
  const timelineStart = Number(track.timeline_start_ms || 0);
  const sourceIn = Number(track.source_in_ms || 0);
  const sourceStartMs = sourceIn + (startMs - timelineStart) * rate;
  const sourceEndMs = sourceIn + (endMs - timelineStart) * rate;
  const start = Math.max(0, Math.floor(sourceStartMs * audio.sampleRate / 1000));
  const end = Math.min(audio.sampleCount, Math.ceil(sourceEndMs * audio.sampleRate / 1000));
  let power = 0;
  let count = 0;
  for (let index = start; index < end; index++) {
    const sample = audio.buffer.readInt16LE(audio.dataOffset + index * 2) / 32768;
    power += sample * sample;
    count++;
  }
  return Math.sqrt(power / Math.max(1, count));
}

function dominanceMeasureForSources(workDir, timeline) {
  const hostOneAudio = readPcm16MonoWav(join(workDir, "speaker_transcripts", "host_1_audio", "audio.wav"));
  const hostTwoAudio = readPcm16MonoWav(join(workDir, "speaker_transcripts", "host_2_audio", "audio.wav"));
  const hostOneTrack = timelineTrack(timeline, "host_1_audio");
  const hostTwoTrack = timelineTrack(timeline, "host_2_audio");
  return (segment) => ({
    host_1_rms: rmsForTimelineRange(hostOneAudio, hostOneTrack, segment.start_ms, segment.end_ms),
    host_2_rms: rmsForTimelineRange(hostTwoAudio, hostTwoTrack, segment.start_ms, segment.end_ms),
  });
}

function expectedSignatures(manifest) {
  return (manifest.sources || []).map(manifestSourceSignature);
}

export function speakerTranscriptMatchesInputs(receipt, manifest, timeline) {
  if (!receipt || !manifest || !timeline || timeline.stale) return false;
  const signatures = expectedSignatures(manifest);
  return sourceReceiptsAreCurrent(manifest.sources || [])
    && signaturesMatch(receipt.input_signatures, signatures)
    && receipt.timeline_generated_at === timeline.generated_at;
}

function sourceTranscriptReady(receipt, source, model) {
  return receipt
    && receipt.source_signature === manifestSourceSignature(source)
    && receipt.model === model;
}

function transcribeSource({ workDir, source, model, modelFile, timeline }) {
  const outputDir = join(workDir, "speaker_transcripts", source.id);
  const receiptPath = join(outputDir, "receipt.json");
  const srtPath = join(outputDir, "transcript.srt");
  const prior = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;
  if (existsSync(srtPath) && sourceTranscriptReady(prior, source, model)) {
    console.log(`Reusing ${source.label} transcript.`);
    return parseSrt(readFileSync(srtPath, "utf8"));
  }
  mkdirSync(outputDir, { recursive: true });
  const audioPath = join(outputDir, "audio.wav");
  console.log(`Extracting ${source.label} audio…`);
  const extract = spawnSync(FFMPEG, [
    "-y", "-v", "error", "-i", source.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath,
  ], { encoding: "utf8" });
  if (extract.error) throw new Error(`ffmpeg failed to start: ${extract.error.message}`);
  if (extract.status !== 0) throw new Error(`${source.label} audio extraction failed: ${extract.stderr || extract.stdout}`);
  console.log(`Transcribing ${source.label} locally…`);
  const prefix = join(outputDir, "transcript");
  const whisper = spawnSync(WHISPER, [
    "-m", modelFile,
    "-f", audioPath,
    "-l", "en",
    "-t", "8",
    "--max-len", "42",
    "--split-on-word",
    "--output-json",
    "--output-srt",
    "--output-file", prefix,
  ], { encoding: "utf8" });
  if (whisper.error) throw new Error(`${WHISPER} failed to start: ${whisper.error.message}`);
  if (whisper.status !== 0) throw new Error(`${source.label} transcription failed: ${whisper.stderr || whisper.stdout}`);
  const cues = parseSrt(readFileSync(srtPath, "utf8"));
  if (!cues.length) throw new Error(`${source.label} transcription produced no words`);
  writeFileSync(receiptPath, `${JSON.stringify({
    schema: "eaol-source-transcript-v1",
    source_id: source.id,
    source_signature: manifestSourceSignature(source),
    model,
    cue_count: cues.length,
    transcribed_at: new Date().toISOString(),
  }, null, 2)}\n`);
  return cues;
}

function writeMergedSrt(path, segments) {
  const blocks = segments.map((segment, index) => [
    index + 1,
    `${timestamp(segment.start_ms, ",")} --> ${timestamp(segment.end_ms, ",")}`,
    `[${segment.speaker_label}] ${segment.text}`,
  ].join("\n"));
  writeFileSync(path, `${blocks.join("\n\n")}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const runIndex = args.indexOf("--run");
  if (runIndex < 0 || !args[runIndex + 1]) fail("Usage: node studio/speaker_transcript.mjs --run work/<episode> [--model small.en]");
  const modelIndex = args.indexOf("--model");
  const model = modelIndex >= 0 && args[modelIndex + 1] ? args[modelIndex + 1] : "small.en";
  const modelFile = join(ROOT, "models", `ggml-${model}.bin`);
  const workDir = resolve(args[runIndex + 1]);
  try {
    const manifest = JSON.parse(readFileSync(join(workDir, "episode.json"), "utf8"));
    const timeline = JSON.parse(readFileSync(join(workDir, "timeline.json"), "utf8"));
    const syncReceipt = JSON.parse(readFileSync(join(workDir, "sync.json"), "utf8"));
    const syncReview = JSON.parse(readFileSync(join(workDir, "sync_review.json"), "utf8"));
    if (!sourceReceiptsAreCurrent(manifest.sources || [])) throw new Error("source files changed after intake; run source checks again");
    if (!timelineReceiptMatchesInputs(timeline, manifest, syncReceipt, syncReview)) {
      throw new Error("build the current confirmed timeline before transcribing isolated host tracks");
    }
    const missing = REQUIRED_ROLES.filter((role) => !(manifest.sources || []).some((source) => source.id === role.source_id));
    if (missing.length) throw new Error("two isolated host audio tracks are required; speaker identity will not be inferred from camera audio");
    const existingPath = join(workDir, "speaker_transcript.json");
    const existing = existsSync(existingPath) ? JSON.parse(readFileSync(existingPath, "utf8")) : null;
    if (speakerTranscriptMatchesInputs(existing, manifest, timeline) && existing.model === model && existing.merge_method === "isolated-track-dominance-v1") {
      console.log("Reusing the current speaker-labeled transcript.");
      return;
    }
    if (!existsSync(modelFile)) throw new Error(`model not found: ${modelFile}`);
    const hostCues = {};
    for (const role of REQUIRED_ROLES) {
      const source = manifest.sources.find((item) => item.id === role.source_id);
      hostCues[role.source_id] = transcribeSource({ workDir, source, model, modelFile, timeline });
    }
    const merged = mergeSpeakerCues({ timeline, hostCues, measureDominance: dominanceMeasureForSources(workDir, timeline) });
    if (!merged.segments.length) throw new Error("the isolated host transcripts produced no timeline segments");
    const generatedAt = new Date().toISOString();
    const receipt = {
      schema: "eaol-speaker-transcript-v1",
      status: "review_required",
      generated_at: generatedAt,
      timeline_generated_at: timeline.generated_at,
      input_signatures: expectedSignatures(manifest),
      model,
      merge_method: "isolated-track-dominance-v1",
      min_dominance_db: MIN_DOMINANCE_DB,
      suppressed_bleed_segment_count: merged.suppressed.length,
      speakers: REQUIRED_ROLES.map((role) => ({
        ...role,
        segment_count: merged.segments.filter((segment) => segment.speaker_id === role.speaker_id).length,
      })),
      overlap_count: merged.overlaps.length,
      overlaps: merged.overlaps,
      segments: merged.segments,
    };
    writeFileSync(existingPath, `${JSON.stringify(receipt, null, 2)}\n`);
    writeMergedSrt(join(workDir, "speaker_transcript.srt"), merged.segments);
    resetCandidateReviewContext({
      workDir,
      updatedAt: generatedAt,
      reason: "A new speaker-labeled transcript changed the candidate review context.",
    });
    console.log(`Speaker transcript: ${merged.segments.length} segments · ${merged.suppressed.length} bleed duplicates suppressed · ${merged.overlaps.length} overlaps · review required`);
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
