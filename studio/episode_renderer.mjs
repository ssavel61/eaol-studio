#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveTool } from "../platform_tools.mjs";
import { manifestSourceSignature, sourceReceiptsAreCurrent } from "./sync.mjs";
import { timelineReceiptMatchesInputs } from "./timeline.mjs";
import { timelinePreviewMatchesInputs } from "./timeline_preview.mjs";
import {
  assemblyAssetsAreCurrent,
  episodeAssemblyMatchesInputs,
  episodeAssemblyReviewMatchesPlan,
} from "./episode_assembly.mjs";
import { renderCtaOverlay } from "./cta_overlay.mjs";
import { renderProgramGraphicOverlay } from "./program_graphics.mjs";
import { channelPreflightMatchesInputs } from "./channel_preflight.mjs";
import { speakerActivityMatchesInputs } from "./speaker_activity.mjs";
import { cameraPlanMatchesInputs } from "./camera_plan.mjs";
import {
  buildCameraPlanSamples,
  cameraPlanReviewMatchesInputs,
  requiresRepresentativeCameraReview,
} from "./camera_plan_review.mjs";
import { loadShowPackageState } from "./show_package.mjs";
import { episodeProxyReviewMatches } from "./episode_proxy_review.mjs";
import { parseLoudnormJson } from "./delivery_audio.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FFMPEG = resolveTool("ffmpeg");
const FFPROBE = resolveTool("ffprobe");
export const PROXY_RENDER_PROFILE = Object.freeze({
  label: "Low-resolution review proxy",
  width: 960,
  height: 540,
  frame_rate: 30,
  video_codec: "h264",
  audio_codec: "aac",
});
export const FULL_RENDER_PROFILE = Object.freeze({
  label: "4K UHD local master",
  width: 3840,
  height: 2160,
  frame_rate: 30,
  video_codec: "h264",
  audio_codec: "aac",
});
// Standalone show-package previews retain their established 1080p review size.
// renderApprovedEpisode selects the explicit proxy or 4K master profile before rendering.
let WIDTH = 1920;
let HEIGHT = 1080;
const FRAME_RATE = 30;
let VIDEO_PRESET = "medium";
let VIDEO_CRF = "18";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const VIDEO_AUDIO_BALANCE_TARGET = Object.freeze({
  integrated_tolerance_lu: 1,
  true_peak_dbtp_max: -1,
  loudness_range_lu: 11,
});

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function seconds(ms) {
  return (Number(ms || 0) / 1_000).toFixed(6);
}

function dbToLinear(db) {
  return 10 ** (Number(db) / 20);
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed: ${String(result.stderr || result.stdout).trim()}`);
  return result;
}

function runFfmpeg(args, label) {
  return run(FFMPEG, ["-hide_banner", "-y", "-v", "error", ...args], label);
}

export function videoLoudnessAnalysisArgs(inputPath, targetIntegratedLufs = -16) {
  const target = VIDEO_AUDIO_BALANCE_TARGET;
  return [
    "-hide_banner", "-nostats", "-i", inputPath,
    "-map", "0:a:0",
    "-af", `loudnorm=I=${Number(targetIntegratedLufs)}:LRA=${target.loudness_range_lu}:TP=${target.true_peak_dbtp_max}:print_format=json`,
    "-f", "null", "-",
  ];
}

export function normalizedVideoSegmentArgs({ inputPath, outputPath, targetIntegratedLufs, measurement, truePeakDbtpMax = VIDEO_AUDIO_BALANCE_TARGET.true_peak_dbtp_max }) {
  const target = VIDEO_AUDIO_BALANCE_TARGET;
  const filter = [
    `loudnorm=I=${Number(targetIntegratedLufs)}`,
    `LRA=${target.loudness_range_lu}`,
    `TP=${Number(truePeakDbtpMax)}`,
    `measured_I=${measurement.input_i}`,
    `measured_LRA=${measurement.input_lra}`,
    `measured_TP=${measurement.input_tp}`,
    `measured_thresh=${measurement.input_thresh}`,
    `offset=${measurement.target_offset}`,
    "linear=true",
    "print_format=summary",
  ].join(":");
  return [
    "-i", inputPath,
    "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "copy",
    "-af", filter,
    "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", outputPath,
  ];
}

function measureVideoLoudness(path, targetIntegratedLufs = -16) {
  const result = run(FFMPEG, videoLoudnessAnalysisArgs(path, targetIntegratedLufs), `loudness analysis for ${basename(path)}`);
  const measurement = parseLoudnormJson(result.stderr);
  return {
    integrated_lufs: measurement.input_i,
    true_peak_dbtp: measurement.input_tp,
    loudness_range_lu: measurement.input_lra,
    threshold_lufs: measurement.input_thresh,
    target_offset_lu: measurement.target_offset,
    raw: measurement,
  };
}

export function balanceOpeningToProgram({ openingPath, programPath, outputPath, encodingHeadroomDb = 0 }) {
  if (!Number.isFinite(encodingHeadroomDb) || encodingHeadroomDb < 0 || encodingHeadroomDb > 2) throw new Error("Invalid opening encoding headroom");
  const target = VIDEO_AUDIO_BALANCE_TARGET;
  const program = measureVideoLoudness(programPath);
  if (program.integrated_lufs < -70 || program.integrated_lufs > -5) {
    throw new Error(`program loudness ${program.integrated_lufs} LUFS is outside FFmpeg's supported matching range`);
  }
  const openingInput = measureVideoLoudness(openingPath, program.integrated_lufs);
  runFfmpeg(normalizedVideoSegmentArgs({
    inputPath: openingPath,
    outputPath,
    targetIntegratedLufs: program.integrated_lufs,
    measurement: openingInput.raw,
    truePeakDbtpMax: target.true_peak_dbtp_max - encodingHeadroomDb,
  }), "opening-to-program loudness match");
  const openingOutput = measureVideoLoudness(outputPath, program.integrated_lufs);
  const checks = {
    opening_matches_program: Math.abs(openingOutput.integrated_lufs - program.integrated_lufs) <= target.integrated_tolerance_lu,
    opening_true_peak: openingOutput.true_peak_dbtp <= target.true_peak_dbtp_max,
  };
  if (Object.values(checks).some((value) => !value)) {
    throw new Error(`opening audio balance checks failed: ${JSON.stringify(checks)}`);
  }
  const compact = ({ raw, ...measurement }) => measurement;
  return {
    mode: "opening_matched_to_program_v1",
    encoding_headroom_db: encodingHeadroomDb,
    reference_section: "program",
    target: {
      integrated_lufs: program.integrated_lufs,
      integrated_tolerance_lu: target.integrated_tolerance_lu,
      true_peak_dbtp_max: target.true_peak_dbtp_max,
    },
    program: compact(program),
    opening_input: compact(openingInput),
    opening_output: compact(openingOutput),
    applied_gain_lu: Number((program.integrated_lufs - openingInput.integrated_lufs).toFixed(2)),
    checks,
  };
}

export function probeMedia(path) {
  const result = run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels:stream_tags=rotate:stream_side_data=rotation",
    "-of", "json",
    path,
  ], `probe ${basename(path)}`);
  const parsed = JSON.parse(result.stdout);
  const video = (parsed.streams || []).find((stream) => stream.codec_type === "video") || null;
  const audio = (parsed.streams || []).find((stream) => stream.codec_type === "audio") || null;
  return {
    duration_sec: Number(parsed.format?.duration || 0),
    video: video ? {
      ...video,
      rotation_degrees: Number(video.side_data_list?.find((item) => Number.isFinite(Number(item.rotation)))?.rotation
        ?? video.tags?.rotate
        ?? 0),
    } : null,
    audio,
  };
}

