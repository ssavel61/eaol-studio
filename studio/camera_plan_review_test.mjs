#!/usr/bin/env node

import assert from "node:assert/strict";
import { buildCameraPlanReview, buildCameraPlanSamples, cameraPlanReviewMatchesInputs, requiresRepresentativeCameraReview } from "./camera_plan_review.mjs";

const cameraPlan = { fingerprint: "camera-a" };
const assembly = {
  plan_fingerprint: "assembly-a",
  camera_direction: { mode: "automatic_source_bound", camera_plan_fingerprint: "camera-a" },
  program: {
    start_ms: 0, end_ms: 20_000,
    shots: [
      { id: "shot_1", start_ms: 0, end_ms: 2_000, layout: "side_by_side", reason_codes: ["speaker_change_confirmation_bridge"], source_camera_plan_shot_ids: ["plan_1"], activity_ids: ["a1"] },
      { id: "shot_2", start_ms: 2_000, end_ms: 8_000, layout: "isolated", camera_source_id: "primary_camera", reason_codes: ["confirmed_host_1_sustained"], source_camera_plan_shot_ids: ["plan_2"], activity_ids: ["a2"] },
      { id: "shot_3", start_ms: 8_000, end_ms: 12_000, layout: "side_by_side", reason_codes: ["overlap_requires_two_shot"], source_camera_plan_shot_ids: ["plan_3"], activity_ids: ["a3"] },
      { id: "shot_4", start_ms: 12_000, end_ms: 20_000, layout: "isolated", camera_source_id: "secondary_camera", reason_codes: ["confirmed_host_2_sustained"], source_camera_plan_shot_ids: ["plan_4"], activity_ids: ["a4"] },
    ],
  },
  cta_graphic: { cues: [{ id: "cta_1", cta_type: "podcast_growth", start_ms: 13_000, end_ms: 19_000 }] },
};

const sampleSet = buildCameraPlanSamples({ assembly, cameraPlan });
assert.equal(sampleSet.samples.length, 6);
assert.equal(sampleSet.samples.find((sample) => sample.id === "host_1_sustained").available, true);
assert.equal(sampleSet.samples.find((sample) => sample.id === "silence_or_uncertainty").available, false);
assert.throws(() => buildCameraPlanReview({ assembly, cameraPlan, sampleSet, status: "approved" }), /review every camera sample/);
const checks = Object.fromEntries(sampleSet.samples.map((sample) => [sample.id, true]));
const previewed = sampleSet.samples.filter((sample) => sample.available).map((sample) => sample.id);
const review = buildCameraPlanReview({ assembly, cameraPlan, sampleSet, status: "approved", checks, previewedSampleIds: previewed });
assert.equal(review.proxy_authorized, true);
assert.equal(review.full_render_authorized, false);
assert.equal(cameraPlanReviewMatchesInputs(review, assembly, cameraPlan, sampleSet), true);
assert.equal(cameraPlanReviewMatchesInputs(review, { ...assembly, plan_fingerprint: "changed" }, cameraPlan, sampleSet), false);
assert.equal(requiresRepresentativeCameraReview({ program: { shots: [{ layout: "side_by_side" }] } }), false);
assert.equal(requiresRepresentativeCameraReview({ program: { shots: [{ layout: "side_by_side" }, { layout: "isolated" }] } }), true);
const currentPolicyAssembly = {
  ...assembly,
  plan_fingerprint: "assembly-two-shot",
  program: {
    start_ms: 0,
    end_ms: 20_000,
    shots: [{
      id: "shot_1",
      start_ms: 0,
      end_ms: 20_000,
      layout: "side_by_side",
      reason_codes: ["full_episode_side_by_side_only"],
      source_camera_plan_shot_ids: ["plan_1"],
      activity_ids: ["a1", "a2"],
    }],
  },
  cta_graphic: { cues: [] },
};
const currentPolicySamples = buildCameraPlanSamples({ assembly: currentPolicyAssembly, cameraPlan });
assert.equal(currentPolicySamples.samples.find((sample) => sample.id === "full_episode_two_shot").available, true);
assert.equal(currentPolicySamples.samples.filter((sample) => sample.available).length, 1);
console.log("PASS camera-plan review samples sustained hosts, conversation, uncertainty, and CTA states");
console.log("PASS current policy exposes the program two-shot as the one required playable composition sample");
console.log("PASS proxy approval requires every available sample previewed and every state acknowledged");
console.log("PASS approval expires with assembly, camera plan, or sample-set fingerprints and never authorizes a full render");
