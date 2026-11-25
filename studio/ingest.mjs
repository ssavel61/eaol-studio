#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertStableLocalFile } from "./local_files.mjs";
import { loadEpisodeChecklist, saveEpisodeChecklist } from "./episode_checklist.mjs";
import {
  buildSequenceReceipt,
  createSeamPreviews,
  measurePartMappings,
  sha256File,
} from "./audio_sequence.mjs";

const STUDIO_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(STUDIO_DIR);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".m4a", ".mp3", ".flac", ".aac"]);

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function slugify(name) {
  return basename(name)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseRate(value) {
  const [numerator, denominator = "1"] = String(value || "0").split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function fingerprint(path) {
  const stat = statSync(path);
  return { bytes: stat.size, modified_ms: Math.round(stat.mtimeMs) };
}

function sameSource(cached, source) {
  if (!cached || cached.path !== source.path) return false;
  const current = fingerprint(source.path);
  return cached.bytes === current.bytes && cached.modified_ms === current.modified_ms;
}

export function probeSource(source, cached) {
  if (sameSource(cached, source)) {
    console.log(`Reusing source check: ${source.label}`);
    return {
      ...cached,
      label: source.label,
      expected_kind: source.expected_kind,
      local_availability: source.local_receipt,
      reused: true,
    };
  }
  console.log(`Checking ${source.label}: ${basename(source.path)}`);
  const result = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries",
      "format=duration,format_name,bit_rate:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels:stream_tags=rotate:stream_side_data=rotation",
      "-of", "json",
      source.path,
    ],
    { encoding: "utf8" },
  );
  if (result.error) fail(`ffprobe failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${source.label} could not be read: ${result.stderr || result.stdout}`);
  let probe;
  try {
    probe = JSON.parse(result.stdout);
  } catch {
    fail(`${source.label} returned an invalid media receipt`);
  }
  const afterProbe = fingerprint(source.path);
  if (afterProbe.bytes !== source.local_receipt.bytes || afterProbe.modified_ms !== source.local_receipt.modified_ms) {
    fail(`${source.label} changed while ffprobe read it; wait for the copy to finish`);
  }
  const video = (probe.streams || []).find((stream) => stream.codec_type === "video");
  const audio = (probe.streams || []).find((stream) => stream.codec_type === "audio");
  return {
    id: source.id,
    label: source.label,
    expected_kind: source.expected_kind,
    path: source.path,
    file: basename(source.path),
    extension: extname(source.path).toLowerCase(),
    bytes: afterProbe.bytes,
    modified_ms: afterProbe.modified_ms,
    local_availability: source.local_receipt,
    duration_sec: Number(probe.format?.duration || 0),
    container: probe.format?.format_name || null,
    bit_rate: Number(probe.format?.bit_rate || 0) || null,
    video: video
      ? {
          codec: video.codec_name || null,
          width: Number(video.width || 0),
          height: Number(video.height || 0),
          avg_frame_rate: video.avg_frame_rate || null,
          nominal_frame_rate: video.r_frame_rate || null,
          fps: parseRate(video.avg_frame_rate),
          rotation_degrees: Number(video.side_data_list?.find((item) => Number.isFinite(Number(item.rotation)))?.rotation
            ?? video.tags?.rotate
            ?? 0),
        }
      : null,
    audio: audio
      ? {
          codec: audio.codec_name || null,
          sample_rate: Number(audio.sample_rate || 0) || null,
          channels: Number(audio.channels || 0) || null,
        }
      : null,
    reused: false,
  };
}

