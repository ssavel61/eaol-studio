#!/usr/bin/env node
// studio — transcribe lane (deterministic).
//
// Takes one video file, extracts audio, transcribes it locally with
// whisper.cpp, and writes everything a clip-selection session needs into
// work/<slug>/. This script does NOT pick clips — see clip_rubric.md for how
// selection works, and render.mjs for cutting.
//
// Usage:
//   node transcribe.mjs --input "/path/to/video.mp4"   # full run
//   node transcribe.mjs --input <file> --model base.en # faster, less accurate
//   node transcribe.mjs --input <file> --no-gpu       # CPU fallback when Metal cannot allocate
//   node transcribe.mjs --input <file> --dry-run       # narrate, run nothing
//   node transcribe.mjs --self-test                    # offline checks, no binaries
//
// Requires: ffmpeg + whisper.cpp and a model in models/ (see README). All external commands run via spawnSync with args
// arrays — paths with spaces (for example a synced cloud folder) need no quoting.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveTool } from "./platform_tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- args ---

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const MODEL_NAME = opt("--model") || "small.en";
const NO_GPU = flag("--no-gpu") || process.env.EAOL_WHISPER_NO_GPU === "1";
const MODEL_FILE = join(HERE, "models", `ggml-${MODEL_NAME}.bin`);
const FFMPEG = resolveTool("ffmpeg");
const FFPROBE = resolveTool("ffprobe");
const WHISPER = resolveTool("whisper");

// --- helpers ---

function fail(msg) {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}

// Slug: input basename without extension, lowercased, runs of non-alphanumerics
// collapsed to single underscores, trimmed. "My Episode 01 (final).mp4" ->
// "my_episode_01_final".
export function slugify(name) {
  return name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function run(bin, cmdArgs, dryRun) {
  const shown = `${bin} ${cmdArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`;
  if (dryRun) {
    console.log(`  [dry-run] ${shown}`);
    return { status: 0, stdout: "" };
  }
  const res = spawnSync(bin, cmdArgs, { encoding: "utf8" });
  if (res.error) fail(`${bin} failed to start: ${res.error.message}`);
  if (res.status !== 0) {
    fail(`${bin} exited ${res.status}:\n${res.stderr || res.stdout}`);
  }
  return res;
}

export function isMetalAllocationFailure(output) {
  return /ggml_metal_buffer_init[\s\S]*failed to allocate buffer/i.test(String(output || ""));
}

function runWhisper(cmdArgs, dryRun) {
  if (dryRun || NO_GPU) return run(WHISPER, cmdArgs, dryRun);

  const res = spawnSync(WHISPER, cmdArgs, { encoding: "utf8" });
  if (res.error) fail(`${WHISPER} failed to start: ${res.error.message}`);
  if (res.status === 0) return res;

  const diagnostic = `${res.stderr || ""}\n${res.stdout || ""}`;
  if (process.platform === "darwin" && isMetalAllocationFailure(diagnostic)) {
    console.warn("\nMetal could not allocate the whisper buffer. Retrying locally on CPU...");
    return run(WHISPER, [...cmdArgs, "--no-gpu"], false);
  }

  fail(`${WHISPER} exited ${res.status}:\n${res.stderr || res.stdout}`);
}

// --- self-test (offline, no binaries) ---

function selfTest() {
  const checks = [];
  const slugCases = [
    ["My Episode 01 (final).mp4", "my_episode_01_final"],
    ["ArtifactVideo.mp4", "artifactvideo"],
    ["Viral_TikTok_Chaotic_Newsletter_Rush.mp4", "viral_tiktok_chaotic_newsletter_rush"],
    ["  weird -- name!!.MOV", "weird_name"],
  ];
  for (const [input, want] of slugCases) {
    checks.push([`slug "${input}"`, slugify(input) === want]);
  }
  checks.push([
    "recognizes whisper Metal allocation failure",
    isMetalAllocationFailure("ggml_metal_buffer_init: error: failed to allocate buffer, size = 4.41 MiB"),
  ]);
  checks.push([
    "does not classify an unrelated whisper failure as Metal allocation",
    !isMetalAllocationFailure("whisper-cli: model file was not found"),
  ]);
  // Transcript fixture (a trimmed whisper.cpp output of a short test phrase).
  // It validates that the archived JSON shape is parseable and carries segment
  // timestamps.
  const fixture = join(HERE, "fixtures", "transcript_sample.json");
  if (existsSync(fixture)) {
    try {
      const j = JSON.parse(readFileSync(fixture, "utf8"));
      const segs = j.transcription || [];
      checks.push(["fixture has segments", segs.length > 0]);
      checks.push([
        "segment offsets in ms",
        Number.isFinite(segs[0]?.offsets?.from) && Number.isFinite(segs[0]?.offsets?.to),
      ]);
      checks.push(["segment has text", typeof segs[0]?.text === "string" && segs[0].text.length > 0]);
    } catch (e) {
      checks.push([`fixture parses (${e.message})`, false]);
    }
  } else {
    console.log("NOTE  fixtures/transcript_sample.json not present yet (minted after first live run)");
  }

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed++;
  }
  if (failed) {
    console.error(`\nself-test FAILED (${failed} checks)`);
    process.exit(1);
  }
  console.log("\nself-test passed");
}

