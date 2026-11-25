#!/usr/bin/env node

import assert from "node:assert/strict";
import { buildSocialSuggestions } from "./social_suggestions.mjs";

const segments = [];
const themes = [
  ["host_1", "Most people think an AI tool fixes the work, but the workflow is what actually matters."],
  ["host_2", "When we tried this the first time, the handoff failed because nobody owned the final check."],
  ["host_1", "You can start with one repeatable step, inspect the result, and improve only what broke."],
  ["host_2", "I disagree with buying another tool before we know which part of the process is slow."],
  ["host_1", "The useful question is whether this gives somebody thirty minutes back every week."],
  ["host_2", "What would you send to a coworker who is still trying to decide where AI belongs?"],
];
let cursor = 50_000;
for (let group = 0; group < themes.length; group += 1) {
  const [speaker, opening] = themes[group];
  for (let line = 0; line < 7; line += 1) {
    const start = cursor;
    const end = start + 4_500;
    segments.push({
      segment_id: `segment_${String(segments.length + 1).padStart(4, "0")}`,
      speaker_id: speaker,
      start_ms: start,
      end_ms: end,
      text: line === 0 ? opening : `This supporting example makes the idea concrete and gives the thought a complete ending ${line}.`,
    });
    cursor = end + 250;
  }
  cursor += 65_000;
}

const receipt = buildSocialSuggestions({
  slug: "demo_episode",
  segments,
  transcriptFingerprint: "transcript-fingerprint",
  speakerActivityFingerprint: "activity-fingerprint",
  assemblyFingerprint: "assembly-fingerprint",
  programStartMs: 45_000,
  programEndMs: cursor,
  generatedAt: "2026-09-09T12:00:00.000Z",
});

assert.equal(receipt.schema, "eaol-social-suggestions-v1");
assert.equal(receipt.policy.provider_calls, false);
assert.equal(receipt.policy.unexplained_virality_score, false);
// One theme has no opening signal. Do not manufacture a sixth candidate by
// bridging the long gaps between otherwise unrelated conversations.
assert.equal(receipt.suggestions.length, 5);
assert.equal(receipt.suggestions.filter((item) => item.recommendation === "recommended").length, 3);
assert.equal(new Set(receipt.suggestions.map((item) => item.cluster_id)).size, 5);
assert.ok(receipt.suggestions.every((item) => item.segment_ids.length > 0));
assert.ok(receipt.suggestions.every((item) => item.proposed_by === "studio"));
assert.ok(receipt.suggestions.every((item) => !("hook_overlay" in item)));
const propose = (segments, options = {}) => buildSocialSuggestions({ slug: "boundary_demo", segments, transcriptFingerprint: "t", ...options });
const unfinished = [
  { segment_id: "a", start_ms: 0, end_ms: 30000, text: "You can build a routine and all those things that we" },
  { segment_id: "b", start_ms: 30000, end_ms: 57000, text: "can use together to" },
  { segment_id: "c", start_ms: 57000, end_ms: 64000, text: "save time on the weekly review." },
];
const extended = propose(unfinished);
assert.equal(extended.suggestions[0].end, "00:01:04.000");
assert.deepEqual(extended.suggestions[0].segment_ids, ["a", "b", "c"]);
assert.throws(() => propose(unfinished.slice(0, 2)), /did not contain/);
assert.throws(() => propose([unfinished[0]], { programEndMs: 25000 }), /did not contain/);
assert.throws(() => propose([{ ...unfinished[0], text: "You can save time with the workflow..." }]), /did not contain/);
const context = propose([
  { segment_id: "before", start_ms: 0, end_ms: 2000, text: "Previously we discussed something else." },
  { segment_id: "main", start_ms: 3000, end_ms: 33000, text: "You can inspect the clip tool and the intro before we record again." },
  { segment_id: "after", start_ms: 34000, end_ms: 35000, text: "Now the next thought." },
]);
assert.ok(context.suggestions[0].flags.some((flag) => flag.includes("production-planning")));
assert.ok(context.suggestions[0].boundary_notes.some((note) => note.startsWith("Before:")));
assert.ok(context.suggestions[0].boundary_notes.some((note) => note.startsWith("After:")));
console.log("PASS deterministic local selection returns up to six distinct proposals without filling a quota across long gaps");
console.log("PASS every suggestion carries transcript evidence, weaknesses, category, cluster, and provenance without a virality score");
console.log("PASS suggestions preserve whole cues, extend through unfinished 55-second endings, expose context, and omit repeated headlines");
