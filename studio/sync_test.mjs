#!/usr/bin/env node

import assert from "node:assert/strict";
import { classifyMeasurement, findBestLag, findBestPosition, manifestSourceSignature } from "./sync.mjs";

function pattern(length, seed = 123456789) {
  let state = seed;
  return Array.from({ length }, (_, index) => {
    state = (1103515245 * state + 12345) & 0x7fffffff;
    return state / 0x7fffffff - 0.5;
  });
}

function delayed(values, lag) {
  const output = Array(values.length).fill(0);
  for (let index = 0; index < values.length - lag; index++) output[index + lag] = values[index];
  return output;
}

const reference = pattern(1200);
const later = findBestLag(reference, delayed(reference, 37), 100);
assert.equal(later.lag, 37);
assert.ok(later.confidence > 0.95);

const earlier = findBestLag(delayed(reference, 24), reference, 100);
assert.equal(earlier.lag, -24);
assert.ok(earlier.confidence > 0.95);

const unrelated = findBestLag(reference, pattern(1200, 987654321), 100);
assert.ok(unrelated.confidence < 0.28);

const preRoll = pattern(3600, 246813579);
const sharedStart = 1375;
preRoll.splice(sharedStart, reference.length, ...reference);
const wide = findBestPosition(reference, preRoll, { minPosition: -100, maxPosition: 2400, coarseStep: 25 });
assert.equal(wide.position, sharedStart);
assert.ok(wide.confidence > 0.95);

const referenceEnd = reference.slice(400);
const expectedEnd = sharedStart + 400;
const constrainedEnd = findBestPosition(referenceEnd, preRoll, {
  minPosition: expectedEnd - 100,
  maxPosition: expectedEnd + 100,
  coarseStep: 10,
});
assert.equal(constrainedEnd.position, expectedEnd);
assert.ok(constrainedEnd.confidence > 0.95);

assert.equal(classifyMeasurement(0.31, 400), "measured");
assert.equal(classifyMeasurement(0.188, -17), "measured");
assert.equal(classifyMeasurement(0.149, 0), "low_confidence");
assert.equal(classifyMeasurement(0.2, 51), "low_confidence");

const sequenceSource = {
  id: "host_1_audio",
  path: "/derived/host_1.flac",
  bytes: 500,
  modified_ms: 100,
  sequence_fingerprint: "ordered-a-b",
  parts: [
    { id: "a", path: "/raw/a.wav", bytes: 200, modified_ms: 10, sha256: "aaa", order: 1 },
    { id: "b", path: "/raw/b.wav", bytes: 300, modified_ms: 20, sha256: "bbb", order: 2 },
  ],
};
const signature = manifestSourceSignature(sequenceSource);
assert.notEqual(signature, manifestSourceSignature({ ...sequenceSource, parts: [...sequenceSource.parts].reverse() }), "part order must invalidate downstream receipts");
assert.notEqual(signature, manifestSourceSignature({ ...sequenceSource, parts: sequenceSource.parts.map((part) => part.id === "b" ? { ...part, sha256: "changed" } : part) }), "part replacement must invalidate downstream receipts");

console.log("PASS positive and negative waveform offsets");
console.log("PASS unrelated waveform stays below the review-confidence floor");
console.log("PASS wide pre-roll search finds reference audio inside a longer source");
console.log("PASS stable start/end agreement can corroborate a moderately weak waveform match");
console.log("PASS split-audio order and replacement participate in downstream signatures");