function timelineSourceMs(track, timelineMs) {
  return Number(track.source_in_ms || 0)
    + (Number(timelineMs) - Number(track.timeline_start_ms || 0)) * Number(track.alignment?.playback_rate || 1);
}

function orientationFilter(rotationDegrees = 0) {
  const normalized = ((Math.round(Number(rotationDegrees || 0)) % 360) + 360) % 360;
  if (normalized === 90) return "transpose=clock,";
  if (normalized === 180) return "hflip,vflip,";
  if (normalized === 270) return "transpose=cclock,";
  return "";
}

function videoFitFilter(rotationDegrees = 0) {
  return `${orientationFilter(rotationDegrees)}scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FRAME_RATE},format=yuv420p`;
}

function sideBySidePanelFilter(rotationDegrees = 0, framing = null) {
  const panelWidth = WIDTH / 2;
  const zoom = framing ? Number(framing.zoom || 1) : 1;
  const scaleWidth = Math.ceil(panelWidth * zoom / 2) * 2;
  const scaleHeight = Math.ceil(HEIGHT * zoom / 2) * 2;
  const anchorX = clamp(0.5 + Number(framing?.horizontal || 0) / 200, 0, 1).toFixed(4);
  const anchorY = clamp(0.5 + Number(framing?.vertical || 0) / 200, 0, 1).toFixed(4);
  return `${orientationFilter(rotationDegrees)}scale=${scaleWidth}:${scaleHeight}:force_original_aspect_ratio=increase,`
    + `crop=${panelWidth}:${HEIGHT}:x='(in_w-out_w)*${anchorX}':y='(in_h-out_h)*${anchorY}',`
    + `setsar=1,fps=${FRAME_RATE},format=yuv420p`;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function suggestCameraBalance(measuredLuma = {}) {
  const entries = Object.entries(measuredLuma).filter(([, value]) => Number.isFinite(Number(value)));
  if (!entries.length) return { target_luma: null, mismatch_ratio: null, adjustments: {} };
  const values = entries.map(([, value]) => Number(value));
  const brightest = Math.max(...values);
  const darkest = Math.max(1, Math.min(...values));
  const targetLuma = (brightest + darkest) / 2;
  const adjustments = Object.fromEntries(entries.map(([sourceId, rawLuma]) => {
    const luma = Number(rawLuma);
    const delta = targetLuma - luma;
    const meaningful = Math.abs(delta) >= 12;
    return [sourceId, {
      measured_luma: Number(luma.toFixed(3)),
      brightness: meaningful ? Number(clamp(delta / 255 * 0.35, -0.04, 0.04).toFixed(4)) : 0,
      contrast: 1,
      gamma: meaningful ? Number(clamp(1 + delta / 255 * 0.65, 0.92, 1.08).toFixed(4)) : 1,
      saturation: 1,
    }];
  }));
  return {
    target_luma: Number(targetLuma.toFixed(3)),
    mismatch_ratio: Number((brightest / darkest).toFixed(3)),
    adjustments,
  };
}

function sampleTrackLuma(track, timelineMs) {
  const sourceMs = timelineSourceMs(track, timelineMs);
  const result = run(FFMPEG, [
    "-hide_banner", "-v", "error", "-ss", seconds(sourceMs), "-i", track.source_path,
    "-frames:v", "1", "-vf", "scale=320:-2,signalstats,metadata=print:file=-", "-f", "null", "-",
  ], `camera balance sample for ${track.label || track.source_id}`);
  const match = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(result.stdout);
  if (!match) throw new Error(`could not measure camera brightness for ${track.label || track.source_id}`);
  return Number(match[1]);
}

function buildCameraBalance({ assembly, timeline }) {
  if (!assembly.visual_style?.camera_balance?.enabled) {
    return { enabled: false, mode: "off", target_luma: null, mismatch_ratio: null, adjustments: {} };
  }
  const tracks = (timeline.tracks || []).filter((track) => track.media_kind === "video" && track.source_path);
  const start = Number(assembly.program.start_ms);
  const duration = Number(assembly.program.duration_ms);
  const positions = [0.2, 0.5, 0.8].map((fraction) => start + duration * fraction);
  const measured = Object.fromEntries(tracks.map((track) => {
    const samples = positions
      .filter((position) => position >= Number(track.timeline_start_ms) && position <= Number(track.timeline_end_ms))
      .map((position) => sampleTrackLuma(track, position))
      .sort((left, right) => left - right);
    if (!samples.length) throw new Error(`camera balance has no common sample for ${track.label || track.source_id}`);
    return [track.source_id, samples[Math.floor(samples.length / 2)]];
  }));
  return { enabled: true, mode: "gentle_auto_v1", ...suggestCameraBalance(measured) };
}

function cameraBalanceFilter(cameraBalance, sourceId) {
  const adjustment = cameraBalance?.adjustments?.[sourceId];
  if (!cameraBalance?.enabled || !adjustment) return "";
  return `eq=brightness=${adjustment.brightness}:contrast=${adjustment.contrast}:gamma=${adjustment.gamma}:saturation=${adjustment.saturation},`;
}

function cameraTemperatureFilter(assembly, sourceId) {
  const framing = assembly.visual_style?.camera_framing;
  const temperature = framing?.enabled ? Number(framing.sources?.[sourceId]?.temperature || 0) : 0;
  if (!temperature) return "";
  const shift = clamp(temperature * 0.045, -0.045, 0.045).toFixed(4);
  return `colorbalance=rm=${shift}:bm=${(-Number(shift)).toFixed(4)}:pl=1,`;
}

export function selectProgramAudio({ timeline, speakerActivity = null }) {
  const tracks = new Map((timeline.tracks || []).map((track) => [track.source_id, track]));
  const hostOne = tracks.get("host_1_audio");
  const hostTwo = tracks.get("host_2_audio");
  if (hostOne?.source_path && hostTwo?.source_path) {
    const floors = speakerActivity?.noise_floor_dbfs || {};
    const thresholdDb = (floor) => Math.max(-60, Math.min(-36, Number.isFinite(Number(floor)) ? Number(floor) + 15 : -48));
    return {
      mode: "aligned_isolated_transmitter_automix",
      tracks: [hostOne, hostTwo],
      gate_threshold_dbfs: {
        host_1: thresholdDb(floors.host_1),
        host_2: thresholdDb(floors.host_2),
      },
      activity_fingerprint: speakerActivity?.fingerprint || null,
      automation: Array.isArray(speakerActivity?.segments) && speakerActivity.segments.length
        ? "speaker_activity_dominance_v1"
        : "level_gate_fallback_v1",
    };
  }
  const reference = tracks.get(timeline.reference_source_id)
    || [...tracks.values()].find((track) => track.media_kind === "video");
  if (!reference?.source_path) throw new Error("the aligned timeline has no usable program audio source");
  return { mode: "reference_camera_fallback", tracks: [reference], gate_threshold_dbfs: null };
}

function activityGain(segment, role) {
  if (segment.state === role) return 1;
  if (segment.state === "host_1" || segment.state === "host_2") return 0.05;
  if (segment.state === "both") return 0.68;
  if (segment.state === "silence") return 0.12;
  const left = Number(segment.left_dbfs ?? -120);
  const right = Number(segment.right_dbfs ?? -120);
  if (Math.abs(left - right) >= 1.5) {
    const louder = left > right ? "host_1" : "host_2";
    return louder === role ? 0.8 : 0.08;
  }
  return 0.5;
}

function balancedExpressionSum(terms) {
  if (terms.length === 1) return terms[0];
  const midpoint = Math.ceil(terms.length / 2);
  return `(${balancedExpressionSum(terms.slice(0, midpoint))}+${balancedExpressionSum(terms.slice(midpoint))})`;
}

export function speakerActivityGainExpression({ speakerActivity, role, programStartMs, programEndMs }) {
  const defaultGain = 0.12;
  const intervals = [];
  const segments = speakerActivity?.segments || [];
  for (let bucketStart = Number(programStartMs); bucketStart < Number(programEndMs); bucketStart += 1_000) {
    const bucketEnd = Math.min(Number(programEndMs), bucketStart + 1_000);
    const totals = { host_1: 0, host_2: 0, both: 0, silence: 0 };
    for (const segment of segments) {
      const overlap = Math.min(bucketEnd, Number(segment.end_ms)) - Math.max(bucketStart, Number(segment.start_ms));
      if (overlap <= 0) continue;
      if (segment.state === "host_1" || segment.state === "host_2" || segment.state === "both" || segment.state === "silence") {
        totals[segment.state] += overlap;
      } else {
        const left = Number(segment.left_dbfs ?? -120);
        const right = Number(segment.right_dbfs ?? -120);
        if (Math.abs(left - right) >= 1.5) totals[left > right ? "host_1" : "host_2"] += overlap;
        else totals.both += overlap;
      }
    }
    let state = "silence";
    if (totals.both >= 300 || (totals.host_1 >= 250 && totals.host_2 >= 250)) state = "both";
    else if (totals.host_1 > 0 || totals.host_2 > 0) state = totals.host_1 >= totals.host_2 ? "host_1" : "host_2";
    const gain = activityGain({ state }, role);
    const previous = intervals.at(-1);
    if (previous && previous.gain === gain && Math.abs(previous.end_ms - bucketStart) <= 1) previous.end_ms = bucketEnd;
    else intervals.push({ start_ms: bucketStart, end_ms: bucketEnd, gain });
  }
  const adjustments = intervals
    .filter((interval) => interval.gain !== defaultGain)
    .map((interval) => {
      const start = ((interval.start_ms - programStartMs) / 1_000).toFixed(6);
      const end = Math.max(Number(start), (interval.end_ms - programStartMs) / 1_000 - 0.000001).toFixed(6);
      const delta = interval.gain - defaultGain;
      const term = `${Math.abs(delta).toFixed(6)}*between(t\\,${start}\\,${end})`;
      return delta < 0 ? `(-${term})` : term;
    });
  return adjustments.length ? balancedExpressionSum([String(defaultGain), ...adjustments]) : "1";
}

export function buildMainEdit({ assembly, timeline, speakerActivity = null, cameraBalance = null, outputPath }) {
  const tracks = new Map((timeline.tracks || []).map((track) => [track.source_id, track]));
  const shots = assembly.program?.shots || [];
  if (!shots.length) throw new Error("the approved assembly has no camera shots");
  const programStartMs = Number(assembly.program.start_ms);
  const timelineFrame = (timelineMs) => Math.round((Number(timelineMs) - programStartMs) * FRAME_RATE / 1_000);
  const timelineMsAtFrame = (frame) => programStartMs + Number(frame) * 1_000 / FRAME_RATE;
  const args = [];
  const filters = [];
  let inputIndex = 0;
  shots.forEach((shot, index) => {
    const nextTransition = shots[index + 1]?.transition_in;
    const startFrame = timelineFrame(shot.start_ms);
    const endFrame = timelineFrame(shot.end_ms);
    const shotFrameCount = endFrame - startFrame;
    if (shotFrameCount <= 0) throw new Error(`camera shot ${shot.id || index + 1} is shorter than one output frame`);
    const extensionFrames = nextTransition?.type === "dissolve"
      ? Math.round(Number(nextTransition.duration_ms || 0) * FRAME_RATE / 1_000)
      : 0;
    const renderFrameCount = shotFrameCount + extensionFrames;
    const quantizedTimelineStart = timelineMsAtFrame(startFrame);
    const extendedTimelineEnd = timelineMsAtFrame(endFrame + extensionFrames);
    const layout = shot.layout || "isolated";
    const sourceIds = layout === "side_by_side"
      ? shot.camera_source_ids || []
      : [shot.camera_source_id];
    if (layout === "side_by_side" && sourceIds.length !== 2) {
      throw new Error(`side-by-side shot ${shot.id || index + 1} must name exactly two camera sources`);
    }
    const panelLabels = [];
    sourceIds.forEach((sourceId, panelIndex) => {
      const track = tracks.get(sourceId);
      if (!track?.source_path) throw new Error(`camera source ${sourceId} is missing from the aligned timeline`);
      if (extendedTimelineEnd > Number(track.timeline_end_ms)) {
        throw new Error(`${track.label} does not cover the ${extensionFrames}-frame dissolve after ${shot.end}`);
      }
      const rate = Number(track.alignment?.playback_rate || 1);
      const sourceStartMs = timelineSourceMs(track, quantizedTimelineStart);
      const sourceDurationMs = renderFrameCount * 1_000 / FRAME_RATE * rate;
      const rotationDegrees = probeMedia(track.source_path).video?.rotation_degrees || 0;
      args.push("-ss", seconds(sourceStartMs), "-t", seconds(sourceDurationMs), "-i", track.source_path);
      const label = layout === "side_by_side" ? `shot${index}panel${panelIndex}` : `shot${index}`;
      filters.push(
        `[${inputIndex}:v]setpts=(PTS-STARTPTS)/${rate.toFixed(9)},`
        + cameraBalanceFilter(cameraBalance, sourceId)
        + cameraTemperatureFilter(assembly, sourceId)
        + `${layout === "side_by_side" ? sideBySidePanelFilter(
          rotationDegrees,
          assembly.visual_style?.camera_framing?.enabled
            ? assembly.visual_style.camera_framing.sources?.[sourceId]
            : null,
        ) : videoFitFilter(rotationDegrees)},`
        + `trim=end_frame=${renderFrameCount},setpts=PTS-STARTPTS[${label}]`,
      );
      panelLabels.push(label);
      inputIndex += 1;
    });
    if (layout === "side_by_side") {
      const divider = assembly.visual_style?.side_by_side_divider;
      if (divider?.enabled) {
        const width = Math.max(1, Math.round(Number(divider.width_full_px || 4) * WIDTH / 1920));
        const color = String(divider.color || "#23333a").replace("#", "0x");
        filters.push(
          `[${panelLabels[0]}][${panelLabels[1]}]hstack=inputs=2,`
          + `drawbox=x=(iw-${width})/2:y=0:w=${width}:h=ih:color=${color}:t=fill[shot${index}]`,
        );
      } else {
        filters.push(`[${panelLabels[0]}][${panelLabels[1]}]hstack=inputs=2[shot${index}]`);
      }
    }
  });

  let current = "shot0";
  let elapsedFrames = timelineFrame(shots[0].end_ms) - timelineFrame(shots[0].start_ms);
  for (let index = 1; index < shots.length; index += 1) {
    const output = `joined${index}`;
    const transition = shots[index].transition_in || { type: "cut", duration_ms: 0 };
    if (transition.type === "dissolve") {
      const transitionFrames = Math.round(Number(transition.duration_ms || 0) * FRAME_RATE / 1_000);
      filters.push(
        `[${current}][shot${index}]xfade=transition=fade:duration=${(transitionFrames / FRAME_RATE).toFixed(6)}:offset=${(elapsedFrames / FRAME_RATE).toFixed(6)}[${output}]`,
      );
    } else {
      filters.push(`[${current}][shot${index}]concat=n=2:v=1:a=0[${output}]`);
    }
    current = output;
    elapsedFrames += timelineFrame(shots[index].end_ms) - timelineFrame(shots[index].start_ms);
  }

  const fadeInSec = Number(assembly.visual_style?.program_fade_in_ms || 0) / 1_000;
  if (fadeInSec) {
    filters.push(`[${current}]fade=t=in:st=0:d=${fadeInSec.toFixed(3)}[program_faded]`);
    current = "program_faded";
  }

  const programAudio = selectProgramAudio({ timeline, speakerActivity });
  if (programAudio.mode === "aligned_isolated_transmitter_automix") {
    const labels = [];
    programAudio.tracks.forEach((track, index) => {
      const rate = Number(track.alignment?.playback_rate || 1);
      const sourceStartMs = timelineSourceMs(track, assembly.program.start_ms);
      const sourceDurationMs = Number(assembly.program.duration_ms) * rate;
      const role = index === 0 ? "host_1" : "host_2";
      const threshold = dbToLinear(programAudio.gate_threshold_dbfs[role]).toFixed(8);
      const gainExpression = programAudio.automation === "speaker_activity_dominance_v1"
        ? speakerActivityGainExpression({
            speakerActivity,
            role,
            programStartMs: Number(assembly.program.start_ms),
            programEndMs: Number(assembly.program.end_ms),
          })
        : "1";
      args.push("-ss", seconds(sourceStartMs), "-t", seconds(sourceDurationMs), "-i", track.source_path);
      filters.push(
        `[${inputIndex}:a]asetpts=PTS-STARTPTS,atempo=${rate.toFixed(9)},aresample=48000,`
        + `aformat=sample_fmts=fltp:channel_layouts=mono,`
        + `agate=threshold=${threshold}:ratio=3:range=0.06125:attack=10:release=250,`
        + `volume=${gainExpression}:eval=frame[program_${role}]`,
      );
      labels.push(`program_${role}`);
      inputIndex += 1;
    });
    filters.push(
      `[${labels[0]}][${labels[1]}]amix=inputs=2:duration=longest:normalize=0,`
      + `alimiter=limit=0.95,aformat=sample_fmts=fltp:channel_layouts=stereo,`
      + `apad,atrim=duration=${seconds(assembly.program.duration_ms)}[program_audio]`,
    );
  } else {
    const referenceTrack = programAudio.tracks[0];
    const rate = Number(referenceTrack.alignment?.playback_rate || 1);
    const sourceStartMs = timelineSourceMs(referenceTrack, assembly.program.start_ms);
    const sourceDurationMs = Number(assembly.program.duration_ms) * rate;
    args.push("-ss", seconds(sourceStartMs), "-t", seconds(sourceDurationMs), "-i", referenceTrack.source_path);
    filters.push(
      `[${inputIndex}:a]asetpts=PTS-STARTPTS,atempo=${rate.toFixed(9)},aresample=48000,`
      + `aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${seconds(assembly.program.duration_ms)}[program_audio]`,
    );
  }
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${current}]`, "-map", "[program_audio]",
    "-c:v", "libx264", "-preset", VIDEO_PRESET, "-crf", VIDEO_CRF, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-t", seconds(assembly.program.duration_ms), "-movflags", "+faststart", outputPath,
  );
  return args;
}

function cueExpression(assembly, cues) {
  return cues.map((cue) => {
    const start = Math.max(0, (Number(cue.start_ms) - Number(assembly.program.start_ms)) / 1_000);
    const end = Math.max(start, (Number(cue.end_ms) - Number(assembly.program.start_ms)) / 1_000);
    return `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
  }).join("+");
}

