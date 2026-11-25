#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliveryTextMatchesInputs,
  mapTranscriptToFinalTimeline,
  parseChapterLines,
  suggestChapterLines,
  validateChapters,
  writeDeliveryText,
} from "./delivery_text.mjs";

const root = mkdtempSync(join(tmpdir(), "eaol-delivery-text-test-"));
const workDir = join(root, "work", "demo");
const episodeDir = join(workDir, "episode");
mkdirSync(episodeDir, { recursive: true });

function writeJson(name, value) {
  writeFileSync(join(workDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

try {
  const fullPath = join(episodeDir, "episode_full.mp4");
  writeFileSync(fullPath, "synthetic full render receipt bytes");
  const fullStat = statSync(fullPath);
  const render = {
    status: "complete", quality: "full", full_render_authorized: true, source_slug: "demo",
    assembly_fingerprint: "assembly-a",
    segments: [
      { type: "opening", duration_sec: 12 },
      { type: "program", duration_sec: 96 },
      { type: "closing", duration_sec: 12 },
    ],
    output: { path: fullPath, bytes: fullStat.size, modified_ms: Math.round(fullStat.mtimeMs), duration_sec: 120 },
  };
  const assembly = {
    title: "Final timeline test", plan_fingerprint: "assembly-a",
    program: { start_ms: 20_000, end_ms: 116_000, duration_ms: 96_000 },
  };
  const timeline = { generated_at: "2026-08-30T18:00:00.000Z", stale: false };
  const speakerTranscript = {
    generated_at: "2026-08-30T18:01:00.000Z",
    segments: [
      { segment_id: "segment_0001", speaker_id: "host_1", speaker_label: "Host 1", start_ms: 18_000, end_ms: 24_000, text: "Opening program line." },
      { segment_id: "segment_0002", speaker_id: "host_2", speaker_label: "Host 2", start_ms: 50_000, end_ms: 55_000, text: "Correct this wording." },
      { segment_id: "segment_0003", speaker_id: "host_1", speaker_label: "Host 1", start_ms: 115_000, end_ms: 118_000, text: "Closing program line." },
      { segment_id: "segment_0004", speaker_id: "host_2", speaker_label: "Host 2", start_ms: 50_000, end_ms: 55_000, text: "Dismissed microphone bleed." },
    ],
  };
  const review = {
    status: "approved",
    base_transcript_generated_at: speakerTranscript.generated_at,
    timeline_generated_at: timeline.generated_at,
    input_signatures: [],
    roles_swapped: false,
    edits: { segment_0002: "Corrected wording." },
    dismissed_segment_ids: ["segment_0004"],
    reviewed_at: "2026-08-30T18:02:00.000Z",
  };
  writeJson("episode_render.json", render);
  writeJson("episode_assembly.json", assembly);
  writeJson("episode.json", { sources: [] });
  writeJson("timeline.json", timeline);
  writeJson("speaker_transcript.json", speakerTranscript);
  writeJson("speaker_transcript_review.json", review);

  const mapped = mapTranscriptToFinalTimeline(speakerTranscript.segments, assembly, render);
  assert.equal(mapped[0].start_ms, 12_000);
  assert.equal(mapped[0].end_ms, 16_000);
  assert.equal(mapped[2].start_ms, 107_000);
  assert.equal(mapped[2].end_ms, 108_000);
  assert.equal(mapTranscriptToFinalTimeline([
    { ...speakerTranscript.segments[3], dismissed_as_bleed: true },
    speakerTranscript.segments[1],
  ], assembly, render).length, 1);
  const suggestions = suggestChapterLines(120_000, 12_000);
  assert.equal(suggestions.length, 3);
  assert.deepEqual(parseChapterLines(["00:00 Opening", "00:40 Main", "01:20 Close"]).map((chapter) => chapter.start_ms), [0, 40_000, 80_000]);
  assert.throws(() => validateChapters(parseChapterLines(["00:00 One", "00:05 Two", "00:20 Three"]), 40_000), /at least 10 seconds/);
  console.log("PASS final-timeline mapping clips program-edge cues and offsets them after the opening");
  console.log("PASS chapter parser enforces 00:00, three entries, increasing times, and ten-second sections");

  const receipt = writeDeliveryText(workDir, { chapterLines: ["00:00 Opening", "00:40 Main topic", "01:20 Closing thoughts"], generatedAt: "2026-08-30T18:03:00.000Z" });
  assert.equal(receipt.caption_count, 3);
  assert.equal(receipt.files.srt.sha256.length, 64);
  assert.equal(receipt.files.vtt.sha256.length, 64);
  assert.equal(receipt.checks.caption_bounds, true);
  assert.equal(receipt.publication_authorized, false);
  assert.match(readFileSync(receipt.files.srt.path, "utf8"), /00:00:12,000 --> 00:00:16,000/);
  assert.match(readFileSync(receipt.files.srt.path, "utf8"), /Corrected wording/);
  assert.match(readFileSync(receipt.files.vtt.path, "utf8"), /^WEBVTT/);
  assert.match(readFileSync(receipt.files.transcript.path, "utf8"), /## Opening — 00:00:00/);
  assert.match(readFileSync(receipt.files.transcript.path, "utf8"), /## Closing — 00:01:48/);
  assert.match(readFileSync(receipt.files.chapters.path, "utf8"), /^00:00 Opening/m);
  for (const key of ["srt", "vtt", "transcript"]) {
    const output = readFileSync(receipt.files[key].path, "utf8");
    assert.doesNotMatch(output, /Dismissed microphone bleed/);
    assert.match(output, /Corrected wording/);
    assert.match(output, /Closing program line/);
  }
  assert.equal(JSON.parse(readFileSync(join(workDir, "speaker_transcript.json"), "utf8")).segments.length, 4);
  assert.equal(deliveryTextMatchesInputs(receipt, render, speakerTranscript, review), true);
  assert.equal(deliveryTextMatchesInputs(receipt, { ...render, assembly_fingerprint: "changed" }, speakerTranscript, review), false);
  console.log("PASS reviewed transcript produces checksum-bound final SRT, VTT, transcript, and chapter files");
  console.log("PASS human-dismissed bleed stays in source evidence but never enters captions or readable delivery text");
  console.log("PASS final text expires with its render or transcript review and never authorizes external delivery");
} finally {
  rmSync(root, { recursive: true, force: true });
}
