#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeChannelSlate, buildChannelPreflight, channelPreflightMatchesInputs } from "./channel_preflight.mjs";

const rate = 1_000;

function slate({ swap = false, identical = false, omitHost2 = false } = {}) {
  const samples = new Float32Array(17 * rate * 2);
  for (let frame = 0; frame < 17 * rate; frame++) {
    const time = frame / rate;
    const noise = Math.sin(frame * 0.71) * 0.001;
    let left = noise;
    let right = -noise * 0.8;
    const voice = Math.sin(frame * 0.13) * 0.2 + Math.sin(frame * 0.031) * 0.08;
    if (time >= 2 && time < 5) {
      left += swap ? voice * 0.05 : voice;
      right += swap ? voice : voice * 0.05;
    }
    if (time >= 7 && time < 10 && !omitHost2) {
      left += swap ? voice : voice * 0.05;
      right += swap ? voice * 0.05 : voice;
    }
    if (time >= 12 && time < 15) {
      left += voice;
      right += Math.sin(frame * 0.17) * 0.19;
    }
    samples[frame * 2] = left;
    samples[frame * 2 + 1] = identical ? left : right;
  }
  return samples;
}

const passed = analyzeChannelSlate(slate(), rate);
assert.equal(passed.status, "passed");
assert.equal(passed.checks.host_1_left_dominance, true);
assert.equal(passed.checks.host_2_right_dominance, true);
console.log("PASS accepts the required TX1-left / TX2-right channel slate");

const swapped = analyzeChannelSlate(slate({ swap: true }), rate);
assert.equal(swapped.status, "blocked");
assert.equal(swapped.checks.host_1_left_dominance, false);
assert.equal(swapped.checks.host_2_right_dominance, false);
console.log("PASS blocks swapped host routing");

const identical = analyzeChannelSlate(slate({ identical: true }), rate);
assert.equal(identical.status, "blocked");
assert.equal(identical.checks.channels_are_distinct, false);
console.log("PASS blocks identical dual-mono channels");

const missing = analyzeChannelSlate(slate({ omitHost2: true }), rate);
assert.equal(missing.status, "blocked");
assert.equal(missing.checks.host_2_present, false);
console.log("PASS blocks a missing transmitter");

const roleDir = mkdtempSync(join(tmpdir(), "eaol-isolated-roles-"));
const roleSources = ["host_1_audio", "host_2_audio"].map((id, index) => {
  const path = join(roleDir, `${id}.wav`);
  writeFileSync(path, Buffer.from(`isolated-${index}`));
  const stat = statSync(path);
  return {
    id,
    path,
    bytes: stat.size,
    modified_ms: Math.round(stat.mtimeMs),
    audio: { channels: 1, sample_rate: 48_000, codec: "pcm_f32le" },
  };
});
const isolatedManifest = { sources: roleSources };
const isolated = buildChannelPreflight({ manifest: isolatedManifest, sourceId: "isolated_masters" });
assert.equal(isolated.status, "passed");
assert.equal(isolated.evidence_mode, "assigned_isolated_transmitter_masters");
assert.equal(isolated.role_assignment_requires_review, true);
assert.equal(channelPreflightMatchesInputs(isolated, isolatedManifest), true);
console.log("PASS accepts two distinct assigned mono masters while preserving human role review");