function applyProgramCtas({ assembly, inputPath, overlayPaths, outputPath }) {
  const cues = assembly.cta_graphic?.cues || [];
  if (!cues.length) {
    copyFileSync(inputPath, outputPath);
    return;
  }
  const args = ["-i", inputPath];
  const filters = [];
  let current = "0:v";
  let inputIndex = 1;
  const configurations = [
    {
      type: "podcast_growth",
      cues: cues.filter((cue) => cue.cta_type !== "newsletter"),
      overlayPath: overlayPaths.podcast,
      custom: assembly.cta_graphic?.asset,
    },
    {
      type: "newsletter",
      cues: cues.filter((cue) => cue.cta_type === "newsletter"),
      overlayPath: overlayPaths.newsletter,
      custom: assembly.newsletter_cta?.asset,
    },
  ];
  configurations.forEach((configuration) => {
    if (!configuration.cues.length) return;
    if (!configuration.overlayPath) throw new Error(`${configuration.type} CTA overlay is missing`);
    args.push("-loop", "1", "-framerate", String(FRAME_RATE), "-i", configuration.overlayPath);
    const generatedLabel = `generated_${configuration.type}`;
    const composedLabel = `with_${configuration.type}`;
    const scale = WIDTH / 1920;
    filters.push(`[${inputIndex}:v]scale=${Math.round(760 * scale)}:${Math.round(112 * scale)},format=rgba[${generatedLabel}]`);
    filters.push(
      `[${current}][${generatedLabel}]overlay=x=(W-w)/2:y=${Math.round(52 * scale)}:enable='${cueExpression(assembly, configuration.cues)}':eof_action=repeat[${composedLabel}]`,
    );
    current = composedLabel;
    inputIndex += 1;
    if (!configuration.custom) return;
    configuration.cues.forEach((cue, index) => {
      const custom = configuration.custom;
      const customLabel = `custom_${configuration.type}_${index}`;
      const customedLabel = `customed_${configuration.type}_${index}`;
      if (custom.kind === "image") args.push("-loop", "1", "-framerate", String(FRAME_RATE));
      else args.push("-stream_loop", "-1");
      args.push("-i", custom.path);
      const start = Math.max(0, (Number(cue.start_ms) - Number(assembly.program.start_ms)) / 1_000);
      const end = Math.max(start, (Number(cue.end_ms) - Number(assembly.program.start_ms)) / 1_000);
      filters.push(
        `[${inputIndex}:v]setpts=PTS-STARTPTS+${start.toFixed(3)}/TB,`
        + `scale=${Math.round(520 * scale)}:${Math.round(260 * scale)}:force_original_aspect_ratio=decrease,format=rgba[${customLabel}]`,
      );
      filters.push(
        `[${current}][${customLabel}]overlay=x=W-w-${Math.round(64 * scale)}:y=${Math.round(54 * scale)}:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})':eof_action=pass[${customedLabel}]`,
      );
      current = customedLabel;
      inputIndex += 1;
    });
  });
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${current}]`, "-map", "0:a",
    "-c:v", "libx264", "-preset", VIDEO_PRESET, "-crf", VIDEO_CRF, "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-movflags", "+faststart", "-shortest", outputPath,
  );
  runFfmpeg(args, "CTA overlay composition");
}

function graphicExpression(assembly, cue) {
  const start = Math.max(0, (Number(cue.start_ms) - Number(assembly.program.start_ms)) / 1_000);
  const end = Math.max(start, (Number(cue.end_ms) - Number(assembly.program.start_ms)) / 1_000);
  return `gte(t,${start.toFixed(3)})*lt(t,${end.toFixed(3)})`;
}

function applyProgramGraphics({ assembly, inputPath, overlays, outputPath }) {
  if (!assembly.program_graphics?.enabled || !overlays.length) {
    copyFileSync(inputPath, outputPath);
    return;
  }
  const args = ["-i", inputPath];
  const filters = [];
  let current = "0:v";
  overlays.forEach(({ cue, receipt }, index) => {
    args.push("-loop", "1", "-framerate", String(FRAME_RATE), "-i", receipt.path);
    const scale = WIDTH / 1920;
    const width = Math.round(receipt.width * scale);
    const height = Math.round(receipt.height * scale);
    const prepared = `graphic_${index}`;
    const composed = `with_graphic_${index}`;
    const y = (receipt.type === "lower_third" || cue.position === "bottom")
      ? `H-h-${Math.round(44 * scale)}`
      : String(Math.round(52 * scale));
    filters.push(`[${index + 1}:v]scale=${width}:${height},format=rgba[${prepared}]`);
    filters.push(
      `[${current}][${prepared}]overlay=x=(W-w)/2:y=${y}:enable='${graphicExpression(assembly, cue)}':eof_action=repeat[${composed}]`,
    );
    current = composed;
  });
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${current}]`, "-map", "0:a",
    "-c:v", "libx264", "-preset", VIDEO_PRESET, "-crf", VIDEO_CRF, "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-movflags", "+faststart", "-shortest", outputPath,
  );
  runFfmpeg(args, "program graphics composition");
}

