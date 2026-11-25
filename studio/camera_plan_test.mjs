#!/usr/bin/env node

import assert from "node:assert/strict";
import { buildCameraDecisions } from "./camera_plan.mjs";

const speakerActivity = {
  segments: [
    { id: "a1", start_ms: 0, end_ms: 3_000, state: "host_1", confidence: 0.9 },
    { id: "a2", start_ms: 3_000, end_ms: 3_500, state: "host_2", confidence: 0.8 },
    { id: "a3", start_ms: 3_500, end_ms: 5_500, state: "both", confidence: 0.7 },
    { id: "a4", start_ms: 5_500, end_ms: 9_000, state: "host_2", confidence: 0.92 },
    { id: "a5", start_ms: 9_000, end_ms: 10_000, state: "uncertain", confidence: 0.2 },
  ],
};

const shots = buildCameraDecisions({ speakerActivity });
assert.equal(shots.length, 1);
assert.equal(shots[0].start_ms, 0);
assert.equal(shots[0].end_ms, 10_000);
assert.equal(shots[0].layout, "side_by_side");
assert.deepEqual(shots[0].camera_source_ids, ["primary_camera", "secondary_camera"]);
assert.equal(shots.some((shot) => shot.layout === "isolated"), false);
assert.deepEqual(shots[0].activity_ids, ["a1", "a2", "a3", "a4", "a5"]);
assert.equal(shots.every((shot) => shot.transition_in.type === "cut"), true);
console.log("PASS full episodes remain on one continuous side-by-side shot");
console.log("PASS speaker changes, backchannels, overlap, and uncertainty do not trigger solo cuts");
console.log("PASS clip framing remains a separate workflow concern");
