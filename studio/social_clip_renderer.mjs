#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveTool, setupHint } from "../platform_tools.mjs";
import { SOCIAL_QUALITY_VERSION, buildCaptionLayout, captionLines, isDuplicateOpeningHook } from "./social_captions.mjs";

export const SOCIAL_RENDER_RECEIPTS_SCHEMA = "eaol-social-render-receipts-v1";
export const SOCIAL_RENDER_RECEIPT_SCHEMA = "eaol-social-render-v1";

const FFMPEG = resolveTool("ffmpeg");
const FFPROBE = resolveTool("ffprobe");

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  return result;
}

function probe(path) {
  const result = run(FFPROBE, [
    "-v", "error", "-show_entries",
    "format=duration:stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,sample_rate,channels,nb_read_frames",
    "-count_frames", "-of", "json", path,
  ], "social output probe");
  return JSON.parse(result.stdout);
}

function assTime(ms) {
  const safe = Math.max(0, Math.round(ms));
  const h = Math.floor(safe / 3_600_000);
  const m = Math.floor((safe % 3_600_000) / 60_000);
  const s = Math.floor((safe % 60_000) / 1_000);
  const cs = Math.floor((safe % 1_000) / 10);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function socialAss(plan, layout = null) {
  const firstMs = plan.video.shots[0].timeline_start_ms;
  layout ||= buildCaptionLayout(plan.captions, firstMs, firstMs + plan.duration_ms);
  const captions = layout.pages.map((page) => (
    `Dialogue: 0,${assTime(page.start_ms)},${assTime(page.end_ms)},Default,,0,0,0,,${page.lines.join("\\N")}`
  ));
  if (plan.hook_overlay && !isDuplicateOpeningHook(plan.hook_overlay, plan.captions, firstMs)) {
    if (/[{}\\]/.test(plan.hook_overlay)) throw new Error("hook contains subtitle control characters; review the literal text");
    const hookLines = captionLines(plan.hook_overlay);
    if (hookLines.length > 2) throw new Error("shorten the opening headline to fit two lines");
    captions.unshift(`Dialogue: 1,0:00:00.00,${assTime(Math.min(3_000, plan.duration_ms))},Hook,,0,0,0,,${hookLines.join("\\N")}`);
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,120,120,470,1
Style: Hook,Arial,72,&H00AEE2F3,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,8,120,120,340,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${captions.join("\n")}
`;
}

function videoDimensions(path) {
  const result = run(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path,
  ], "social source dimension probe");
  const data = JSON.parse(result.stdout);
  const video = (data.streams || [])[0];
  if (!video?.width || !video?.height) throw new Error(`${basename(path)} has no readable video stream`);
  return video;
}

function atempo(rate) {
  const safe = Math.max(0.5, Math.min(2, Number(rate || 1)));
  return safe.toFixed(9);
}

export function renderSocialClip(workDir, { clipId, generatedAt = new Date().toISOString(), testMode = false } = {}) {
  const dir = String(workDir || "");
  const plansPath = join(dir, "social_edit_plans.json");
  if (!existsSync(plansPath)) throw new Error("build the source-bound social edit plan before rendering");
  const plans = JSON.parse(readFileSync(plansPath, "utf8"));
  const plan = plans.plans?.[clipId];
  if (!plan || plan.status !== "render_ready") throw new Error("the requested source-bound social edit plan is not current");
  if (plan.quality_policy_version !== SOCIAL_QUALITY_VERSION) throw new Error("rebuild the social edit plan with the current caption-quality checks before rendering");
  const firstMs = plan.video.shots[0].timeline_start_ms;
  const captionLayout = buildCaptionLayout(plan.captions, firstMs, firstMs + plan.duration_ms);
  for (const source of [...plan.video.shots, ...plan.audio.tracks]) {
    if (!existsSync(source.source_path) || !statSync(source.source_path).isFile()) throw new Error(`${source.source_id} source is unavailable`);
  }
  const outputDir = join(dir, "clips");
  mkdirSync(outputDir, { recursive: true });
  const assPath = join(outputDir, `${clipId}.ass`);
  const outputPath = join(outputDir, `${clipId}.mp4`);
  writeFileSync(assPath, socialAss(plan, captionLayout));

  const args = ["-y", "-v", "error"];
  for (const source of [...plan.video.shots, ...plan.audio.tracks]) {
    const sourceDurationSec = Math.max(0.001, (Number(source.source_end_ms) - Number(source.source_start_ms)) / 1_000);
    args.push(
      "-ss", Math.max(0, Number(source.source_start_ms) / 1_000).toFixed(6),
      "-t", sourceDurationSec.toFixed(6),
      "-i", source.source_path,
    );
  }
  const filters = [];
  plan.video.shots.forEach((shot, index) => {
    const dimensions = videoDimensions(shot.source_path);
    const cropWidth = Math.floor((dimensions.height * 9) / 16 / 2) * 2;
    const centerX = Math.round((dimensions.width - cropWidth) / 2) + Number(plan.crop_offset_px || 0);
    if (centerX < 0 || centerX + cropWidth > dimensions.width) throw new Error(`${shot.source_id} crop leaves its source frame`);
    filters.push(
      `[${index}:v]trim=start=0:end=${((shot.source_end_ms - shot.source_start_ms) / 1_000).toFixed(6)},` +
      `setpts=(PTS-STARTPTS)/${Number(shot.playback_rate || 1).toFixed(9)},fps=30,` +
      `crop=${cropWidth}:${dimensions.height}:${centerX}:0,scale=1080:1920:flags=lanczos:out_range=tv,format=yuv420p,setsar=1[v${index}]`,
    );
  });
  filters.push(`${plan.video.shots.map((_, index) => `[v${index}]`).join("")}concat=n=${plan.video.shots.length}:v=1:a=0[vcat]`);
  filters.push(`[vcat]subtitles=${basename(assPath)}[vout]`);
  const audioBase = plan.video.shots.length;
  plan.audio.tracks.forEach((track, index) => {
    filters.push(
      `[${audioBase + index}:a]atrim=start=0:end=${((track.source_end_ms - track.source_start_ms) / 1_000).toFixed(6)},` +
      `asetpts=PTS-STARTPTS,atempo=${atempo(track.playback_rate)}[a${index}]`,
    );
  });
  filters.push(`${plan.audio.tracks.map((_, index) => `[a${index}]`).join("")}amix=inputs=${plan.audio.tracks.length}:duration=longest:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]", "-t", (plan.duration_ms / 1_000).toFixed(3),
    "-c:v", "libx264", "-profile:v", "high", "-level", "4.1", "-preset", testMode ? "veryfast" : "medium", "-crf", testMode ? "30" : "20",
    "-pix_fmt", "yuv420p", "-color_range", "tv", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", outputPath,
  );
  run(FFMPEG, args, "source-bound social render", { cwd: outputDir });
  const data = probe(outputPath);
  const video = (data.streams || []).find((stream) => stream.codec_type === "video");
  const audio = (data.streams || []).find((stream) => stream.codec_type === "audio");
  const durationSec = Number(data.format?.duration || 0);
  const decode = spawnSync(FFMPEG, ["-v", "error", "-i", outputPath, "-f", "null", "-"], { encoding: "utf8" });
  const black = run(FFMPEG, ["-hide_banner", "-i", outputPath, "-vf", "blackdetect=d=1.0:pic_th=0.98:pix_th=0.02", "-an", "-f", "null", "-"], "black-frame scan");
  // Talking-head footage can remain visually unchanged for a second or two
  // without being corrupt. Treat only a sustained four-second frozen run as a
  // technical failure; shorter stillness belongs in the human watch.
  const freeze = run(FFMPEG, ["-hide_banner", "-i", outputPath, "-vf", "freezedetect=n=0.001:d=4.0", "-an", "-f", "null", "-"], "freeze scan");
  const silence = run(FFMPEG, ["-hide_banner", "-i", outputPath, "-af", "silencedetect=n=-55dB:d=2.5", "-vn", "-f", "null", "-"], "silence scan");
  const checks = {
    full_decode: decode.status === 0 && !(decode.stderr || "").trim(),
    dimensions_1080x1920: video?.width === 1080 && video?.height === 1920,
    h264_high_profile: video?.codec_name === "h264" && String(video?.profile || "").toLowerCase().includes("high"),
    frame_rate_30: ["30/1", "60/2"].includes(video?.r_frame_rate),
    pixel_format_yuv420p: video?.pix_fmt === "yuv420p",
    aac_48khz_stereo: audio?.codec_name === "aac" && Number(audio?.sample_rate) === 48_000 && Number(audio?.channels) === 2,
    duration_matches_plan: Math.abs(durationSec - plan.duration_ms / 1_000) <= 0.5,
    captions_from_reviewed_transcript: plan.captions.length > 0 && Boolean(plan.transcript_fingerprint),
    ...captionLayout.checks,
    no_detected_black_run: !(black.stderr || "").includes("black_start"),
    no_detected_freeze_run: !(freeze.stderr || "").includes("freeze_start"),
    silence_scan_completed: silence.status === 0,
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failed.length) throw new Error(`social render QA failed: ${failed.join(", ")}`);
  const stat = statSync(outputPath);
  const receipt = {
    schema: SOCIAL_RENDER_RECEIPT_SCHEMA,
    status: "complete",
    generated_at: generatedAt,
    clip_id: clipId,
    edit_plan_fingerprint: plan.fingerprint,
    quality_policy_version: SOCIAL_QUALITY_VERSION,
    caption_layout: { timing_basis: captionLayout.timing_basis, page_count: captionLayout.pages.length },
    output: {
      path: outputPath,
      file: basename(outputPath),
      bytes: stat.size,
      modified_ms: Math.round(stat.mtimeMs),
      sha256: hashFile(outputPath),
      duration_sec: durationSec,
      width: video.width,
      height: video.height,
      video_codec: video.codec_name,
      audio_codec: audio.codec_name,
      frame_rate: video.r_frame_rate,
      sample_rate: Number(audio.sample_rate),
    },
    checks,
    warnings: [...captionLayout.warnings,
      ...(isDuplicateOpeningHook(plan.hook_overlay, plan.captions, firstMs) ? ["Repeated opening headline omitted; spoken captions retained."] : []),
      ...((silence.stderr || "").match(/silence_start/g)?.length
        ? ["The technical scan found a 2.5-second quiet span; confirm it during the complete human watch."] : [])],
    complete_watch_required: true,
    external_copy_authorized: false,
    publication_authorized: false,
  };
  const receiptsPath = join(dir, "social_render_receipts.json");
  const saved = existsSync(receiptsPath)
    ? JSON.parse(readFileSync(receiptsPath, "utf8"))
    : { schema: SOCIAL_RENDER_RECEIPTS_SCHEMA, renders: {} };
  saved.schema = SOCIAL_RENDER_RECEIPTS_SCHEMA;
  saved.updated_at = generatedAt;
  saved.renders ||= {};
  saved.renders[clipId] = receipt;
  writeFileSync(receiptsPath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

function main() {
  const args = process.argv.slice(2);
  const runIndex = args.indexOf("--run");
  const clipIndex = args.indexOf("--clip");
  if (runIndex < 0 || clipIndex < 0 || !args[runIndex + 1] || !args[clipIndex + 1]) {
    console.error("usage: node studio/social_clip_renderer.mjs --run work/<episode> --clip clip_NNN");
    process.exit(1);
  }
  try {
    const receipt = renderSocialClip(args[runIndex + 1], { clipId: args[clipIndex + 1] });
    console.log(`Social clip complete: ${receipt.output.path}`);
  } catch (error) {
    console.error(error.message);
    console.error(`Check local media tools: ${setupHint()}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
