#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveTool } from "../platform_tools.mjs";
import { renderSocialClip, socialAss } from "./social_clip_renderer.mjs";
import { SOCIAL_QUALITY_VERSION, buildCaptionLayout } from "./social_captions.mjs";

const root = mkdtempSync(join(tmpdir(), "eaol-social-render-test-"));
const ffmpeg = resolveTool("ffmpeg");
const workDir = join(root, "work", "demo");
mkdirSync(workDir, { recursive: true });

function make(path, source) {
  const result = spawnSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", source, "-t", "8", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

try {
  const cameraOne = join(root, "one.mp4");
  const cameraTwo = join(root, "two.mp4");
  const audioOne = join(root, "one.wav");
  const audioTwo = join(root, "two.wav");
  make(cameraOne, "testsrc2=s=320x180:r=30");
  make(cameraTwo, "testsrc=s=320x180:r=30");
  make(audioOne, "sine=frequency=440:sample_rate=48000");
  make(audioTwo, "sine=frequency=550:sample_rate=48000");
  const plan = {
    schema: "eaol-social-edit-plan-v1",
    status: "render_ready",
    quality_policy_version: SOCIAL_QUALITY_VERSION,
    fingerprint: "plan-fingerprint",
    transcript_fingerprint: "transcript-fingerprint",
    duration_ms: 8_000,
    crop_offset_px: 0,
    hook_overlay: "Workflow beats tools",
    captions: [
      { segment_id: "s1", start_ms: 0, end_ms: 4_000, text: "The workflow matters more than the tool." },
      { segment_id: "s2", start_ms: 4_000, end_ms: 8_000, text: "Inspect the result and improve what broke." },
    ],
    video: { shots: [
      { source_id: "primary_camera", source_path: cameraOne, timeline_start_ms: 0, timeline_end_ms: 4_000, source_start_ms: 0, source_end_ms: 4_000, playback_rate: 1 },
      { source_id: "secondary_camera", source_path: cameraTwo, timeline_start_ms: 4_000, timeline_end_ms: 8_000, source_start_ms: 4_000, source_end_ms: 8_000, playback_rate: 1 },
    ] },
    audio: { tracks: [
      { source_id: "host_1_audio", source_path: audioOne, source_start_ms: 0, source_end_ms: 8_000, playback_rate: 1 },
      { source_id: "host_2_audio", source_path: audioTwo, source_start_ms: 0, source_end_ms: 8_000, playback_rate: 1 },
    ] },
  };
  writeFileSync(join(workDir, "social_edit_plans.json"), `${JSON.stringify({ schema: "eaol-social-edit-plans-v1", plans: { clip_001: plan } }, null, 2)}\n`);
  assert.match(socialAss(plan), /Dialogue: 1,0:00:00\.00,0:00:03\.00,Hook/);
  assert.match(socialAss(plan), /Workflow beats tools/);
  assert.doesNotMatch(socialAss({ ...plan, hook_overlay: "The workflow matters" }), /Dialogue: 1,/);
  const longText = "A useful workflow starts with one clear problem and a person who checks every result before sharing it so another person can follow the process and know exactly where to improve it next.";
  const layout = buildCaptionLayout([{ segment_id: "long", start_ms: 0, end_ms: 8000, text: longText }], 0, 8000);
  assert.ok(layout.pages.length > 1);
  assert.ok(layout.pages.every((page) => page.lines.length <= 2));
  assert.ok(layout.pages.every((page) => page.end_ms - page.start_ms >= 840), "rebalance the orphan final phrase rather than flashing it for a fraction of a second");
  assert.equal(layout.pages.flatMap((page) => page.lines).join(" "), longText);
  assert.ok(layout.warnings.some((warning) => warning.includes("estimated")));
  assert.throws(() => buildCaptionLayout([
    { segment_id: "a", start_ms: 0, end_ms: 6000, text: "The first speaker." },
    { segment_id: "b", start_ms: 2000, end_ms: 5000, text: "A second speaker." },
  ], 0, 8000), /a and b overlap/);
  assert.throws(() => buildCaptionLayout([{ segment_id: "cut", start_ms: 0, end_ms: 9000, text: "Unheard final words." }], 0, 8000), /boundary cuts caption cut/);
  assert.throws(() => socialAss({ ...plan, hook_overlay: "{\\pos(0,0)}" }), /control characters/);
  assert.throws(() => buildCaptionLayout([{ segment_id: "bad", start_ms: NaN, end_ms: 5000, text: "Missing timing." }], 0, 8000), /invalid text or timing/);
  const adjacent = buildCaptionLayout([
    { segment_id: "a", start_ms: 0, end_ms: 4005, text: "The first caption." },
    { segment_id: "b", start_ms: 4005, end_ms: 8000, text: "The next caption." },
  ], 0, 8000);
  assert.ok(adjacent.checks.no_overlapping_pages);
  // Render a long cue too: pure layout checks alone cannot prove libass burns
  // every page into valid video.
  plan.captions = [{ segment_id: "long", start_ms: 0, end_ms: 8000, text: longText }];
  writeFileSync(join(workDir, "social_edit_plans.json"), JSON.stringify({ plans: { clip_001: plan } }));
  const receipt = renderSocialClip(workDir, { clipId: "clip_001", generatedAt: "2026-09-09T12:00:00.000Z", testMode: true });
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.output.width, 1080);
  assert.equal(receipt.output.height, 1920);
  assert.equal(receipt.output.sample_rate, 48_000);
  assert.ok(Object.values(receipt.checks).every(Boolean));
  assert.equal(receipt.quality_policy_version, SOCIAL_QUALITY_VERSION);
  assert.equal(receipt.caption_layout.page_count, layout.pages.length);
  const stalePlan = { ...plan };
  delete stalePlan.quality_policy_version;
  writeFileSync(join(workDir, "social_edit_plans.json"), JSON.stringify({ plans: { clip_001: stalePlan } }));
  assert.throws(() => renderSocialClip(workDir, { clipId: "clip_001" }), /rebuild the social edit plan/);
  const saved = JSON.parse(readFileSync(join(workDir, "social_render_receipts.json"), "utf8"));
  assert.equal(saved.renders.clip_001.edit_plan_fingerprint, "plan-fingerprint");
  console.log("PASS source-bound social renderer cuts aligned camera shots and mixes both isolated tracks");
  console.log("PASS renderer burns reviewed captions and records full-decode, stream, duration, black, freeze, silence, and checksum evidence");
  console.log("PASS lossless two-line pages, approximate-timing warnings, overlap/boundary refusal, repeated-hook suppression, and stale-policy refusal");
} finally {
  rmSync(root, { recursive: true, force: true });
}