export function buildCompatibility(sources) {
  const blocking = [];
  const warnings = [];
  for (const source of sources) {
    if (source.expected_kind === "video" && !source.video) blocking.push(`${source.label} has no video stream.`);
    if (source.expected_kind === "audio" && !source.audio) blocking.push(`${source.label} has no audio stream.`);
    if (!Number.isFinite(source.duration_sec) || source.duration_sec <= 0) blocking.push(`${source.label} has no readable duration.`);
  }

  const cameras = sources.filter((source) => source.expected_kind === "video" && source.video);
  const isolatedAudio = sources.filter((source) => source.expected_kind === "audio" && source.audio);
  if (cameras.length < 2) warnings.push("Only one camera is attached; speaker-aware camera switching is not available.");
  if (isolatedAudio.length < 2) warnings.push("Two isolated host audio tracks are not attached; speaker attribution will need another method.");

  if (cameras.length >= 2) {
    const fpsValues = cameras.map((source) => source.video.fps).filter((fps) => fps > 0);
    if (fpsValues.length === cameras.length && Math.max(...fpsValues) - Math.min(...fpsValues) > 0.05) {
      warnings.push("Camera frame rates differ; measure end-of-take drift before editing.");
    }
  }
  for (const source of cameras) {
    if (source.video.width < 3840 || source.video.height < 2160) {
      warnings.push(`${source.label} is below 4K; a 9:16 crop may look soft.`);
    }
  }

  const durations = sources.map((source) => source.duration_sec).filter((duration) => duration > 0);
  const durationSpreadSec = durations.length > 1 ? Math.max(...durations) - Math.min(...durations) : 0;
  if (durationSpreadSec > 5) warnings.push(`Source durations differ by ${durationSpreadSec.toFixed(1)} seconds; confirm start and end coverage.`);

  const sampleRates = isolatedAudio.map((source) => source.audio.sample_rate).filter(Boolean);
  if (sampleRates.length >= 2 && new Set(sampleRates).size > 1) {
    warnings.push("Isolated audio sample rates differ; normalize them before measuring drift.");
  }

  const status = blocking.length ? "blocked" : warnings.length ? "attention" : "ready";
  return {
    status,
    blocking,
    warnings: [...new Set(warnings)],
    camera_count: cameras.length,
    isolated_audio_count: isolatedAudio.length,
    duration_spread_sec: durationSpreadSec,
    sync_status: "not_measured",
    next_step: "Measure waveform offsets and end-clap drift before treating these sources as synchronized.",
  };
}

export function validateInput(path, expectedKind, label) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`${label} was not found at ${path}`);
  const extension = extname(path).toLowerCase();
  const allowed = expectedKind === "video" ? VIDEO_EXTENSIONS : AUDIO_EXTENSIONS;
  if (!allowed.has(extension)) {
    fail(`${label} must be ${expectedKind === "video" ? "MP4, MOV, M4V, or MKV" : "WAV, M4A, MP3, FLAC, or AAC"}`);
  }
}

