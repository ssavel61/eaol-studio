#!/usr/bin/env node

import assert from "node:assert/strict";
import { buildBleedReviewAssistant, bleedPairId } from "./bleed_review_assistant.mjs";

const segments = [
  { segment_id: "segment_0001", speaker_id: "host_2", speaker_label: "Host 2", start_ms: 51_000, end_ms: 53_500, start: "00:00:51.000", end: "00:00:53.500", text: "Host 1, how does it feel to be here, friend?", dominance_db: -10, dominance_decision: "assigned_track_dominant" },
  { segment_id: "segment_0002", speaker_id: "host_1", speaker_label: "Host 1", start_ms: 56_300, end_ms: 56_800, start: "00:00:56.300", end: "00:00:56.800", text: "friend?", dominance_db: 1, dominance_decision: "overlap_or_uncertain" },
  { segment_id: "segment_0003", speaker_id: "host_1", speaker_label: "Host 1", start_ms: 70_000, end_ms: 72_000, start: "00:01:10.000", end: "00:01:12.000", text: "A clean answer.", dominance_db: 11, dominance_decision: "assigned_track_dominant" },
  { segment_id: "segment_0004", speaker_id: "host_2", speaker_label: "Host 2", start_ms: 70_500, end_ms: 72_500, start: "00:01:10.500", end: "00:01:12.500", text: "A different interruption.", dominance_db: -9, dominance_decision: "assigned_track_dominant" },
];

const pending = buildBleedReviewAssistant(segments);
assert.equal(pending.pending_count, 1);
assert.equal(pending.pairs[0].recommended_dismiss_segment_id, "segment_0002");
assert.equal(pending.provider_connected, false);
assert.equal(pending.automatic_dismissal, false);

const pairId = bleedPairId("segment_0001", "segment_0002");
const kept = buildBleedReviewAssistant(segments, { confirmed_overlap_pair_ids: [pairId] });
assert.equal(kept.pending_count, 0);
assert.equal(kept.pairs[0].status, "confirmed_overlap");

const dismissed = buildBleedReviewAssistant(segments.map((segment) => segment.segment_id === "segment_0002"
  ? { ...segment, dismissed_as_bleed: true }
  : segment));
assert.equal(dismissed.pending_count, 0);
assert.equal(dismissed.pairs[0].status, "dismissed");

console.log("PASS local assistant pairs likely cross-mic duplicates without provider calls");
console.log("PASS dominance evidence recommends the weaker uncertain copy");
console.log("PASS genuine different overlap is not flagged");
console.log("PASS dismiss and keep-both decisions resolve receipt-backed pairs");