function applyClosingAudioLead({ section, inputPath, outputPath }) {
  const leadSec = Number(section?.audio_lead_ms || 0) / 1_000;
  if (!leadSec) {
    copyFileSync(inputPath, outputPath);
    return;
  }
  const programDuration = probeMedia(inputPath).duration_sec;
  const delayMs = Math.max(0, Math.round((programDuration - leadSec) * 1_000));
  const audioSource = section.voiceover || section.music || section.visual;
  const audioProbe = probeMedia(audioSource.path);
  if (!audioProbe.audio) throw new Error("closing music lead requires audio in the closing visual or an attached closing audio track");
  runFfmpeg([
    "-i", inputPath,
    "-t", leadSec.toFixed(6), "-i", audioSource.path,
    "-filter_complex",
    `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[program_audio];`
      + `[1:a]atrim=duration=${leadSec.toFixed(6)},asetpts=PTS-STARTPTS,aresample=48000,`
      + `aformat=sample_fmts=fltp:channel_layouts=stereo,volume='0.22+0.78*t/${leadSec.toFixed(6)}':eval=frame,`
      + `volume=${Number(section.audio_gain_db || 0)}dB,adelay=${delayMs}|${delayMs}[closing_lead];`
      + `[program_audio][closing_lead]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[mixed_audio]`,
    "-map", "0:v", "-map", "[mixed_audio]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", outputPath,
  ], "closing music lead-in");
}

