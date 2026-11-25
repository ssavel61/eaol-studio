#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveTool } from "../platform_tools.mjs";
import { manifestSourceSignature, sourceReceiptsAreCurrent } from "./sync.mjs";

const RECEIPT_SCHEMA = "eaol-browser-previews-v1";

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function receiptPath(episodeDir) {
  return join(episodeDir, "browser_previews.json");
}

function outputPath(episodeDir, sourceId) {
  return join(episodeDir, "browser_previews", `${sourceId}.mp4`);
}

function probeMedia(path, ffprobe = resolveTool("ffprobe")) {
  const result = spawnSync(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,pix_fmt",
    "-of", "json",
    path,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`browser preview verification failed: ${result.error?.message || result.stderr || "ffprobe failed"}`);
  }
  return JSON.parse(result.stdout);
}

function currentOutput(receipt) {
  if (!receipt?.output?.path || !existsSync(receipt.output.path)) return false;
  const stat = statSync(receipt.output.path);
  return stat.isFile()
    && stat.size === Number(receipt.output.bytes || 0)
    && Math.round(stat.mtimeMs) === Number(receipt.output.modified_ms || 0);
}

export function loadBrowserPreviews(episodeDir, intake) {
  const doc = readJson(receiptPath(episodeDir), { schema: RECEIPT_SCHEMA, previews: {} });
  const sources = new Map((intake?.sources || []).map((source) => [source.id, source]));
  const previews = {};
  for (const [sourceId, receipt] of Object.entries(doc?.previews || {})) {
    const source = sources.get(sourceId);
    const current = Boolean(
      source
      && sourceReceiptsAreCurrent([source])
      && receipt.source_signature === manifestSourceSignature(source)
      && currentOutput(receipt),
    );
    previews[sourceId] = { ...receipt, stale: !current, current };
  }
  return previews;
}

export function createBrowserPreview({
  episodeDir,
  sourceId,
  ffmpeg = resolveTool("ffmpeg"),
  ffprobe = resolveTool("ffprobe"),
  preset = "veryfast",
  crf = 26,
} = {}) {
  const resolvedEpisodeDir = resolve(String(episodeDir || ""));
  const intake = readJson(join(resolvedEpisodeDir, "episode.json"), null);
  if (!intake) throw new Error("run source intake before creating a browser preview");
  if (!sourceReceiptsAreCurrent(intake.sources || [])) {
    throw new Error("source files changed after intake; run source checks again before creating a browser preview");
  }
  const source = (intake.sources || []).find((item) => item.id === sourceId);
  if (!source || (source.expected_kind !== "video" && source.media_kind !== "video" && !source.video)) {
    throw new Error("choose a current camera source for the browser preview");
  }

  const previewDir = join(resolvedEpisodeDir, "browser_previews");
  mkdirSync(previewDir, { recursive: true, mode: 0o700 });
  const output = outputPath(resolvedEpisodeDir, sourceId);
  const temporary = join(previewDir, `.${sourceId}.${process.pid}.tmp.mp4`);
  rmSync(temporary, { force: true });
  console.log(`Creating local H.264 browser preview for ${source.label || source.id}…`);
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-v", "warning", "-nostats", "-y",
    "-i", source.path,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", "scale=960:540:force_original_aspect_ratio=decrease:in_range=auto:out_range=tv:flags=fast_bilinear,pad=960:540:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", preset, "-crf", String(crf),
    "-color_range", "tv",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    temporary,
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    rmSync(temporary, { force: true });
    throw new Error(`browser preview render failed: ${result.error?.message || result.stderr || "ffmpeg failed"}`);
  }

  const probe = probeMedia(temporary, ffprobe);
  const video = (probe.streams || []).find((stream) => stream.codec_type === "video");
  if (!video || video.codec_name !== "h264" || video.pix_fmt !== "yuv420p" || video.width !== 960 || video.height !== 540) {
    rmSync(temporary, { force: true });
    throw new Error("browser preview verification did not produce 960x540 H.264 yuv420p video");
  }
  rmSync(output, { force: true });
  renameSync(temporary, output);
  const stat = statSync(output);
  const receipt = {
    schema: "eaol-browser-preview-v1",
    source_id: source.id,
    source_label: source.label || source.id,
    source_file: basename(source.path),
    source_signature: manifestSourceSignature(source),
    generated_at: new Date().toISOString(),
    purpose: "local_browser_review_only",
    production_source_unchanged: true,
    output: {
      path: output,
      bytes: stat.size,
      modified_ms: Math.round(stat.mtimeMs),
      duration_sec: Number(probe.format?.duration || 0),
      video: { codec: video.codec_name, width: video.width, height: video.height, pixel_format: video.pix_fmt },
      audio_codec: (probe.streams || []).find((stream) => stream.codec_type === "audio")?.codec_name || null,
    },
  };
  const existing = readJson(receiptPath(resolvedEpisodeDir), { schema: RECEIPT_SCHEMA, previews: {} });
  const document = {
    schema: RECEIPT_SCHEMA,
    updated_at: receipt.generated_at,
    previews: { ...(existing?.previews || {}), [source.id]: receipt },
  };
  writeFileSync(receiptPath(resolvedEpisodeDir), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  console.log(`Browser preview ready: ${output}`);
  return receipt;
}

function parseArgs(argv) {
  const runIndex = argv.indexOf("--run");
  const sourceIndex = argv.indexOf("--source");
  if (runIndex === -1 || !argv[runIndex + 1] || sourceIndex === -1 || !argv[sourceIndex + 1]) return null;
  return { episodeDir: argv[runIndex + 1], sourceId: argv[sourceIndex + 1] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.error("usage: node studio/browser_preview.mjs --run <episode-dir> --source <camera-source-id>");
    process.exit(2);
  }
  try {
    createBrowserPreview(options);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
