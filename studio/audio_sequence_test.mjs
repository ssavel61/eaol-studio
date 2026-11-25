#!/usr/bin/env node

import assert from "node:assert/strict";
import { buildSequenceReceipt, classifySeam, reviewSequenceSeam, sequenceFingerprint } from "./audio_sequence.mjs";

function part(id, path, duration = 1800) {
  return { id, path, bytes: id.length * 100, modified_ms: 1000 + id.length, sha256: id.repeat(8).slice(0, 64), duration_sec: duration, audio: { sample_rate: 48000, channels: 1, codec: "pcm_s24le" } };
}

assert.equal(classifySeam(0.1, 0.8), "continuous");
assert.equal(classifySeam(1.2, 0.8), "gap");
assert.equal(classifySeam(-0.8, 0.8), "overlap");
assert.equal(classifySeam(0, 0.02), "uncertain");

const parts = [part("tx_2", "/raw/TX02.WAV"), part("tx_1", "/raw/TX01.WAV", 660)];
const mappings = [
  { mapped_start_sec: 0, mapped_end_sec: 1800, start_confidence: 0.8, end_confidence: 0.7 },
  { mapped_start_sec: 1800.08, mapped_end_sec: 2460, start_confidence: 0.75, end_confidence: 0.8 },
];
const receipt = buildSequenceReceipt({ role: "host_1_audio", label: "Host 1 isolated audio", parts, mappings, orderConfirmed: true, createdAt: "2026-08-30T12:00:00.000Z" });
assert.deepEqual(receipt.parts.map((item) => item.id), ["tx_2", "tx_1"], "explicit order must win over misleading filenames");
assert.equal(receipt.seams[0].classification, "continuous");
assert.equal(receipt.seams[0].duplicate_samples_suspected, false);
assert.equal(receipt.ready, false);
reviewSequenceSeam(receipt, "seam_001", { status: "approved", notes: "words continue cleanly", reviewedAt: "2026-08-30T12:01:00.000Z" });
assert.equal(receipt.ready, true);

const reordered = [parts[1], parts[0]];
assert.notEqual(sequenceFingerprint("host_1_audio", parts), sequenceFingerprint("host_1_audio", reordered));
const rebuilt = buildSequenceReceipt({ role: "host_1_audio", label: "Host 1 isolated audio", parts: reordered, mappings, orderConfirmed: true, previous: receipt });
assert.equal(rebuilt.seams[0].review.status, "pending", "a changed order must invalidate seam approval");

const missingContinuation = buildSequenceReceipt({ role: "host_2_audio", label: "Host 2 isolated audio", parts: [part("only", "/raw/only.wav", 1800)], mappings: [{ mapped_start_sec: 0, mapped_end_sec: 1800, start_confidence: 0.8, end_confidence: 0.8 }], orderConfirmed: true, referenceDurationSec: 2460 });
assert.equal(missingContinuation.status, "incomplete");
assert.equal(missingContinuation.coverage.status, "incomplete");
assert.equal(missingContinuation.ready, false);

const incompatible = buildSequenceReceipt({ role: "host_2_audio", label: "Host 2 isolated audio", parts: [part("a", "/raw/a.wav"), { ...part("b", "/raw/b.wav"), audio: { sample_rate: 44100, channels: 1, codec: "pcm_s24le" } }], mappings, orderConfirmed: true });
assert.equal(incompatible.status, "incompatible");
assert.equal(incompatible.ready, false);

console.log("PASS explicit wireless microphone part order and seam classification");
console.log("PASS seam review unlocks a sequence only after order confirmation");
console.log("PASS reordering invalidates approvals and sequence fingerprints");
console.log("PASS a likely missing continuation blocks a shortened logical host track");
console.log("PASS incompatible part sample rates refuse a falsely lossless logical track");