function packageDuration(section) {
  const source = section.voiceover || section.music || section.visual;
  const probe = probeMedia(source.path);
  if (section.voiceover && !probe.audio) throw new Error(`${source.path} has no recorded voiceover stream`);
  if (section.music && source === section.music && !probe.audio) throw new Error(`${source.path} has no audio stream`);
  if (!section.voiceover && !section.music && section.visual.kind === "image") {
    throw new Error("an image-based opening or closing package needs recorded audio or music to determine its length");
  }
  if (!Number.isFinite(probe.duration_sec) || probe.duration_sec <= 0) {
    throw new Error(`could not measure the duration of ${source.path}`);
  }
  return probe.duration_sec;
}

export function renderPackage({ section, outputPath, overlayPath = null, trimStartSec = 0 }) {
  const sourceDuration = packageDuration(section);
  const trimStart = Math.max(0, Number(trimStartSec || 0));
  const trimEnd = Number(section.trim_end_ms || 0) / 1_000;
  const duration = sourceDuration - trimStart - trimEnd;
  if (duration <= 0) throw new Error("package trim removes the complete selected asset");
  const args = [];
  if (section.visual.kind === "image") args.push("-loop", "1", "-framerate", String(FRAME_RATE));
  else args.push("-stream_loop", "-1");
  if (trimStart) args.push("-ss", trimStart.toFixed(6));
  args.push("-i", section.visual.path);
  let voiceIndex = null;
  let musicIndex = null;
  if (section.voiceover) {
    voiceIndex = 1;
    if (trimStart) args.push("-ss", trimStart.toFixed(6));
    args.push("-i", section.voiceover.path);
  }
  if (section.music) {
    musicIndex = voiceIndex === null ? 1 : 2;
    if (trimStart) args.push("-ss", trimStart.toFixed(6));
    args.push("-stream_loop", "-1", "-i", section.music.path);
  }
  const overlayIndex = overlayPath ? 1 + Number(voiceIndex !== null) + Number(musicIndex !== null) : null;
  if (overlayPath) args.push("-loop", "1", "-framerate", String(FRAME_RATE), "-i", overlayPath);

  const filters = [
    `[0:v]${videoFitFilter()},trim=duration=${duration.toFixed(6)},setpts=PTS-STARTPTS[package_video]`,
  ];
  let videoOutput = "package_video";
  if (overlayIndex !== null) {
    const scale = WIDTH / 1920;
    filters.push(`[${overlayIndex}:v]scale=${Math.round(760 * scale)}:${Math.round(112 * scale)},format=rgba[package_cta]`);
    filters.push(`[package_video][package_cta]overlay=x=(W-w)/2:y=${Math.round(52 * scale)}:eof_action=repeat[package_with_cta]`);
    videoOutput = "package_with_cta";
  }

  let audioOutput = "package_audio";
  const audioBase = `atrim=duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;
  if (voiceIndex !== null && musicIndex !== null) {
    const fadeStart = Math.max(0, duration - 1).toFixed(3);
    filters.push(`[${voiceIndex}:a]${audioBase},volume=1[voice]`);
    filters.push(`[${musicIndex}:a]${audioBase},volume=0.16,afade=t=out:st=${fadeStart}:d=1[music]`);
    filters.push("[voice][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[package_audio]");
  } else if (voiceIndex !== null) {
    filters.push(`[${voiceIndex}:a]${audioBase}[package_audio]`);
  } else if (musicIndex !== null) {
    filters.push(`[${musicIndex}:a]${audioBase}[package_audio]`);
  } else {
    const visualProbe = probeMedia(section.visual.path);
    if (!visualProbe.audio) throw new Error("the selected package visual has no audio; attach recorded intro or outro audio");
    filters.push(`[0:a]${audioBase}[package_audio]`);
  }

  if (trimEnd || Number(section.audio_gain_db || 0)) {
    const fade = trimEnd ? `,afade=t=out:st=${Math.max(0, duration - 0.3).toFixed(6)}:d=0.3` : "";
    filters.push(`[${audioOutput}]volume=${Number(section.audio_gain_db || 0)}dB${fade}[package_adjusted_audio]`);
    audioOutput = "package_adjusted_audio";
  }

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${videoOutput}]`, "-map", `[${audioOutput}]`,
    "-t", duration.toFixed(6),
    "-c:v", "libx264", "-preset", VIDEO_PRESET, "-crf", VIDEO_CRF, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", outputPath,
  );
  runFfmpeg(args, `${section === null ? "show" : "opening or closing"} package render`);
  return duration;
}

