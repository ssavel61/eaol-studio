#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildDerivedTrack,
  buildSequenceReceipt,
  createSeamPreviews,
  measurePartMappings,
  reviewSequenceSeam,
  sha256File,
} from "./audio_sequence.mjs";

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-v", "error", ...args], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || "ffmpeg failed");
}

function probeDuration(path) {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || "ffprobe failed");
  return Number(result.stdout.trim());
}

const root = mkdtempSync(join(tmpdir(), "eaol-audio-sequence-"));
try {
  const mediaRoot = join(root, "Podcast With Spaces", "Sample Episode", "raw", "Host 1 Audio");
  mkdirSync(mediaRoot, { recursive: true });
  const referencePath = join(mediaRoot, "camera safety.wav");
  const firstPath = join(mediaRoot, "MIC_0009.WAV");
  const secondPath = join(mediaRoot, "MIC_0001.WAV");
  ffmpeg(["-f", "lavfi", "-i", "anoisesrc=d=10:c=pink:r=48000:a=0.4:seed=1729", "-c:a", "pcm_s24le", "-y", referencePath]);
  ffmpeg(["-ss", "0", "-t", "6", "-i", referencePath, "-c:a", "pcm_s24le", "-y", firstPath]);
  ffmpeg(["-ss", "6", "-t", "4", "-i", referencePath, "-c:a", "pcm_s24le", "-y", secondPath]);
  const rawBefore = [await sha256File(firstPath), await sha256File(secondPath)];
  const parts = [firstPath, secondPath].map((path, index) => {
    const stat = statSync(path);
    return {
      id: `host_1_audio_part_${String(index + 1).padStart(3, "0")}`,
      path,
      file: path.split("/").at(-1),
      bytes: stat.size,
      modified_ms: Math.round(stat.mtimeMs),
      sha256: rawBefore[index],
      duration_sec: probeDuration(path),
      audio: { sample_rate: 48000, channels: 1, codec: "pcm_s24le" },
    };
  });
  const mappings = measurePartMappings({ path: referencePath, duration_sec: 10 }, parts);
  assert.ok(Math.abs(mappings[0].mapped_start_sec) < 0.1);
  assert.ok(Math.abs(mappings[1].mapped_start_sec - 6) < 0.1, "part 2 must remain on the episode timeline");
  const receipt = buildSequenceReceipt({ role: "host_1_audio", label: "Host 1 isolated audio", parts, mappings, orderConfirmed: true });
  createSeamPreviews(receipt, root);
  assert.equal(receipt.seams.length, 1);
  assert.ok(statSync(receipt.seams[0].preview_file).size > 44);
  reviewSequenceSeam(receipt, receipt.seams[0].id, { status: "approved", notes: "synthetic continuous boundary" });
  buildDerivedTrack(receipt, root);
  assert.equal(receipt.derived_source.mode, "ordered_lossless_concat_flac");
  assert.ok(Math.abs(probeDuration(receipt.derived_source.path) - 10) < 0.1);
  assert.deepEqual([await sha256File(firstPath), await sha256File(secondPath)], rawBefore, "raw masters must remain byte-identical");
  assert.notDeepEqual(readFileSync(receipt.derived_source.path).subarray(0, 4), Buffer.from("RIFF"), "derived track must be a separate FLAC, not an overwritten WAV");
  console.log("PASS synthetic split WAVs map part 2 to the continuous episode timeline");
  console.log("PASS playable seam preview and separate lossless FLAC derivative");
  console.log("PASS original transmitter WAV bytes remain unchanged");
  console.log("PASS split-audio processing accepts folder paths containing spaces");
} finally {
  rmSync(root, { recursive: true, force: true });
}
