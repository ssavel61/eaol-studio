#!/usr/bin/env node

import assert from "node:assert/strict";
import { classifySpeakerFrame, mergeActivityFrames } from "./speaker_activity.mjs";

const noise = 0.001;
assert.equal(classifySpeakerFrame(0.1, 0.002, noise, noise).state, "host_1");
assert.equal(classifySpeakerFrame(0.002, 0.1, noise, noise).state, "host_2");
assert.equal(classifySpeakerFrame(0.1, 0.09, noise, noise).state, "both");
assert.equal(classifySpeakerFrame(0.0002, 0.0002, noise, noise).state, "silence");
console.log("PASS speaker frames distinguish Host 1, Host 2, overlap, and silence");

const frames = [
  { start_ms: 0, end_ms: 100, ...classifySpeakerFrame(0.1, 0.002, noise, noise) },
  { start_ms: 100, end_ms: 200, ...classifySpeakerFrame(0.09, 0.002, noise, noise) },
  { start_ms: 200, end_ms: 300, ...classifySpeakerFrame(0.09, 0.08, noise, noise) },
];
const segments = mergeActivityFrames(frames);
assert.equal(segments.length, 2);
assert.equal(segments[0].state, "host_1");
assert.equal(segments[0].duration_ms, 200);
assert.equal(segments[1].state, "both");
console.log("PASS contiguous evidence frames merge without losing overlap state");