function concatSegments(segmentPaths, outputPath, listPath) {
  if (segmentPaths.length === 1) {
    copyFileSync(segmentPaths[0], outputPath);
    return;
  }
  const escapePath = (path) => path.replace(/'/g, "'\\''");
  writeFileSync(listPath, `${segmentPaths.map((path) => `file '${escapePath(path)}'`).join("\n")}\n`);
  runFfmpeg([
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-movflags", "+faststart", outputPath,
  ], "episode segment join");
}

function outputReceipt(path) {
  const stat = statSync(path);
  const probe = probeMedia(path);
  return {
    path,
    file: basename(path),
    bytes: stat.size,
    modified_ms: Math.round(stat.mtimeMs),
    duration_sec: probe.duration_sec,
    width: probe.video?.width || null,
    height: probe.video?.height || null,
    video_codec: probe.video?.codec_name || null,
    audio_codec: probe.audio?.codec_name || null,
    audio_sample_rate: Number(probe.audio?.sample_rate || 0),
    audio_channels: Number(probe.audio?.channels || 0),
  };
}

export function buildRenderedTimeline({ assembly, segments }) {
  let elapsedSec = 0;
  const sectionTimeline = (segments || []).map((segment) => {
    const startSec = elapsedSec;
    const endSec = startSec + Number(segment.duration_sec || 0);
    elapsedSec = endSec;
    return {
      type: segment.type,
      start_sec: startSec,
      end_sec: endSec,
    };
  });
  const program = sectionTimeline.find((section) => section.type === "program");
  const closing = sectionTimeline.find((section) => section.type === "closing");
  const programStartMs = Number(assembly?.program?.start_ms || 0);
  const cueTimeline = (assembly?.cta_graphic?.cues || []).map((cue) => ({
    cue_id: cue.id,
    cta_type: cue.cta_type === "newsletter" ? "newsletter" : "podcast_growth",
    start_sec: Number(program?.start_sec || 0) + Math.max(0, Number(cue.start_ms || 0) - programStartMs) / 1_000,
    end_sec: Number(program?.start_sec || 0) + Math.max(0, Number(cue.end_ms || 0) - programStartMs) / 1_000,
  }));
  if (closing && assembly?.cta_graphic?.show_during_closing) {
    cueTimeline.push({
      cue_id: "closing_cta",
      cta_type: "closing",
      start_sec: closing.start_sec,
      end_sec: closing.end_sec,
    });
  }
  const graphicTimeline = [
    ...(assembly?.program_graphics?.lower_thirds || []).map((cue) => ({ ...cue, type: "lower_third" })),
    ...(assembly?.program_graphics?.topic_bars || []).map((cue) => ({ ...cue, type: "topic_bar" })),
  ].map((cue) => ({
    cue_id: cue.id,
    type: cue.type,
    label: cue.type === "topic_bar" ? cue.title : `${cue.host_1_name} + ${cue.host_2_name}`,
    start_sec: Number(program?.start_sec || 0) + Math.max(0, Number(cue.start_ms || 0) - programStartMs) / 1_000,
    end_sec: Number(program?.start_sec || 0) + Math.max(0, Number(cue.end_ms || 0) - programStartMs) / 1_000,
  }));
  const closingAudioLeadMs = Number(assembly?.closing?.audio_lead_ms || 0);
  return {
    duration_sec: elapsedSec,
    sections: sectionTimeline,
    ctas: cueTimeline,
    graphics: graphicTimeline,
    closing_audio_lead: closing && closingAudioLeadMs > 0 ? {
      start_sec: Math.max(0, closing.start_sec - closingAudioLeadMs / 1_000),
      end_sec: closing.start_sec,
    } : null,
  };
}

// Bounded local excerpts use the production composition path but never write an
// episode/proxy/delivery receipt or grant a render/review approval.
export async function renderEpisodeRevisionSample({
  assembly, timeline, speakerActivity = null, cameraBalance = null,
  startMs, endMs, outputDir, openingTailSec = 0, includeClosing = false,
  openingGainDb = 0,
}) {
  const originalStart = Number(assembly.program.start_ms);
  const originalEnd = Number(assembly.program.end_ms);
  if (![startMs, endMs].every(Number.isFinite) || startMs < originalStart || endMs > originalEnd
    || endMs <= startMs || endMs - startMs > 60_000) throw new Error("revision samples need an in-program range of at most 60 seconds");
  if (!Number.isFinite(openingTailSec) || openingTailSec < 0 || openingTailSec > 10
    || (openingTailSec && startMs !== originalStart)) throw new Error("opening samples need the program start and at most ten opening seconds");
  if (includeClosing && endMs !== originalEnd) throw new Error("closing samples must end with the program");
  if (!Number.isFinite(openingGainDb) || openingGainDb < -30 || openingGainDb > 0) throw new Error("sample opening gain must be -30 to 0 dB");
  if (includeClosing && packageDuration(assembly.closing) > 60) throw new Error("closing sample package exceeds 60 seconds");
  // A fresh folder prevents overwriting any existing review evidence or output.
  mkdirSync(outputDir, { recursive: false });
  const profile = [WIDTH, HEIGHT, VIDEO_PRESET, VIDEO_CRF];
  WIDTH = 960; HEIGHT = 540; VIDEO_PRESET = "veryfast"; VIDEO_CRF = "25";
  try {
    const excerpt = structuredClone(assembly);
    excerpt.program = { ...excerpt.program, start_ms: startMs, end_ms: endMs, duration_ms: endMs - startMs,
      shots: excerpt.program.shots.filter((shot) => shot.end_ms > startMs && shot.start_ms < endMs)
        .map((shot, index) => ({ ...shot, start_ms: Math.max(startMs, shot.start_ms), end_ms: Math.min(endMs, shot.end_ms),
          transition_in: index === 0 ? { type: "cut", duration_ms: 0 } : shot.transition_in })) };
    if (startMs !== originalStart) excerpt.visual_style.program_fade_in_ms = 0;
    const inRange = (cue) => cue.end_ms > startMs && cue.start_ms < endMs;
    excerpt.program_graphics.lower_thirds = excerpt.program_graphics.lower_thirds.filter(inRange);
    excerpt.program_graphics.topic_bars = excerpt.program_graphics.topic_bars.filter(inRange);
    excerpt.cta_graphic.cues = excerpt.cta_graphic.cues.filter(inRange);
    const overlays = [];
    for (const [type, cues] of [["lower_third", excerpt.program_graphics.lower_thirds], ["topic_bar", excerpt.program_graphics.topic_bars]]) {
      for (const cue of cues) {
        const receipt = await renderProgramGraphicOverlay({ type, title: cue.title, hostOneName: cue.host_1_name,
          hostTwoName: cue.host_2_name, outputPath: join(outputDir, `${cue.id}.png`) });
        overlays.push({ cue, receipt });
      }
    }
    const podcastPath = join(outputDir, "podcast_cta.png");
    await renderCtaOverlay({ websiteLabel: assembly.cta_graphic.website_label,
      websiteUrlLabel: "", secondaryLabel: assembly.cta_graphic.visual_secondary_label || "SUBSCRIBE ON YOUTUBE", actions: assembly.cta_graphic.actions, outputPath: podcastPath });
    let newsletterPath = null;
    if (excerpt.cta_graphic.cues.some((cue) => cue.cta_type === "newsletter")) {
      newsletterPath = join(outputDir, "newsletter_cta.png");
      await renderCtaOverlay({ websiteLabel: assembly.newsletter_cta.website_label,
        websiteUrlLabel: assembly.newsletter_cta.display_url, actions: ["subscribe"], outputPath: newsletterPath });
    }
    const mainPath = join(outputDir, "program_raw.mp4");
    runFfmpeg(buildMainEdit({ assembly: excerpt, timeline, speakerActivity, cameraBalance, outputPath: mainPath }), "revision program excerpt");
    const graphicPath = join(outputDir, "program_graphics.mp4");
    applyProgramGraphics({ assembly: excerpt, inputPath: mainPath, overlays, outputPath: graphicPath });
    const ctaPath = join(outputDir, "program_cta.mp4");
    applyProgramCtas({ assembly: excerpt, inputPath: graphicPath, overlayPaths: { podcast: podcastPath, newsletter: newsletterPath }, outputPath: ctaPath });
    const programPath = join(outputDir, "program.mp4");
    applyClosingAudioLead({ section: includeClosing ? assembly.closing : { audio_lead_ms: 0 }, inputPath: ctaPath, outputPath: programPath });
    const paths = [];
    if (openingTailSec) {
      const rawPath = join(outputDir, "opening_raw.mp4");
      const openingPath = join(outputDir, "opening.mp4");
      renderPackage({ section: assembly.opening, outputPath: rawPath,
        trimStartSec: Math.max(0, packageDuration(assembly.opening) - Number(assembly.opening.trim_end_ms || 0) / 1_000 - openingTailSec) });
      runFfmpeg(["-i", rawPath, "-c:v", "copy", "-af", `volume=${openingGainDb}dB`, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", openingPath], "sample opening level");
      paths.push(openingPath);
    }
    paths.push(programPath);
    if (includeClosing) {
      const closingPath = join(outputDir, "closing.mp4");
      renderPackage({ section: assembly.closing, outputPath: closingPath,
        overlayPath: assembly.cta_graphic.show_during_closing ? podcastPath : null,
        trimStartSec: Number(assembly.closing.audio_lead_ms || 0) / 1_000 });
      paths.push(closingPath);
    }
    const path = join(outputDir, "sample.mp4");
    concatSegments(paths, path, join(outputDir, "segments.txt"));
    const receipt = { schema: "eaol-episode-revision-sample-v1", generated_at: new Date().toISOString(),
      assembly_fingerprint: assembly.plan_fingerprint, source_range_ms: [startMs, endMs], opening_tail_sec: openingTailSec,
      include_closing: includeClosing, opening_gain_db: openingGainDb, camera_balance: cameraBalance,
      output: outputReceipt(path), human_review: "pending", render_authorized: false, publication_authorized: false };
    writeFileSync(join(outputDir, "sample.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    [WIDTH, HEIGHT, VIDEO_PRESET, VIDEO_CRF] = profile;
  }
}

export async function renderApprovedEpisode(workDir, { generatedAt = new Date().toISOString(), quality = "full" } = {}) {
  if (!["full", "proxy"].includes(quality)) throw new Error("render quality must be full or proxy");
  const renderProfile = quality === "proxy" ? PROXY_RENDER_PROFILE : FULL_RENDER_PROFILE;
  WIDTH = renderProfile.width;
  HEIGHT = renderProfile.height;
  VIDEO_PRESET = quality === "proxy" ? "veryfast" : "medium";
  VIDEO_CRF = quality === "proxy" ? "25" : "18";
  const dir = resolve(workDir);
  const manifest = readJson(join(dir, "episode.json"));
  const syncReceipt = readJson(join(dir, "sync.json"));
  const syncReview = readJson(join(dir, "sync_review.json"));
  const timeline = readJson(join(dir, "timeline.json"));
  const previewReview = readJson(join(dir, "timeline_preview_review.json"));
  const assembly = readJson(join(dir, "episode_assembly.json"));
  const assemblyReview = readJson(join(dir, "episode_assembly_review.json"));
  const namingApproval = readJson(join(dir, "episode_naming_approval.json"));
  const ctaManifest = readJson(join(dir, "cta_graphic_manifest.json"));
  const channelPreflight = readJson(join(dir, "channel_preflight.json"));
  const speakerActivity = readJson(join(dir, "speaker_activity.json"));
  const cameraPlan = readJson(join(dir, "camera_decision_manifest.json"));
  const cameraPlanReview = readJson(join(dir, "camera_plan_review.json"));
  const episodeProxy = readJson(join(dir, "episode_proxy.json"));
  const episodeProxyAudit = readJson(join(dir, "episode_proxy_audit.json"));
  const episodeProxyReview = readJson(join(dir, "episode_proxy_review.json"));
  if (!manifest || !syncReceipt || !syncReview || !timeline || !previewReview || !assembly || !assemblyReview) {
    throw new Error("complete and approve the current episode assembly before rendering");
  }
  if (!sourceReceiptsAreCurrent(manifest.sources || [])
    || !timelineReceiptMatchesInputs(timeline, manifest, syncReceipt, syncReview)
    || !timelinePreviewMatchesInputs(previewReview, timeline, manifest)) {
    throw new Error("the source, alignment, or playback review changed; rebuild and approve the recipe before rendering");
  }
  const signatures = (manifest.sources || []).map(manifestSourceSignature);
  const showPackageState = loadShowPackageState(dirname(dir));
  const matchingCtaManifest = assembly.cta_graphic?.manifest_fingerprint ? ctaManifest : null;
  const automaticCameraDirection = assembly.camera_direction?.mode === "automatic_source_bound";
  if (quality === "proxy" && !automaticCameraDirection) {
    throw new Error("a camera-direction proxy requires the current automatic source-bound assembly");
  }
  if (quality === "full" && automaticCameraDirection
    && (episodeProxy?.assembly_fingerprint !== assembly.plan_fingerprint
      || episodeProxyReview?.status !== "approved"
      || episodeProxyReview.full_render_authorized !== true
      || !episodeProxyReviewMatches(episodeProxyReview, episodeProxy, episodeProxyAudit))) {
    throw new Error("approve the complete current proxy review before rendering the full episode");
  }
  let cameraPlanSamples = null;
  let cameraPlanReviewRequired = false;
  if (automaticCameraDirection) {
    if (!channelPreflightMatchesInputs(channelPreflight, manifest)
      || !speakerActivityMatchesInputs(speakerActivity, manifest, timeline, channelPreflight)
      || !cameraPlanMatchesInputs(cameraPlan, manifest, timeline, channelPreflight, speakerActivity)) {
      throw new Error("the channel, speaker-activity, or camera-plan receipt changed; rebuild the automatic direction");
    }
    cameraPlanReviewRequired = requiresRepresentativeCameraReview(assembly);
    if (cameraPlanReviewRequired) {
      cameraPlanSamples = buildCameraPlanSamples({ assembly, cameraPlan });
      if (cameraPlanReview?.status !== "approved"
        || !cameraPlanReviewMatchesInputs(cameraPlanReview, assembly, cameraPlan, cameraPlanSamples)
        || cameraPlanReview.proxy_authorized !== true
        || cameraPlanReview.full_render_authorized !== false) {
        throw new Error("approve the current switched camera samples before rendering a proxy");
      }
    }
  }
  if (!episodeAssemblyMatchesInputs(
    assembly,
    timeline,
    previewReview,
    signatures,
    matchingCtaManifest,
    automaticCameraDirection ? cameraPlan : null,
    showPackageState.approved ? showPackageState.show_package.fingerprint : null,
    namingApproval?.approval_fingerprint || null,
  )
    || !assemblyAssetsAreCurrent(assembly)) {
    throw new Error("the episode recipe or one of its selected assets is stale");
  }
  if (assemblyReview.status !== "approved" || !episodeAssemblyReviewMatchesPlan(assemblyReview, assembly)) {
    throw new Error("approve the current episode recipe before rendering");
  }

  const outputDir = join(dir, "episode");
  const tempDir = join(outputDir, ".rendering");
  mkdirSync(outputDir, { recursive: true });
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  const podcastOverlayPath = join(tempDir, "podcast_cta_overlay.png");
  const podcastOverlayReceipt = await renderCtaOverlay({
    eyebrow: "EXPLORE THE PODCAST",
    websiteLabel: assembly.cta_graphic.website_label,
    websiteUrlLabel: "",
    secondaryLabel: assembly.cta_graphic.visual_secondary_label || "SUBSCRIBE ON YOUTUBE",
    actions: assembly.cta_graphic.actions,
    outputPath: podcastOverlayPath,
  });
  const newsletterCueCount = assembly.cta_graphic.cues.filter((cue) => cue.cta_type === "newsletter").length;
  let newsletterOverlayPath = null;
  let newsletterOverlayReceipt = null;
  if (newsletterCueCount) {
    newsletterOverlayPath = join(tempDir, "newsletter_cta_overlay.png");
    newsletterOverlayReceipt = await renderCtaOverlay({
      eyebrow: "SUBSCRIBE TO THE NEWSLETTER",
      websiteLabel: assembly.newsletter_cta.website_label,
      websiteUrlLabel: assembly.newsletter_cta.display_url,
      actions: ["subscribe"],
      outputPath: newsletterOverlayPath,
    });
  }

  const mainPath = join(tempDir, "program.mp4");
  const programAudio = selectProgramAudio({ timeline, speakerActivity });
  const cameraBalance = buildCameraBalance({ assembly, timeline });
  runFfmpeg(buildMainEdit({ assembly, timeline, speakerActivity, cameraBalance, outputPath: mainPath }), "main camera edit");
  const programGraphicOverlays = [];
  if (assembly.program_graphics?.enabled) {
    for (const cue of assembly.program_graphics.lower_thirds || []) {
      const outputPath = join(tempDir, `${cue.id}.png`);
      const receipt = await renderProgramGraphicOverlay({
        type: "lower_third",
        hostOneName: cue.host_1_name,
        hostTwoName: cue.host_2_name,
        outputPath,
      });
      programGraphicOverlays.push({ cue, receipt });
    }
    for (const cue of assembly.program_graphics.topic_bars || []) {
      const outputPath = join(tempDir, `${cue.id}.png`);
      const receipt = await renderProgramGraphicOverlay({ type: "topic_bar", title: cue.title, outputPath });
      programGraphicOverlays.push({ cue, receipt });
    }
  }
  const programWithGraphicsPath = join(tempDir, "program_with_graphics.mp4");
  applyProgramGraphics({ assembly, inputPath: mainPath, overlays: programGraphicOverlays, outputPath: programWithGraphicsPath });
  const programWithCtaPath = join(tempDir, "program_with_cta.mp4");
  applyProgramCtas({
    assembly,
    inputPath: programWithGraphicsPath,
    overlayPaths: { podcast: podcastOverlayPath, newsletter: newsletterOverlayPath },
    outputPath: programWithCtaPath,
  });
  const programFinalPath = join(tempDir, "program_final.mp4");
  applyClosingAudioLead({ section: assembly.closing, inputPath: programWithCtaPath, outputPath: programFinalPath });

  const segments = [];
  const segmentReceipts = [];
  let audioBalance = null;
  if (assembly.opening?.enabled) {
    const rawPath = join(tempDir, "opening_unbalanced.mp4");
    const path = join(tempDir, "opening.mp4");
    const durationSec = renderPackage({ section: assembly.opening, outputPath: rawPath });
    audioBalance = balanceOpeningToProgram({
      openingPath: rawPath,
      programPath: programWithCtaPath,
      outputPath: path,
    });
    segments.push(path);
    segmentReceipts.push({ type: "opening", duration_sec: durationSec, duration_source: assembly.opening.duration_source });
  }
  segments.push(programFinalPath);
  segmentReceipts.push({ type: "program", duration_sec: Number(assembly.program.duration_ms) / 1_000 });
  if (assembly.closing?.enabled) {
    const path = join(tempDir, "closing.mp4");
    const durationSec = renderPackage({
      section: assembly.closing,
      outputPath: path,
      overlayPath: assembly.cta_graphic.show_during_closing ? podcastOverlayPath : null,
      trimStartSec: Number(assembly.closing.audio_lead_ms || 0) / 1_000,
    });
    segments.push(path);
    segmentReceipts.push({ type: "closing", duration_sec: durationSec, duration_source: assembly.closing.duration_source });
  }

  const outputPath = join(outputDir, quality === "proxy" ? "episode_proxy.mp4" : "episode_full.mp4");
  concatSegments(segments, outputPath, join(tempDir, "segments.txt"));
  const output = outputReceipt(outputPath);
  const renderedTimeline = buildRenderedTimeline({ assembly, segments: segmentReceipts });
  const expectedDuration = segmentReceipts.reduce((total, segment) => total + segment.duration_sec, 0);
  const durationDelta = Math.abs(output.duration_sec - expectedDuration);
  const checks = {
    dimensions: output.width === WIDTH && output.height === HEIGHT,
    video_codec: output.video_codec === "h264",
    audio_codec: output.audio_codec === "aac",
    audio: output.audio_sample_rate === 48_000 && output.audio_channels === 2,
    duration: durationDelta <= 1,
  };
  if (Object.values(checks).some((value) => !value)) {
    throw new Error(`render technical checks failed: ${JSON.stringify(checks)}`);
  }
  const receipt = {
    schema: quality === "proxy" ? "eaol-episode-proxy-v1" : "eaol-episode-render-v1",
    status: "complete",
    generated_at: generatedAt,
    source_slug: assembly.source_slug,
    assembly_fingerprint: assembly.plan_fingerprint,
    assembly_reviewed_at: assemblyReview.reviewed_at,
    quality,
    render_profile: renderProfile,
    camera_plan_fingerprint: automaticCameraDirection ? cameraPlan.fingerprint : null,
    camera_plan_review_required: automaticCameraDirection ? cameraPlanReviewRequired : false,
    camera_plan_reviewed_at: cameraPlanReviewRequired ? cameraPlanReview.reviewed_at : null,
    camera_plan_sample_set_fingerprint: cameraPlanReviewRequired ? cameraPlanSamples.fingerprint : null,
    input_signatures: signatures,
    segments: segmentReceipts,
    program_audio: {
      mode: programAudio.mode,
      source_ids: programAudio.tracks.map((track) => track.source_id),
      gate_threshold_dbfs: programAudio.gate_threshold_dbfs,
      automation: programAudio.automation,
      speaker_activity_fingerprint: programAudio.activity_fingerprint,
    },
    audio_balance: audioBalance,
    camera_balance: cameraBalance,
    cta: {
      website_url: assembly.cta_graphic.website_url,
      website_label: assembly.cta_graphic.website_label,
      actions: assembly.cta_graphic.actions,
      in_program_cue_count: assembly.cta_graphic.cues.length,
      closing_overlay: Boolean(assembly.closing?.enabled && assembly.cta_graphic.show_during_closing),
      podcast: {
        website_url: assembly.cta_graphic.website_url,
        website_label: assembly.cta_graphic.website_label,
        cue_count: assembly.cta_graphic.cues.filter((cue) => cue.cta_type !== "newsletter").length,
      },
      newsletter: {
        website_url: assembly.newsletter_cta.website_url,
        website_label: assembly.newsletter_cta.website_label,
        cue_count: newsletterCueCount,
      },
      timeline: renderedTimeline.ctas,
      generated_overlay: { width: podcastOverlayReceipt.width, height: podcastOverlayReceipt.height, bytes: podcastOverlayReceipt.bytes },
      newsletter_generated_overlay: newsletterOverlayReceipt
        ? { width: newsletterOverlayReceipt.width, height: newsletterOverlayReceipt.height, bytes: newsletterOverlayReceipt.bytes }
        : null,
    },
    visual_style: assembly.visual_style,
    program_graphics: {
      enabled: assembly.program_graphics?.enabled === true,
      cue_count: programGraphicOverlays.length,
      timeline: renderedTimeline.graphics,
      overlays: programGraphicOverlays.map(({ cue, receipt }) => ({
        cue_id: cue.id,
        type: receipt.type,
        width: receipt.width,
        height: receipt.height,
        bytes: receipt.bytes,
      })),
    },
    closing_audio_lead_ms: Number(assembly.closing?.audio_lead_ms || 0),
    timeline: renderedTimeline,
    platform_copy_file: "episode_platform_copy.json",
    output,
    checks,
    render_authorized: quality === "full",
    proxy_authorized: quality === "proxy",
    full_render_authorized: quality === "full",
    publication_authorized: false,
  };
  writeFileSync(join(dir, quality === "proxy" ? "episode_proxy.json" : "episode_render.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  rmSync(tempDir, { recursive: true, force: true });
  return receipt;
}

function parseRunArg(argv) {
  const index = argv.indexOf("--run");
  return index >= 0 ? argv[index + 1] : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const argv = process.argv.slice(2);
  const workDir = parseRunArg(argv);
  const quality = argv.includes("--proxy") ? "proxy" : "full";
  if (!workDir) {
    console.error("usage: node studio/episode_renderer.mjs --run work/<episode> [--proxy]");
    process.exit(1);
  }
  renderApprovedEpisode(workDir, { quality })
    .then((receipt) => console.log(`Episode ${quality} render complete: ${receipt.output.path}`))
    .catch((error) => {
      console.error(`FATAL: ${error.message}`);
      process.exit(1);
    });
}
