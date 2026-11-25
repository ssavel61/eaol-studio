#!/usr/bin/env node

import assert from "node:assert/strict";
import { buildSocialEditPlan } from "./social_edit_plan.mjs";

const timeline = {
  generated_at: "2026-09-09T12:00:00.000Z",
  tracks: [
    { source_id: "primary_camera", media_kind: "video", source_path: "/tmp/host1.mp4", timeline_start_ms: 0, source_in_ms: 0, alignment: { playback_rate: 1 } },
    { source_id: "secondary_camera", media_kind: "video", source_path: "/tmp/host2.mp4", timeline_start_ms: 0, source_in_ms: 120, alignment: { playback_rate: 0.9999 } },
    { source_id: "host_1_audio", media_kind: "audio", source_path: "/tmp/host1.wav", timeline_start_ms: 0, source_in_ms: 0, alignment: { playback_rate: 1 } },
    { source_id: "host_2_audio", media_kind: "audio", source_path: "/tmp/host2.wav", timeline_start_ms: 0, source_in_ms: 50, alignment: { playback_rate: 1 } },
  ],
};
const segments = [
  { segment_id: "s1", speaker_id: "host_1", start_ms: 10_000, end_ms: 17_000, text: "Host one opens with a complete explanation." },
  { segment_id: "s2", speaker_id: "host_2", start_ms: 17_000, end_ms: 18_000, text: "Right." },
  { segment_id: "s3", speaker_id: "host_1", start_ms: 18_000, end_ms: 23_000, text: "Host one finishes the thought." },
  { segment_id: "s4", speaker_id: "host_2", start_ms: 23_000, end_ms: 28_000, text: "Host two now has a substantive response." },
  { segment_id: "s5", speaker_id: "host_2", start_ms: 28_000, end_ms: 33_000, text: "The response continues and resolves." },
  { segment_id: "s6", speaker_id: "host_1", start_ms: 33_000, end_ms: 34_000, text: "Exactly." },
  { segment_id: "s7", speaker_id: "host_2", start_ms: 34_000, end_ms: 40_000, text: "Host two lands the final point." },
];
const plan = buildSocialEditPlan({
  slug: "demo_episode",
  clip: { id: "clip_001", start: "00:00:10.000", end: "00:00:40.000", hook_overlay: "Workflow beats tools", crop_offset_px: 0 },
  timeline,
  transcriptSegments: segments,
  transcriptFingerprint: "transcript-fingerprint",
  speakerActivityFingerprint: "activity-fingerprint",
  generatedAt: "2026-09-09T12:01:00.000Z",
});

assert.equal(plan.schema, "eaol-social-edit-plan-v1");
assert.deepEqual(plan.video.shots.map((shot) => shot.source_id), ["primary_camera", "secondary_camera"]);
assert.equal(plan.video.shots[1].timeline_start_ms, 23_000);
assert.equal(plan.video.policy.maximum_automatic_switches, 4);
assert.deepEqual(plan.audio.tracks.map((track) => track.source_id), ["host_1_audio", "host_2_audio"]);
assert.equal(plan.captions.length, 7);
assert.equal(plan.publication_authorized, false);
const input = {
  slug: "demo_episode", timeline, transcriptSegments: segments,
  transcriptFingerprint: "transcript-fingerprint", speakerActivityFingerprint: "activity-fingerprint",
};
assert.throws(() => buildSocialEditPlan({ ...input, clip: { id: "clip_001", start: "00:00:12.000", end: "00:00:40.000" } }), /boundary cuts caption s1/);
assert.throws(() => buildSocialEditPlan({ ...input, clip: { id: "clip_001", start: "00:00:10.000", end: "00:00:38.000" } }), /boundary cuts caption s7/);
assert.throws(() => buildSocialEditPlan({ ...input, transcriptSegments: [...segments, { segment_id: "bleed", speaker_id: "host_2", start_ms: 12000, end_ms: 15000, text: "Overlapping words." }], clip: { id: "clip_001", start: "00:00:10.000", end: "00:00:40.000" } }), /overlap/);
console.log("PASS restrained edit plan ignores brief backchannels and switches only for a substantive transcript-bound turn");
console.log("PASS plan binds aligned cameras, isolated audio, reviewed captions, and conservative policy evidence");
console.log("PASS clipped and overlapping transcript cues are refused before a media job starts");