// --- main ---

function main() {
  if (flag("--self-test")) return selfTest();

  const dryRun = flag("--dry-run");
  const inputArg = opt("--input");
  if (!inputArg) {
    console.error('Usage: node transcribe.mjs --input "/path/to/video.mp4" [--model small.en] [--no-gpu] [--dry-run]');
    process.exit(1);
  }
  const input = resolve(inputArg);
  if (!existsSync(input)) fail(`input not found: ${input}`);
  if (!existsSync(MODEL_FILE) && !dryRun) {
    fail(
      `model not found: ${MODEL_FILE}\n` +
        `Download it (once):\n` +
        `  curl -L --fail -o "${MODEL_FILE}" \\\n` +
        `    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin"`,
    );
  }

  const slug = slugify(basename(input));
  if (!slug) fail(`could not derive a slug from "${basename(input)}"`);
  const workRoot = resolve(opt("--work-root") || join(HERE, "work"));
  const workDir = join(workRoot, slug);
  if (!dryRun) mkdirSync(workDir, { recursive: true });
  console.log(`Input: ${input}`);
  console.log(`Work dir: ${workDir}`);

  // 1. Probe. On a synced cloud folder this also forces a placeholder to download.
  console.log("\nProbing source (a cloud-synced file may need to download first)...");
  const probe = run(
    FFPROBE,
    [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate",
      "-of", "json",
      input,
    ],
    dryRun,
  );
  let durationSec = null;
  if (!dryRun) {
    const probeJson = JSON.parse(probe.stdout);
    writeFileSync(join(workDir, "probe.json"), JSON.stringify(probeJson, null, 2));
    durationSec = parseFloat(probeJson.format?.duration);
    const v = (probeJson.streams || []).find((s) => s.codec_type === "video");
    if (!Number.isFinite(durationSec)) fail("probe returned no duration — not a readable video?");
    if (!v) fail("no video stream found — studio MVP expects video input");
    console.log(
      `  duration ${durationSec.toFixed(1)}s | video ${v.codec_name} ${v.width}x${v.height} @ ${v.avg_frame_rate}`,
    );
  }

  // 2. Extract 16kHz mono wav (whisper's required input).
  console.log("\nExtracting audio...");
  run(
    FFMPEG,
    ["-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", join(workDir, "audio.wav")],
    dryRun,
  );

  // 3. Transcribe. --max-len 42 --split-on-word keeps each segment short enough
  // to be a single burned caption line on a 1080-wide vertical frame, and gives
  // fine-grained boundaries for clip snapping.
  console.log(`\nTranscribing with ${MODEL_NAME} (${NO_GPU ? "CPU fallback" : process.platform === "darwin" ? "Metal-enabled" : "local CPU"})...`);
  const whisperArgs = [
    "-m", MODEL_FILE,
    "-f", join(workDir, "audio.wav"),
    "-l", "en",
    "-t", "8",
    "--max-len", "42",
    "--split-on-word",
    "--output-json",
    "--output-srt",
    "--output-file", join(workDir, "transcript"),
  ];
  if (NO_GPU) whisperArgs.push("--no-gpu");
  runWhisper(whisperArgs, dryRun);

  // 4. Meta — the render stage cross-checks clips.json against this.
  if (!dryRun) {
    const whisperVersionResult = spawnSync(WHISPER, ["--version"], { encoding: "utf8" });
    const whisperVer = `${whisperVersionResult.stdout || ""}${whisperVersionResult.stderr || ""}`.split(/\r?\n/).find((line) => /version/i.test(line))?.trim() || WHISPER;
    writeFileSync(
      join(workDir, "meta.json"),
      JSON.stringify(
        {
          source: input,
          slug,
          duration_sec: durationSec,
          model: MODEL_NAME,
          whisper: whisperVer,
          transcribed_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    const srt = readFileSync(join(workDir, "transcript.srt"), "utf8");
    const cueCount = (srt.match(/^\d+\s*$/gm) || []).length;
    if (cueCount === 0) fail("transcript.srt has zero cues — transcription produced nothing");
    console.log(`\nDone: ${cueCount} caption segments → ${join(workDir, "transcript.srt")}`);
    console.log("Next: pick clips per clip_rubric.md (writes clips.json), then render.mjs.");
  } else {
    console.log("\n--dry-run: nothing executed, nothing written.");
  }
}

main();
