#!/usr/bin/env node

import assert from "node:assert/strict";
import { buildCompatibility } from "./ingest.mjs";

function camera(label, { fps = 30, width = 3840, height = 2160, duration = 120 } = {}) {
  return {
    label,
    expected_kind: "video",
    duration_sec: duration,
    video: { fps, width, height, codec: "hevc" },
    audio: { sample_rate: 48000, channels: 2, codec: "aac" },
  };
}

function audio(label, { sampleRate = 48000, duration = 120 } = {}) {
  return {
    label,
    expected_kind: "audio",
    duration_sec: duration,
    video: null,
    audio: { sample_rate: sampleRate, channels: 1, codec: "pcm_s24le" },
  };
}

const ready = buildCompatibility([
  camera("Host 1 camera"),
  camera("Host 2 camera"),
  audio("Host 1 isolated audio"),
  audio("Host 2 isolated audio"),
]);
assert.equal(ready.status, "ready");
assert.equal(ready.camera_count, 2);
assert.equal(ready.isolated_audio_count, 2);
assert.equal(ready.sync_status, "not_measured");
assert.equal(ready.warnings.length, 0);

const attention = buildCompatibility([
  camera("Host 1 camera", { fps: 30, duration: 120 }),
  camera("Host 2 camera", { fps: 25, width: 1920, height: 1080, duration: 108 }),
  audio("Host 1 isolated audio", { sampleRate: 48000 }),
  audio("Host 2 isolated audio", { sampleRate: 44100 }),
]);
assert.equal(attention.status, "attention");
assert.match(attention.warnings.join(" "), /frame rates differ/);
assert.match(attention.warnings.join(" "), /below 4K/);
assert.match(attention.warnings.join(" "), /durations differ/);
assert.match(attention.warnings.join(" "), /sample rates differ/);

const missingRoles = buildCompatibility([camera("Host 1 camera")]);
assert.equal(missingRoles.status, "attention");
assert.match(missingRoles.warnings.join(" "), /Only one camera/);
assert.match(missingRoles.warnings.join(" "), /Two isolated host audio tracks/);

const blocked = buildCompatibility([
  { label: "Host 1 camera", expected_kind: "video", duration_sec: 0, video: null, audio: null },
]);
assert.equal(blocked.status, "blocked");
assert.equal(blocked.blocking.length, 2);

console.log("PASS compatible two-camera and isolated-audio source set");
console.log("PASS mismatched frame rate, resolution, duration, and sample-rate warnings");
console.log("PASS missing-role guidance and blocking media checks");
