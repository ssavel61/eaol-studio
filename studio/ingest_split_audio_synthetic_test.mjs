#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256File } from "./audio_sequence.mjs";

const studioDir = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "eaol-ingest-split-"));
const mediaDir = join(root, "Podcast With Spaces", "ep001", "raw");
const workRoot = join(root, "work");
mkdirSync(mediaDir, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || `${command} failed`);
  return result;
}

try {
  const camera = join(mediaDir, "Episode Camera 01.mp4");
  const continuous = join(mediaDir, "receiver safety.wav");
  run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:d=10", "-f", "lavfi", "-i", "anoisesrc=d=10:c=pink:r=48000:a=0.4:seed=2468", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", camera]);
  run("ffmpeg", ["-v", "error", "-i", camera, "-vn", "-c:a", "pcm_s24le", "-y", continuous]);
  const paths = {
    host_11: join(mediaDir, "Host 1 Audio", "MIC_0009.WAV"),
    host_12: join(mediaDir, "Host 1 Audio", "MIC_0001.WAV"),
    host_21: join(mediaDir, "Host 2 Audio", "MIC_0015.WAV"),
    host_22: join(mediaDir, "Host 2 Audio", "MIC_0016.WAV"),
  };
  mkdirSync(dirname(paths.host_11), { recursive: true });
  mkdirSync(dirname(paths.host_21), { recursive: true });
  for (const [path, start, duration] of [
    [paths.host_11, 0, 6], [paths.host_12, 6, 4],
    [paths.host_21, 0, 4], [paths.host_22, 4, 6],
  ]) run("ffmpeg", ["-v", "error", "-ss", String(start), "-t", String(duration), "-i", continuous, "-c:a", "pcm_s24le", "-y", path]);
  const rawBefore = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await sha256File(path)])));
  run(process.execPath, [
    join(studioDir, "ingest.mjs"), "--analyze-only", "--work-root", workRoot,
    "--primary-camera", camera,
    "--host-1-audio-part", paths.host_11,
    "--host-1-audio-part", paths.host_12,
    "--host-1-order-confirmed",
    "--host-2-audio-part", paths.host_21,
    "--host-2-audio-part", paths.host_22,
    "--host-2-order-confirmed",
  ]);
  const manifest = JSON.parse(readFileSync(join(workRoot, "episode_camera_01", "episode.json"), "utf8"));
  assert.equal(manifest.audio_sequences.host_1_audio.part_count, 2);
  assert.equal(manifest.audio_sequences.host_2_audio.part_count, 2);
  assert.deepEqual(manifest.audio_sequences.host_1_audio.parts.map((part) => part.file), ["MIC_0009.WAV", "MIC_0001.WAV"]);
  assert.ok(Math.abs(manifest.audio_sequences.host_1_audio.parts[1].mapping.mapped_start_sec - 6) < 0.15);
  assert.ok(Math.abs(manifest.audio_sequences.host_2_audio.parts[1].mapping.mapped_start_sec - 4) < 0.15, "different host split points must remain independent");
  assert.equal(manifest.audio_sequences.host_1_audio.status, "review_required");
  assert.equal(manifest.sources.some((source) => source.id === "host_1_audio"), false, "pending seams must not leak a partial logical host track downstream");
  assert.equal(JSON.parse(readFileSync(join(workRoot, "episode_camera_01", "episode_checklist.json"), "utf8")).items.length > 20, true);
  const rawAfter = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await sha256File(path)])));
  assert.deepEqual(rawAfter, rawBefore);
  console.log("PASS ingest accepts independently split Host 1 and Host 2 sequences in explicit order");
  console.log("PASS pending seams block partial logical tracks while Part 2 keeps episode time");
  console.log("PASS ingest writes the episode checklist and preserves all raw WAV bytes");
} finally {
  rmSync(root, { recursive: true, force: true });
}
