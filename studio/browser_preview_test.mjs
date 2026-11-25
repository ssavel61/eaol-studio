#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createBrowserPreview, loadBrowserPreviews } from "./browser_preview.mjs";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} failed`);
  return result.stdout;
}

const root = mkdtempSync(join(tmpdir(), "eaol-browser-preview-"));
try {
  const episodeDir = join(root, "work", "episode_001");
  const rawDir = join(root, "Episode Folder", "raw", "host_1_cam");
  mkdirSync(episodeDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  const sourcePath = join(rawDir, "original camera.mov");
  run("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1008x567:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-vf", "format=yuvj420p", "-c:v", "mpeg4", "-q:v", "3", "-color_range", "pc", "-c:a", "pcm_s16le", "-y", sourcePath,
  ]);
  const original = readFileSync(sourcePath);
  const sourceStat = statSync(sourcePath);
  const source = {
    id: "primary_camera",
    label: "Host 1 camera",
    path: sourcePath,
    bytes: sourceStat.size,
    modified_ms: Math.round(sourceStat.mtimeMs),
    expected_kind: "video",
  };
  writeFileSync(join(episodeDir, "episode.json"), `${JSON.stringify({ sources: [source] }, null, 2)}\n`);

  const receipt = createBrowserPreview({ episodeDir, sourceId: source.id, preset: "ultrafast", crf: 30 });
  assert.equal(receipt.production_source_unchanged, true);
  assert.equal(receipt.output.video.codec, "h264");
  assert.equal(receipt.output.video.pixel_format, "yuv420p");
  assert.deepEqual([receipt.output.video.width, receipt.output.video.height], [960, 540]);
  assert.deepEqual(readFileSync(sourcePath), original, "raw source bytes must remain unchanged");
  assert.equal(loadBrowserPreviews(episodeDir, { sources: [source] }).primary_camera.current, true);

  const changedStat = statSync(sourcePath);
  const changedSource = { ...source, modified_ms: Math.round(changedStat.mtimeMs) + 1 };
  assert.equal(loadBrowserPreviews(episodeDir, { sources: [changedSource] }).primary_camera.stale, true);
  console.log("PASS browser review proxy is verified H.264 yuv420p at 960x540");
  console.log("PASS browser review proxy leaves the raw camera byte-identical");
  console.log("PASS source signature changes expire the cached browser review proxy");
} finally {
  rmSync(root, { recursive: true, force: true });
}
