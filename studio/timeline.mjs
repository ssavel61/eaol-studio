#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { manifestSourceSignature, sourceReceiptsAreCurrent } from "./sync.mjs";

const SCHEMA = "eaol-timeline-v1";

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

function round(value, places = 3) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function expectedSignatures(manifest) {
  return (manifest.sources || []).map(manifestSourceSignature);
}

export function timelineReceiptMatchesInputs(timeline, manifest, syncReceipt, syncReview) {
  if (!timeline || !manifest || !syncReceipt || !syncReview) return false;
  const signatures = expectedSignatures(manifest);
  return sourceReceiptsAreCurrent(manifest.sources || [])
    && syncReview.status === "approved"
    && signaturesMatch(syncReceipt.input_signatures, signatures)
    && signaturesMatch(syncReview.input_signatures, signatures)
    && signaturesMatch(timeline.input_signatures, signatures)
    && timeline.sync_analyzed_at === syncReceipt.analyzed_at
    && timeline.sync_reviewed_at === syncReview.reviewed_at;
}

function referenceTrack(source) {
  const durationMs = Math.round(Number(source.duration_sec || 0) * 1000);
  return {
    source_id: source.id,
    label: source.label,
    media_kind: source.expected_kind,
    source_path: source.path,
    source_duration_ms: durationMs,
    timeline_start_ms: 0,
    timeline_end_ms: durationMs,
    source_in_ms: 0,
    source_out_ms: durationMs,
    alignment: {
      start_offset_ms: 0,
      end_offset_ms: 0,
      drift_ms: 0,
      playback_rate: 1,
    },
  };
}

function alignedTrack(source, result, referenceDurationMs) {
  const sourceDurationMs = Math.round(Number(source.duration_sec || 0) * 1000);
  const startOffsetMs = Number(result.start_offset_ms || 0);
  const endOffsetMs = Number(result.end_offset_ms || 0);
  const driftMs = endOffsetMs - startOffsetMs;
  const playbackRate = 1 + driftMs / Math.max(1, referenceDurationMs);
  if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
    throw new Error(`${source.label} produced an invalid drift correction`);
  }
  const timelineStartMs = Math.max(0, -startOffsetMs / playbackRate);
  const sourceInMs = Math.max(0, startOffsetMs);
  if (sourceInMs >= sourceDurationMs) {
    throw new Error(`${source.label} has no overlapping media after its confirmed start offset`);
  }
  const availableTimelineMs = Math.max(0, sourceDurationMs - sourceInMs) / playbackRate;
  const timelineEndMs = Math.min(referenceDurationMs, timelineStartMs + availableTimelineMs);
  if (timelineEndMs <= timelineStartMs) {
    throw new Error(`${source.label} has no usable overlap with the reference timeline`);
  }
  const sourceOutMs = Math.min(sourceDurationMs, sourceInMs + Math.max(0, timelineEndMs - timelineStartMs) * playbackRate);
  return {
    source_id: source.id,
    label: source.label,
    media_kind: source.expected_kind,
    source_path: source.path,
    source_duration_ms: sourceDurationMs,
    timeline_start_ms: round(timelineStartMs),
    timeline_end_ms: round(timelineEndMs),
    source_in_ms: round(sourceInMs),
    source_out_ms: round(sourceOutMs),
    alignment: {
      start_offset_ms: startOffsetMs,
      end_offset_ms: endOffsetMs,
      drift_ms: driftMs,
      playback_rate: round(playbackRate, 9),
    },
  };
}

export function buildTimeline({ manifest, syncReceipt, syncReview, generatedAt = new Date().toISOString(), verifyCurrent = true }) {
  const sources = manifest?.sources || [];
  const reference = sources.find((source) => source.id === syncReceipt?.reference_source_id);
  if (!reference) throw new Error("the confirmed sync receipt has no matching reference source");
  if (verifyCurrent && !sourceReceiptsAreCurrent(sources)) {
    throw new Error("source files changed after intake; run source checks again before building the timeline");
  }
  const signatures = expectedSignatures(manifest);
  if (!signaturesMatch(syncReceipt?.input_signatures, signatures)) {
    throw new Error("the sync receipt does not match the current source set");
  }
  if (syncReceipt.status !== "review_required" || syncReview?.status !== "approved") {
    throw new Error("confirm the current sync measurement before building the timeline");
  }
  if (!signaturesMatch(syncReview.input_signatures, signatures)) {
    throw new Error("the sync approval does not match the current source set");
  }
  if (!syncReceipt.analyzed_at || !syncReview.reviewed_at) {
    throw new Error("the confirmed sync receipt is missing review timestamps");
  }
  const referenceDurationMs = Math.round(Number(reference.duration_sec || 0) * 1000);
  if (!referenceDurationMs) throw new Error("the reference source has no usable duration");
  const results = new Map((syncReceipt.results || []).map((result) => [result.source_id, result]));
  const warnings = [];
  const tracks = sources.map((source) => {
    if (source.id === reference.id) return referenceTrack(source);
    const result = results.get(source.id);
    if (!result || result.status !== "measured") {
      throw new Error(`${source.label} has no approved waveform measurement`);
    }
    const track = alignedTrack(source, result, referenceDurationMs);
    if (track.timeline_start_ms > 50) {
      warnings.push(`${source.label} begins ${Math.round(track.timeline_start_ms)}ms after the reference timeline.`);
    }
    if (track.timeline_end_ms < referenceDurationMs - 50) {
      warnings.push(`${source.label} ends ${Math.round(referenceDurationMs - track.timeline_end_ms)}ms before the reference timeline.`);
    }
    const rateDelta = Math.abs(track.alignment.playback_rate - 1);
    if (rateDelta > 0.001) {
      warnings.push(`${source.label} needs ${(rateDelta * 100).toFixed(3)}% drift correction; preview the end clap before rendering.`);
    }
    return track;
  });
  return {
    schema: SCHEMA,
    status: "preview_required",
    generated_at: generatedAt,
    reference_source_id: reference.id,
    reference_duration_ms: referenceDurationMs,
    input_signatures: signatures,
    sync_analyzed_at: syncReceipt.analyzed_at,
    sync_reviewed_at: syncReview.reviewed_at,
    editable: true,
    render_authorized: false,
    warnings,
    tracks,
  };
}

function main() {
  const args = process.argv.slice(2);
  const runIndex = args.indexOf("--run");
  if (runIndex < 0 || !args[runIndex + 1]) fail("Usage: node studio/timeline.mjs --run work/<episode>");
  const workDir = resolve(args[runIndex + 1]);
  const paths = {
    manifest: join(workDir, "episode.json"),
    sync: join(workDir, "sync.json"),
    review: join(workDir, "sync_review.json"),
  };
  for (const [label, path] of Object.entries(paths)) {
    if (!existsSync(path)) fail(`${basename(workDir)} has no ${label} receipt`);
  }
  try {
    const timeline = buildTimeline({
      manifest: JSON.parse(readFileSync(paths.manifest, "utf8")),
      syncReceipt: JSON.parse(readFileSync(paths.sync, "utf8")),
      syncReview: JSON.parse(readFileSync(paths.review, "utf8")),
    });
    writeFileSync(join(workDir, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
    console.log(`Timeline: ${timeline.tracks.length} tracks · ${timeline.status}`);
    for (const warning of timeline.warnings) console.log(`ATTENTION: ${warning}`);
    console.log(`Editable receipt: ${join(workDir, "timeline.json")}`);
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
