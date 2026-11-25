#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  applySpeakerTranscriptReview,
  buildSpeakerTranscriptReview,
  speakerTranscriptReviewSrt,
} from "./speaker_transcript_review.mjs";

const speakerTranscript = {
  generated_at: "2026-08-16T19:00:00.000Z",
  segments: [
    { speaker_id: "host_1", speaker_label: "Host 1", source_id: "host_1_audio", start_ms: 1000, end_ms: 2000, text: "The wrong word." },
    { speaker_id: "host_2", speaker_label: "Host 2", source_id: "host_2_audio", start_ms: 2100, end_ms: 3000, text: "Second line." },
  ],
};
const manifest = { sources: [] };
const timeline = { generated_at: "2026-08-16T18:30:00.000Z" };
const review = buildSpeakerTranscriptReview({
  speakerTranscript,
  manifest,
  timeline,
  status: "draft",
  rolesSwapped: true,
  edits: { segment_0001: "The corrected word." },
  speakerOverrides: { segment_0002: "host_2" },
  dismissedSegmentIds: ["segment_0002"],
  confirmedOverlapPairIds: ["bleed_pair:segment_0001:segment_0002"],
  updatedAt: "2026-08-16T19:30:00.000Z",
});
const effective = applySpeakerTranscriptReview(speakerTranscript, review);
assert.equal(review.wording_correction_count, 1);
assert.equal(review.speaker_correction_count, 1);
assert.equal(review.dismissed_bleed_count, 1);
assert.equal(review.confirmed_overlap_pair_count, 1);
assert.equal(review.correction_count, 3);
assert.equal(review.render_authorized, false);
assert.equal(effective[0].speaker_label, "Host 2");
assert.equal(effective[1].speaker_label, "Host 2");
assert.equal(effective[0].text, "The corrected word.");
assert.equal(effective[0].source_id, "host_1_audio");
assert.match(speakerTranscriptReviewSrt(effective), /\[Host 2\] The corrected word\./);
assert.doesNotMatch(speakerTranscriptReviewSrt(effective), /Second line/);
assert.throws(() => buildSpeakerTranscriptReview({
  speakerTranscript,
  manifest,
  timeline,
  status: "approved",
  edits: { missing_segment: "Nope" },
}), /unknown transcript segment/);
assert.throws(() => buildSpeakerTranscriptReview({
  speakerTranscript,
  manifest,
  timeline,
  status: "draft",
  edits: { segment_0001: "" },
}), /cannot be empty/);
assert.throws(() => buildSpeakerTranscriptReview({
  speakerTranscript,
  manifest,
  timeline,
  status: "draft",
  speakerOverrides: { segment_0001: "guest" },
}), /speaker must be host_1 or host_2/);

console.log("PASS transcript wording corrections preserve timing and source evidence");
console.log("PASS role swap changes generic labels without rewriting source roles");
console.log("PASS correction receipts reject unknown or empty segment edits");
console.log("PASS corrected transcript remains review-only and exportable as SRT");
console.log("PASS per-line speaker corrections and dismissed bleed remain receipt-backed");
