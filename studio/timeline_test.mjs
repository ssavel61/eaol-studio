#!/usr/bin/env node

import assert from "node:assert/strict";
import { buildTimeline } from "./timeline.mjs";
import { manifestSourceSignature } from "./sync.mjs";

function source(id, label, durationSec, expectedKind = "video") {
  return {
    id,
    label,
    expected_kind: expectedKind,
    path: `/fixture/${id}.${expectedKind === "video" ? "mp4" : "wav"}`,
    bytes: 1000,
    modified_ms: 1234,
    duration_sec: durationSec,
  };
}

const primary = source("primary_camera", "Host 1 camera", 120);
const later = source("secondary_camera", "Host 2 camera", 120);
const earlier = source("host_1_audio", "Host 1 isolated audio", 120, "audio");
const manifest = { schema: "eaol-episode-v1", sources: [primary, later, earlier] };
const inputSignatures = manifest.sources.map(manifestSourceSignature);
const syncReceipt = {
  schema: "eaol-sync-v1",
  status: "review_required",
  analyzed_at: "2026-08-16T12:00:00.000Z",
  reference_source_id: "primary_camera",
  input_signatures: inputSignatures,
  results: [
    { source_id: "secondary_camera", label: "Host 2 camera", status: "measured", start_offset_ms: 500, end_offset_ms: 620 },
    { source_id: "host_1_audio", label: "Host 1 isolated audio", status: "measured", start_offset_ms: -400, end_offset_ms: -400 },
  ],
};
const syncReview = {
  schema: "eaol-sync-review-v1",
  status: "approved",
  reviewed_at: "2026-08-16T12:01:00.000Z",
  input_signatures: inputSignatures,
};

const timeline = buildTimeline({
  manifest,
  syncReceipt,
  syncReview,
  generatedAt: "2026-08-16T12:02:00.000Z",
  verifyCurrent: false,
});
assert.equal(timeline.schema, "eaol-timeline-v1");
assert.equal(timeline.status, "preview_required");
assert.equal(timeline.editable, true);
assert.equal(timeline.render_authorized, false);
assert.equal(timeline.tracks.length, 3);
assert.equal(timeline.tracks[0].alignment.playback_rate, 1);
assert.equal(timeline.tracks[1].source_in_ms, 500);
assert.equal(timeline.tracks[1].timeline_start_ms, 0);
assert.equal(timeline.tracks[1].alignment.drift_ms, 120);
assert.equal(timeline.tracks[1].alignment.playback_rate, 1.001);
assert.equal(timeline.tracks[2].source_in_ms, 0);
assert.equal(timeline.tracks[2].timeline_start_ms, 400);
assert.match(timeline.warnings.join(" "), /begins 400ms/);

assert.throws(() => buildTimeline({
  manifest,
  syncReceipt,
  syncReview: { ...syncReview, status: "pending" },
  verifyCurrent: false,
}), /confirm the current sync measurement/);

assert.throws(() => buildTimeline({
  manifest,
  syncReceipt: { ...syncReceipt, input_signatures: inputSignatures.slice(0, 2) },
  syncReview,
  verifyCurrent: false,
}), /does not match the current source set/);

assert.throws(() => buildTimeline({
  manifest: { ...manifest, sources: [primary, { ...later, duration_sec: 0.2 }] },
  syncReceipt: {
    ...syncReceipt,
    input_signatures: [primary, { ...later, duration_sec: 0.2 }].map(manifestSourceSignature),
    results: [{ source_id: "secondary_camera", label: "Host 2 camera", status: "measured", start_offset_ms: 500, end_offset_ms: 500 }],
  },
  syncReview: {
    ...syncReview,
    input_signatures: [primary, { ...later, duration_sec: 0.2 }].map(manifestSourceSignature),
  },
  verifyCurrent: false,
}), /no overlapping media/);

console.log("PASS confirmed offsets create reversible source/timeline mappings");
console.log("PASS positive and negative offsets, linear drift, and coverage warnings");
console.log("PASS unconfirmed or mismatched receipts cannot create a timeline");
