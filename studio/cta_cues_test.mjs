#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildCtaCueState,
  buildCtaGraphicManifest,
  ctaGraphicCueSheet,
  detectCtaCues,
  updateCtaCueReview,
} from "./cta_cues.mjs";

const transcript = [
  { start: "00:00:10.000", end: "00:00:13.000", text: "I like this approach because it stays simple." },
  { start: "00:00:20.000", end: "00:00:24.000", text: "Please like, comment, and subscribe before you go." },
  { start: "00:00:24.500", end: "00:00:27.000", text: "Share it with someone who would enjoy it." },
  { start: "00:00:40.000", end: "00:00:43.000", text: "Tell us in the comments what you tried." },
  { start: "00:00:50.000", end: "00:00:54.000", text: "Subscribe to Example Newsletter for more." },
];

const detected = detectCtaCues(transcript);
assert.equal(detected.length, 3);
assert.deepEqual(detected[0].actions, ["like", "comment", "subscribe"]);
assert.equal(detected[0].matched_text, transcript[1].text);
assert.deepEqual(detected[1].actions, ["comment"]);
assert.equal(detected[2].cta_type, "newsletter");
assert.ok(!detected.some((cue) => cue.matched_text.includes("like this approach")));

const initial = buildCtaCueState(transcript);
assert.equal(initial.detected_count, 3);
assert.equal(initial.confirmed_count, 0);
const confirmed = updateCtaCueReview({
  segments: transcript,
  cueId: initial.cues[0].id,
  status: "confirmed",
  updatedAt: "2026-08-22T20:00:00.000Z",
});
assert.equal(confirmed.state.confirmed_count, 1);

const manual = updateCtaCueReview({
  segments: transcript,
  currentReview: confirmed.review,
  segmentIndex: 1,
  status: "confirmed",
  updatedAt: "2026-08-22T20:01:00.000Z",
});
assert.equal(manual.state.confirmed_count, 2);
assert.equal(manual.state.cues.find((cue) => cue.source === "manual").matched_text, transcript[0].text);

const newsletter = updateCtaCueReview({
  segments: transcript,
  currentReview: manual.review,
  cueId: manual.state.cues.find((cue) => cue.cta_type === "newsletter").id,
  status: "confirmed",
  ctaType: "newsletter",
  updatedAt: "2026-08-22T20:01:30.000Z",
});
assert.equal(newsletter.state.confirmed_count, 3);

const manifest = buildCtaGraphicManifest({ slug: "episode_test", state: newsletter.state, generatedAt: "2026-08-22T20:02:00.000Z" });
assert.equal(manifest.cues.length, 3);
assert.equal(manifest.cues.find((cue) => cue.cta_type === "newsletter").actions[0], "subscribe");
assert.equal(manifest.render_authorized, false);
assert.equal(manifest.cue_review_updated_at, newsletter.review.updated_at);
assert.match(ctaGraphicCueSheet(manifest), /Scrub window/);
assert.match(ctaGraphicCueSheet(manifest), /podcast-growth and newsletter-subscription treatments remain separate/i);

const changedTranscript = structuredClone(transcript);
changedTranscript[1].text = "Please subscribe before you go.";
const stale = buildCtaCueState(changedTranscript, newsletter.review);
assert.equal(stale.review_stale, true);
assert.equal(stale.confirmed_count, 0);

console.log("PASS CTA wording detection avoids conversational-like false positives");
console.log("PASS podcast-growth and newsletter CTA cues remain separately classified");
console.log("PASS detected CTA cues require human confirmation");
console.log("PASS any transcript line can become a manual graphic cue");
console.log("PASS confirmed cues produce an editor-facing manifest and cue sheet");
console.log("PASS transcript changes expire prior CTA decisions");
