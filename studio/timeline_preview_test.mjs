#!/usr/bin/env node

import assert from "node:assert/strict";
import { buildTimelinePreviewReview, timelineTimeToSourceMs } from "./timeline_preview.mjs";

const track = {
  timeline_start_ms: 400,
  timeline_end_ms: 10_000,
  source_in_ms: 0,
  alignment: { playback_rate: 1.001 },
};
assert.equal(timelineTimeToSourceMs(track, 399), null);
assert.equal(timelineTimeToSourceMs(track, 400), 0);
assert.equal(timelineTimeToSourceMs(track, 1400), 1001);
assert.equal(timelineTimeToSourceMs(track, 10_001), null);

const manifest = { sources: [] };
const timeline = {
  generated_at: "2026-08-16T15:00:00.000Z",
  tracks: [
    { source_id: "primary_camera", media_kind: "video" },
    { source_id: "secondary_camera", media_kind: "video" },
  ],
};
assert.throws(() => buildTimelinePreviewReview({
  timeline: { ...timeline, tracks: timeline.tracks.slice(0, 1) },
  manifest,
  status: "pending",
}), /two camera tracks are required/);
assert.throws(() => buildTimelinePreviewReview({
  timeline,
  manifest,
  status: "approved",
  checkedStart: true,
}), /check both the start and end/);
const approved = buildTimelinePreviewReview({
  timeline,
  manifest,
  status: "approved",
  checkedStart: true,
  checkedEnd: true,
  reviewedAt: "2026-08-16T15:30:00.000Z",
});
assert.equal(approved.status, "approved");
assert.equal(approved.render_authorized, false);
assert.equal(approved.timeline_generated_at, timeline.generated_at);

console.log("PASS timeline time maps reversibly into drift-corrected source time");
console.log("PASS a camera-pair review cannot be created from one camera");
console.log("PASS preview approval requires explicit start and end checks");
console.log("PASS playback verification never authorizes rendering");
