#!/usr/bin/env node

import assert from "node:assert/strict";
import { filterSegmentsByDominance, mapCuesToTimeline, mergeSpeakerCues, parseSrt } from "./speaker_transcript.mjs";

const parsed = parseSrt("1\n00:00:00,500 --> 00:00:01,500\nHello from host one.\n");
assert.equal(parsed.length, 1);
assert.equal(parsed[0].start_ms, 500);

const hostOneTrack = {
  source_id: "host_1_audio",
  timeline_start_ms: 0,
  timeline_end_ms: 10_000,
  alignment: { start_offset_ms: 500, playback_rate: 1.001 },
};
const mapped = mapCuesToTimeline(parsed, hostOneTrack, {
  source_id: "host_1_audio",
  speaker_id: "host_1",
  speaker_label: "Host 1",
});
assert.equal(mapped[0].start_ms, 0);
assert.equal(mapped[0].speaker_label, "Host 1");
assert.equal(mapped[0].end_ms, 999);

const timeline = {
  tracks: [
    { ...hostOneTrack, source_id: "host_1_audio", alignment: { start_offset_ms: 0, playback_rate: 1 } },
    { ...hostOneTrack, source_id: "host_2_audio", alignment: { start_offset_ms: 0, playback_rate: 1 } },
  ],
};
const merged = mergeSpeakerCues({
  timeline,
  hostCues: {
    host_1_audio: [{ start_ms: 1000, end_ms: 2500, text: "First thought." }],
    host_2_audio: [{ start_ms: 2000, end_ms: 3200, text: "A brief interruption." }],
  },
});
assert.equal(merged.segments.length, 2);
assert.equal(merged.segments[0].speaker_id, "host_1");
assert.equal(merged.segments[1].speaker_id, "host_2");
assert.equal(merged.overlaps.length, 1);
assert.equal(merged.overlaps[0].overlap_ms, 500);

const stacked = mergeSpeakerCues({
  timeline,
  hostCues: {
    host_1_audio: [{ start_ms: 1000, end_ms: 5000, text: "A longer explanation." }],
    host_2_audio: [
      { start_ms: 2000, end_ms: 2500, text: "First interjection." },
      { start_ms: 3000, end_ms: 3500, text: "Second interjection." },
    ],
  },
});
assert.equal(stacked.overlaps.length, 2);
assert.deepEqual(stacked.overlaps.map((overlap) => overlap.overlap_ms), [500, 500]);

const dominanceFiltered = filterSegmentsByDominance([
  { speaker_id: "host_1", text: "Host one direct" },
  { speaker_id: "host_2", text: "Host one bleed" },
  { speaker_id: "host_1", text: "True overlap one" },
  { speaker_id: "host_2", text: "True overlap two" },
], (segment) => segment.text.startsWith("Host one")
  ? { host_1_rms: 0.1, host_2_rms: 0.02 }
  : { host_1_rms: 0.08, host_2_rms: 0.07 });
assert.deepEqual(dominanceFiltered.segments.map((segment) => segment.text), ["Host one direct", "True overlap one", "True overlap two"]);
assert.equal(dominanceFiltered.suppressed[0].text, "Host one bleed");

console.log("PASS isolated SRT cues map through confirmed timeline offsets and drift");
console.log("PASS merged segments preserve Host 1/Host 2 labels and chronological order");
console.log("PASS conversational overlaps remain visible for human review");
console.log("PASS one long utterance retains every overlapping interjection");
console.log("PASS dominant isolated mic suppresses bleed while uncertain overlap is preserved");