export function logicalSourceFromSequence(sequence) {
  if (!sequence?.ready) return null;
  const first = sequence.parts[0];
  const derived = sequence.derived_source || {};
  return {
    id: sequence.role,
    label: sequence.label,
    expected_kind: "audio",
    path: derived.path || first.path,
    file: derived.file || first.file,
    extension: extname(derived.path || first.path).toLowerCase(),
    bytes: Number(derived.bytes || first.bytes || 0),
    modified_ms: Number(derived.modified_ms || first.modified_ms || 0),
    local_availability: first.local_availability,
    duration_sec: Number(sequence.total_recorded_duration_sec || first.duration_sec || 0),
    container: derived.mode === "ordered_lossless_concat_flac" ? "flac" : first.container,
    bit_rate: first.bit_rate || null,
    video: null,
    audio: first.audio,
    sequence_fingerprint: sequence.fingerprint,
    parts: sequence.parts.map((part) => ({
      id: part.id,
      path: part.path,
      file: part.file,
      bytes: part.bytes,
      modified_ms: part.modified_ms,
      sha256: part.sha256,
      duration_sec: part.duration_sec,
      order: part.order,
    })),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const analyzeOnly = args.includes("--analyze-only");
  const definitions = [
    { flag: "--primary-camera", id: "primary_camera", label: "Host 1 camera", expected_kind: "video", required: true },
    { flag: "--secondary-camera", id: "secondary_camera", label: "Host 2 camera", expected_kind: "video" },
  ];
  const inputs = definitions
    .map((definition) => ({ ...definition, value: option(args, definition.flag) }))
    .filter((definition) => definition.value)
    .map((definition) => ({ ...definition, path: resolve(definition.value) }));
  const primary = inputs.find((input) => input.id === "primary_camera");
  if (!primary) fail("Host 1 camera is required");
  const sequenceDefinitions = [
    { role: "host_1_audio", label: "Host 1 isolated audio", flag: "--host-1-audio-part", legacyFlag: "--host-1-audio", confirmedFlag: "--host-1-order-confirmed" },
    { role: "host_2_audio", label: "Host 2 isolated audio", flag: "--host-2-audio-part", legacyFlag: "--host-2-audio", confirmedFlag: "--host-2-order-confirmed" },
  ];
  const sequenceInputs = sequenceDefinitions.map((definition) => {
    const repeated = options(args, definition.flag);
    const legacy = option(args, definition.legacyFlag);
    const values = repeated.length ? repeated : legacy ? [legacy] : [];
    return {
      ...definition,
      order_confirmed: repeated.length ? args.includes(definition.confirmedFlag) : Boolean(legacy),
      parts: values.map((value, index) => ({
        id: `${definition.role}_part_${String(index + 1).padStart(3, "0")}`,
        label: `${definition.label} part ${index + 1}`,
        expected_kind: "audio",
        path: resolve(value),
      })),
    };
  }).filter((sequence) => sequence.parts.length);
  const allInputPaths = [...inputs.map((input) => input.path), ...sequenceInputs.flatMap((sequence) => sequence.parts.map((part) => part.path))];
  if (new Set(allInputPaths).size !== allInputPaths.length) {
    fail("each source role must point to a different file");
  }
  for (const source of inputs) {
    validateInput(source.path, source.expected_kind, source.label);
    source.local_receipt = assertStableLocalFile(source.path);
  }
  for (const sequence of sequenceInputs) {
    for (const part of sequence.parts) {
      validateInput(part.path, "audio", part.label);
      part.local_receipt = assertStableLocalFile(part.path);
    }
  }

  const slug = slugify(primary.path);
  if (!slug) fail("could not derive an episode name from the Host 1 camera filename");
  const workRoot = resolve(option(args, "--work-root") || join(ROOT, "work"));
  const workDir = join(workRoot, slug);
  mkdirSync(workDir, { recursive: true });
  const existingMeta = readJson(join(workDir, "meta.json"), {});
  const manifestPath = join(workDir, "episode.json");
  const previous = readJson(manifestPath, { sources: [] });
  const existingPrimary = (previous.sources || []).find((source) => source.id === "primary_camera")?.path;
  const claimedPrimary = existingMeta.source || existingPrimary;
  if (claimedPrimary && resolve(claimedPrimary) !== primary.path) {
    fail(`work/${slug} already belongs to a different source file; rename one recording before continuing`);
  }

  const cameraSources = inputs.map((source) => {
    const cached = (previous.sources || []).find((item) => item.id === source.id);
    return probeSource(source, cached);
  });
  const audioSequences = {};
  for (const input of sequenceInputs) {
    const partReceipts = [];
    for (const part of input.parts) {
      const cachedSequence = previous.audio_sequences?.[input.role];
      const cached = cachedSequence?.parts?.find((item) => item.path === part.path);
      const receipt = probeSource(part, cached);
      receipt.sha256 = cached?.bytes === receipt.bytes && cached?.modified_ms === receipt.modified_ms && cached?.sha256
        ? cached.sha256
        : await sha256File(part.path);
      partReceipts.push(receipt);
    }
    let mappings = [];
    let analysisError = null;
    if (partReceipts.length > 1) {
      try {
        mappings = measurePartMappings(cameraSources.find((source) => source.id === "primary_camera"), partReceipts);
      } catch (error) {
        analysisError = error.message;
      }
    } else if (partReceipts.length === 1) {
      mappings = [{ mapped_start_sec: null, mapped_end_sec: null, start_confidence: 0, end_confidence: 0, method: "single-part" }];
    }
    const sequence = buildSequenceReceipt({
      role: input.role,
      label: input.label,
      parts: partReceipts,
      mappings,
      orderConfirmed: input.order_confirmed,
      referenceDurationSec: cameraSources.find((source) => source.id === "primary_camera")?.duration_sec,
      previous: previous.audio_sequences?.[input.role],
    });
    if (analysisError) sequence.analysis_error = analysisError;
    if (sequence.seams.length) {
      try { createSeamPreviews(sequence, workDir); } catch (error) { sequence.preview_error = error.message; }
    }
    audioSequences[input.role] = sequence;
  }
  const sources = [
    ...cameraSources,
    ...Object.values(audioSequences).map(logicalSourceFromSequence).filter(Boolean),
  ];
  const compatibility = buildCompatibility(sources);
  const pendingSequences = Object.values(audioSequences).filter((sequence) => !sequence.ready);
  if (pendingSequences.length) {
    compatibility.status = compatibility.blocking.length ? "blocked" : "attention";
    compatibility.warnings.push(...pendingSequences.map((sequence) => `${sequence.label} needs confirmed part order and seam review before it becomes a logical host track.`));
    compatibility.audio_sequence_status = "review_required";
    compatibility.next_step = "Review the ordered wireless microphone parts and play every seam before waveform sync or host-track transcription.";
  } else if (Object.keys(audioSequences).length) {
    compatibility.audio_sequence_status = "approved";
  }
  const analyzedAt = new Date().toISOString();
  const primaryWasReused = sources.find((source) => source.id === "primary_camera")?.reused;
  const transcriptReady = existsSync(join(workDir, "transcript.srt")) && existingMeta.source === primary.path;
  const sequenceContextChanged = JSON.stringify(Object.fromEntries(Object.entries(audioSequences).map(([role, sequence]) => [role, sequence.fingerprint])))
    !== JSON.stringify(Object.fromEntries(Object.entries(previous.audio_sequences || {}).map(([role, sequence]) => [role, sequence.fingerprint])));
  const candidateContextChanged = !primaryWasReused || !transcriptReady || sequenceContextChanged;
  const transcriptionStatus = compatibility.blocking.length
    ? "blocked"
    : primaryWasReused && transcriptReady
      ? "reused"
      : analyzeOnly
        ? "not_run"
        : "pending";
  const manifest = {
    schema: "eaol-episode-v1",
    slug,
    analyzed_at: analyzedAt,
    candidate_context_reset_at: candidateContextChanged
      ? analyzedAt
      : previous.candidate_context_reset_at || null,
    sources,
    audio_sequences: audioSequences,
    compatibility,
    transcription: {
      status: transcriptionStatus,
      updated_at: analyzedAt,
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  saveEpisodeChecklist(workDir, loadEpisodeChecklist(workDir, { slug, title: slug }));
  if (candidateContextChanged) {
    const clipDoc = readJson(join(workDir, "clips.json"), { clips: [] });
    if ((clipDoc.clips || []).length) {
      const savedReview = readJson(join(workDir, "studio_review.json"), { clips: {} });
      const clips = Object.fromEntries((clipDoc.clips || []).map((clip) => [
        clip.id,
        {
          status: clip.proposed_by === "studio" ? "suggested" : "proposed",
          notes: String(savedReview?.clips?.[clip.id]?.notes || ""),
          reviewed_by: savedReview?.clips?.[clip.id]?.reviewed_by || null,
          reviewed_at: savedReview?.clips?.[clip.id]?.reviewed_at || null,
          discussion: Array.isArray(savedReview?.clips?.[clip.id]?.discussion) ? savedReview.clips[clip.id].discussion : [],
        },
      ]));
      writeFileSync(join(workDir, "studio_review.json"), `${JSON.stringify({
        schema: "eaol-review-v2",
        clips,
        updated_at: analyzedAt,
        invalidated_at: analyzedAt,
        invalidated_reason: "The Host 1 source or transcript context changed. Review candidates again before rendering.",
      }, null, 2)}\n`);
      console.log("Candidate approvals reset because the Host 1 source or transcript context changed.");
    }
  }
  console.log(`Source receipt: ${sources.length} file${sources.length === 1 ? "" : "s"} · ${compatibility.status}`);
  for (const warning of compatibility.warnings) console.log(`ATTENTION: ${warning}`);
  for (const problem of compatibility.blocking) console.log(`BLOCKED: ${problem}`);
  if (compatibility.blocking.length) fail("source intake has blocking problems; fix them before transcription");
  if (analyzeOnly) {
    console.log(`Analysis complete: ${workDir}`);
    return;
  }

  if (primaryWasReused && transcriptReady) {
    console.log("Reusing completed transcript for the unchanged Host 1 camera.");
    console.log(`Done: ${workDir}`);
    return;
  }

  console.log("Transcribing the Host 1 camera locally…");
  const transcribe = spawnSync(process.execPath, [
    join(ROOT, "transcribe.mjs"),
    "--input", primary.path,
    "--work-root", workRoot,
  ], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (transcribe.stdout) process.stdout.write(transcribe.stdout);
  if (transcribe.stderr) process.stderr.write(transcribe.stderr);
  if (transcribe.error || transcribe.status !== 0) {
    manifest.transcription = {
      status: "failed",
      updated_at: new Date().toISOString(),
      error: transcribe.error?.message || `transcription exited ${transcribe.status || 1}`,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (transcribe.error) fail(`transcription failed to start: ${transcribe.error.message}`);
    process.exit(transcribe.status || 1);
  }
  manifest.transcription = { status: "complete", updated_at: new Date().toISOString() };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Done: ${workDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error.message));
}
