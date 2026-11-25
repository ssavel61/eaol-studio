#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveTool } from "../platform_tools.mjs";
import {
  deliveryAudioMatchesRender,
  loudnessAnalysisArgs,
  normalizedAudioArgs,
  parseLoudnormJson,
  renderRssAudio,
} from "./delivery_audio.mjs";

const ffmpeg = resolveTool("ffmpeg");
const root = mkdtempSync(join(tmpdir(), "eaol-delivery-audio-test-"));
const workDir = join(root, "work", "demo");
mkdirSync(join(workDir, "episode"), { recursive: true });

function run(args) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-y", "-v", "error", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function writeJson(name, value) {
  writeFileSync(join(workDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

try {
  const parsed = parseLoudnormJson(`noise\n{\n  "input_i" : "-21.10",\n  "input_tp" : "-4.20",\n  "input_lra" : "2.30",\n  "input_thresh" : "-31.20",\n  "target_offset" : "0.10"\n}\n`);
  assert.equal(parsed.input_i, -21.1);
  assert.throws(() => parseLoudnormJson("no measurements"), /did not return/);
  assert.match(loudnessAnalysisArgs("input.mp4").join(" "), /loudnorm=I=-16:LRA=11:TP=-1/);
  assert.match(normalizedAudioArgs({ inputPath: "in.mp4", outputPath: "out.mp3", title: "Demo", measurement: parsed }).join(" "), /libmp3lame -b:a 192k/);
  console.log("PASS loudness analysis is deterministic and refuses missing measurements");

  const fullPath = join(workDir, "episode", "episode_full.mp4");
  run([
    "-f", "lavfi", "-i", "color=c=#23333a:s=640x360:r=30:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-filter:a", "volume=0.08", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", fullPath,
  ]);
  const fullStat = statSync(fullPath);
  const render = {
    schema: "eaol-episode-render-v1",
    status: "complete",
    source_slug: "demo",
    quality: "full",
    assembly_fingerprint: "assembly-a",
    full_render_authorized: true,
    output: { path: fullPath, bytes: fullStat.size, modified_ms: Math.round(fullStat.mtimeMs), duration_sec: 3 },
  };
  writeJson("episode_render.json", render);
  writeJson("episode_assembly.json", { title: "Delivery audio test", plan_fingerprint: "assembly-a" });

  const receipt = renderRssAudio(workDir, { generatedAt: "2026-08-30T18:00:00.000Z" });
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.output.codec, "mp3");
  assert.equal(receipt.output.sample_rate_hz, 48_000);
  assert.equal(receipt.output.channels, 2);
  assert.equal(receipt.output.sha256.length, 64);
  assert.ok(receipt.output.duration_sec >= 2.9 && receipt.output.duration_sec <= 3.1);
  assert.equal(receipt.checks.integrated_loudness, true);
  assert.equal(receipt.checks.true_peak, true);
  assert.equal(receipt.checks.codec, true);
  assert.equal(receipt.checks.sample_rate, true);
  assert.equal(receipt.checks.channels, true);
  assert.equal(receipt.checks.duration, true);
  assert.equal(receipt.rss_ready, true);
  assert.equal(receipt.upload_authorized, false);
  assert.equal(deliveryAudioMatchesRender(receipt, render), true);
  assert.equal(deliveryAudioMatchesRender(receipt, { ...render, assembly_fingerprint: "changed" }), false);
  console.log("PASS approved full render produces verified RSS MP3 with loudness and true-peak receipts");
  console.log("PASS RSS audio expires with the source render and never authorizes upload or publication");

  // The declared presentation window can be shorter than decoded AAC samples.
  // Bound the export, but never pad a source that ends too soon to make QA pass.
  writeJson("episode_render.json", { ...render, output: { ...render.output, duration_sec: 1 } });
  const bounded = renderRssAudio(workDir);
  assert.ok(Math.abs(bounded.output.duration_sec - 1) < 0.1);
  assert.equal(bounded.presentation_duration_sec, 1);
  writeJson("episode_render.json", { ...render, output: { ...render.output, duration_sec: 5 } });
  assert.throws(() => renderRssAudio(workDir), /duration.*false/);
  writeJson("episode_render.json", { ...render, output: { ...render.output, duration_sec: 0 } });
  assert.throws(() => renderRssAudio(workDir), /positive finite duration/);
  console.log("PASS RSS honors the presentation endpoint, refuses short input, and requires a valid duration");
} finally {
  rmSync(root, { recursive: true, force: true });
}
