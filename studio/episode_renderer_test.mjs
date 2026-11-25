#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveTool } from "../platform_tools.mjs";
import { manifestSourceSignature } from "./sync.mjs";
import { buildTimeline } from "./timeline.mjs";
import { buildTimelinePreviewReview } from "./timeline_preview.mjs";
import { buildEpisodeAssembly, buildEpisodeAssemblyReview, episodePlatformCopy } from "./episode_assembly.mjs";
import {
  FULL_RENDER_PROFILE,
  PROXY_RENDER_PROFILE,
  buildMainEdit,
  buildRenderedTimeline,
  normalizedVideoSegmentArgs,
  renderApprovedEpisode,
  renderEpisodeRevisionSample,
  selectProgramAudio,
  speakerActivityGainExpression,
  suggestCameraBalance,
  videoLoudnessAnalysisArgs,
} from "./episode_renderer.mjs";
import { buildCameraPlan } from "./camera_plan.mjs";
import { buildCameraPlanReview, buildCameraPlanSamples } from "./camera_plan_review.mjs";
import { buildShowPackage, buildShowPackageReview, showPackagePaths } from "./show_package.mjs";
import { renderShowPackagePreview } from "./show_package_preview.mjs";
import { buildEpisodeProxyReview } from "./episode_proxy_review.mjs";

const ffmpeg = resolveTool("ffmpeg");
const root = mkdtempSync(join(tmpdir(), "eaol-episode-render-test-"));
const workDir = join(root, "work", "demo");
mkdirSync(workDir, { recursive: true });

const renderedTimelineProof = buildRenderedTimeline({
  assembly: {
    program: { start_ms: 45_512 },
    closing: { audio_lead_ms: 8_000 },
    cta_graphic: {
      show_during_closing: true,
      cues: [{ id: "newsletter", cta_type: "newsletter", start_ms: 2_375_340, end_ms: 2_383_340 }],
    },
    program_graphics: {
      lower_thirds: [{ id: "lower_1", start_ms: 49_512, end_ms: 55_512, host_1_name: "Host One", host_2_name: "Host Two" }],
      topic_bars: [{ id: "topic_1", start_ms: 2_381_340, end_ms: 2_387_340, title: "A Sample Closing Topic" }],
    },
  },
  segments: [
    { type: "opening", duration_sec: 38.705333 },
    { type: "program", duration_sec: 2_451.478 },
    { type: "closing", duration_sec: 24.858167 },
  ],
});
assert.equal(renderedTimelineProof.ctas[0].cue_id, "newsletter");
assert.equal(renderedTimelineProof.ctas[0].cta_type, "newsletter");
assert.ok(Math.abs(renderedTimelineProof.ctas[0].start_sec - 2_368.533333) < 0.000001);
assert.ok(Math.abs((renderedTimelineProof.ctas[0].end_sec - renderedTimelineProof.ctas[0].start_sec) - 8) < 0.000001);
assert.equal(renderedTimelineProof.ctas[1].cta_type, "closing");
assert.ok(Math.abs(renderedTimelineProof.ctas[1].start_sec - 2_490.183333) < 0.000001);
assert.equal(renderedTimelineProof.graphics[0].type, "lower_third");
assert.ok(Math.abs(renderedTimelineProof.graphics[0].start_sec - 42.705333) < 0.000001);
assert.equal(renderedTimelineProof.graphics[1].label, "A Sample Closing Topic");
assert.ok(Math.abs(renderedTimelineProof.closing_audio_lead.start_sec - 2_482.183333) < 0.000001);

function run(args) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-y", "-v", "error", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function writeJson(name, value) {
  writeFileSync(join(workDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function receipt(id, label, path, expectedKind = "video") {
  const stat = statSync(path);
  return {
    id,
    label,
    expected_kind: expectedKind,
    path,
    file: path.split(/[\\/]/).at(-1),
    bytes: stat.size,
    modified_ms: Math.round(stat.mtimeMs),
    duration_sec: 12,
    video: expectedKind === "video" ? { codec: "h264", width: 640, height: 360, fps: 30, rotation_degrees: 0 } : null,
    audio: { codec: expectedKind === "video" ? "aac" : "pcm_s16le", sample_rate: 48000, channels: expectedKind === "video" ? 2 : 1 },
  };
}

function asset(path, kind) {
  const stat = statSync(path);
  return { path, kind, bytes: stat.size, modified_ms: Math.round(stat.mtimeMs) };
}

try {
  assert.match(videoLoudnessAnalysisArgs("opening.mp4", -24).join(" "), /loudnorm=I=-24:LRA=11:TP=-1/);
  const normalizationArgs = normalizedVideoSegmentArgs({
    inputPath: "opening.mp4",
    outputPath: "opening-balanced.mp4",
    targetIntegratedLufs: -24,
    measurement: {
      input_i: -16,
      input_tp: -0.1,
      input_lra: 4,
      input_thresh: -26,
      target_offset: 0,
    },
  }).join(" ");
  assert.match(normalizationArgs, /-c:v copy/);
  assert.match(normalizationArgs, /measured_I=-16/);
  assert.match(normalizationArgs, /TP=-1/);
  console.log("PASS video segment loudness matching uses measured two-pass normalization while copying approved pictures");

  const suggestedBalance = suggestCameraBalance({ primary_camera: 26, secondary_camera: 90 });
  assert.ok(suggestedBalance.mismatch_ratio > 3);
  assert.ok(suggestedBalance.adjustments.primary_camera.brightness > 0);
  assert.ok(suggestedBalance.adjustments.primary_camera.gamma > 1);
  assert.ok(suggestedBalance.adjustments.secondary_camera.brightness < 0);
  assert.ok(suggestedBalance.adjustments.secondary_camera.gamma < 1);
  console.log("PASS camera balance detects a material exposure mismatch and proposes bounded corrections");

  // A CTA-bearing program must be long enough for the ten-second full-opacity hold.
  const primaryPath = join(root, "primary.mp4");
  const secondaryPath = join(root, "secondary.mp4");
  const graphicPath = join(root, "graphic.mp4");
  const introPath = join(root, "intro.wav");
  const outroPath = join(root, "outro.wav");
  const hostOneAudioPath = join(root, "host-one.wav");
  const hostTwoAudioPath = join(root, "host-two.wav");
  run(["-f", "lavfi", "-i", "color=c=#2c353c:s=640x360:r=30:d=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", primaryPath]);
  run(["-f", "lavfi", "-i", "color=c=#8abfc5:s=640x360:r=30:d=12", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=12", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", secondaryPath]);
  run(["-f", "lavfi", "-i", "color=c=#2c353c:s=1920x1080:r=30:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", graphicPath]);
  run(["-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000:duration=1.2", "-ac", "2", introPath]);
  run(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=1.3", "-ac", "2", outroPath]);
  run(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12", "-ac", "1", hostOneAudioPath]);
  run(["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=12", "-ac", "1", hostTwoAudioPath]);

  const showPackage = buildShowPackage({
    generatedAt: "2026-08-22T19:58:00.000Z",
    draft: {
      opening: { narration_mode: "evergreen", visual: asset(graphicPath, "video"), voiceover: asset(introPath, "audio") },
      closing: { narration_mode: "evergreen", visual: asset(graphicPath, "video"), voiceover: asset(outroPath, "audio") },
      cta_graphic: {
        website_url: "https://example.com/podcast",
        website_label: "Explore AI Out Loud",
        actions: ["like", "comment", "subscribe"],
        show_during_closing: true,
      },
      visual_style: {
        side_by_side_divider: { enabled: true, width_full_px: 4, color: "#23333a" },
      },
    },
  });
  const showPackageReview = buildShowPackageReview({
    showPackage,
    status: "approved",
    reviewedAt: "2026-08-22T19:59:00.000Z",
  });
  const showPaths = showPackagePaths(join(root, "work"));
  mkdirSync(showPaths.dir, { recursive: true });
  writeFileSync(showPaths.package, `${JSON.stringify(showPackage, null, 2)}\n`);
  writeFileSync(showPaths.review, `${JSON.stringify(showPackageReview, null, 2)}\n`);
  const openingPreview = await renderShowPackagePreview({ workRoot: join(root, "work"), sectionName: "opening" });
  const closingPreview = await renderShowPackagePreview({ workRoot: join(root, "work"), sectionName: "closing" });
  assert.equal(openingPreview.output.width, 1920);
  assert.equal(closingPreview.output.height, 1080);
  assert.equal(closingPreview.checks.audio, true);
  assert.equal(closingPreview.publication_authorized, false);
  console.log("PASS reusable opening and closing previews render independently with technical receipts");

  const sources = [
    receipt("primary_camera", "Host 1 camera", primaryPath),
    receipt("secondary_camera", "Host 2 camera", secondaryPath),
    receipt("host_1_audio", "Host 1 isolated audio", hostOneAudioPath, "audio"),
    receipt("host_2_audio", "Host 2 isolated audio", hostTwoAudioPath, "audio"),
  ];
  const signatures = sources.map(manifestSourceSignature);
  const manifest = { schema: "eaol-episode-v1", slug: "demo", sources };
  const syncReceipt = {
    schema: "eaol-sync-v1",
    status: "review_required",
    analyzed_at: "2026-08-22T20:00:00.000Z",
    reference_source_id: "primary_camera",
    input_signatures: signatures,
    results: sources.slice(1).map((source) => ({ source_id: source.id, label: source.label, status: "measured", start_offset_ms: 0, end_offset_ms: 0 })),
  };
  const syncReview = {
    status: "approved",
    reviewed_at: "2026-08-22T20:01:00.000Z",
    input_signatures: signatures,
  };
  const timeline = buildTimeline({ manifest, syncReceipt, syncReview, generatedAt: "2026-08-22T20:02:00.000Z" });
  const preview = buildTimelinePreviewReview({
    timeline,
    manifest,
    status: "approved",
    checkedStart: true,
    checkedEnd: true,
    reviewedAt: "2026-08-22T20:03:00.000Z",
  });
  const ctaManifest = {
    transcript_fingerprint: "transcript-a",
    cue_review_updated_at: "2026-08-22T20:03:30.000Z",
    cues: [{
      id: "cta_1",
      actions: ["like", "comment", "subscribe"],
      transcript_segment_start: "00:00:01.000",
      transcript_segment_end: "00:00:02.000",
      matched_text: "Like, comment, and subscribe.",
    }],
  };
  const assembly = buildEpisodeAssembly({
    slug: "demo",
    timeline,
    timelinePreviewReview: preview,
    inputSignatures: signatures,
    ctaGraphicManifest: ctaManifest,
    generatedAt: "2026-08-22T20:04:00.000Z",
    draft: {
      title: "Renderer test",
      program_start: 0,
      program_end: 12_000,
      shots: [
        { start_ms: 0, end_ms: 1_500, layout: "side_by_side", transition_in: { type: "cut" } },
        { start_ms: 1_500, end_ms: 2_750, layout: "isolated", camera_source_id: "primary_camera", transition_in: { type: "dissolve", duration_ms: 250 } },
        { start_ms: 2_750, end_ms: 12_000, layout: "isolated", camera_source_id: "secondary_camera", transition_in: { type: "dissolve", duration_ms: 250 } },
      ],
      opening: { visual: asset(graphicPath, "video"), voiceover: asset(introPath, "audio") },
      closing: { visual: asset(graphicPath, "video"), voiceover: asset(outroPath, "audio"), audio_lead_ms: 500 },
      cta_graphic: {
        website_url: "https://example.com/podcast",
        website_label: "Explore AI Out Loud",
        actions: ["like", "comment", "subscribe"],
        show_during_closing: true,
      },
      visual_style: {
        side_by_side_divider: { enabled: true, width_full_px: 4, color: "#23333a" },
      },
    },
  });
  const assemblyReview = buildEpisodeAssemblyReview({
    assembly,
    status: "approved",
    reviewedAt: "2026-08-22T20:05:00.000Z",
  });
  const isolatedAudio = selectProgramAudio({
    timeline,
    speakerActivity: {
      fingerprint: "speaker-activity-test",
      noise_floor_dbfs: { host_1: -64, host_2: -61 },
      segments: [
        { start_ms: 0, end_ms: 2_000, state: "host_1", left_dbfs: -25, right_dbfs: -44 },
        { start_ms: 2_000, end_ms: 3_000, state: "both", left_dbfs: -30, right_dbfs: -31 },
        { start_ms: 3_000, end_ms: 12_000, state: "host_2", left_dbfs: -46, right_dbfs: -29 },
      ],
    },
  });
  assert.equal(isolatedAudio.mode, "aligned_isolated_transmitter_automix");
  assert.equal(isolatedAudio.automation, "speaker_activity_dominance_v1");
  const quietHostTwoExpression = speakerActivityGainExpression({
    speakerActivity: { segments: [{ start_ms: 0, end_ms: 1_000, state: "host_1" }] },
    role: "host_2",
    programStartMs: 0,
    programEndMs: 1_000,
  });
  assert.match(quietHostTwoExpression, /-0\.070000\*between/);
  assert.doesNotMatch(quietHostTwoExpression, /\+\-/);
  const largeActivityExpression = speakerActivityGainExpression({
    speakerActivity: {
      segments: Array.from({ length: 109 }, (_, index) => ({
        start_ms: index * 1_000,
        end_ms: (index + 1) * 1_000,
        state: index % 2 === 0 ? "host_1" : "both",
      })),
    },
    role: "host_1",
    programStartMs: 0,
    programEndMs: 109_000,
  });
  assert.equal((largeActivityExpression.match(/between\(/g) || []).length, 109);
  assert.doesNotMatch(largeActivityExpression, /\+\-/);
  run([
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-t", "0.01",
    "-af", `volume=${largeActivityExpression}:eval=frame`,
    "-f", "null", "-",
  ]);
  console.log("PASS balanced speaker automation remains parseable beyond FFmpeg's linear expression-depth limit");
  const mainEditArgs = buildMainEdit({
    assembly,
    timeline,
    speakerActivity: {
      fingerprint: "speaker-activity-test",
      noise_floor_dbfs: { host_1: -64, host_2: -61 },
      segments: [
        { start_ms: 0, end_ms: 2_000, state: "host_1", left_dbfs: -25, right_dbfs: -44 },
        { start_ms: 2_000, end_ms: 3_000, state: "both", left_dbfs: -30, right_dbfs: -31 },
        { start_ms: 3_000, end_ms: 12_000, state: "host_2", left_dbfs: -46, right_dbfs: -29 },
      ],
    },
    outputPath: join(root, "unused.mp4"),
  });
  assert.match(mainEditArgs.join(" "), /agate=threshold=/);
  assert.match(mainEditArgs.join(" "), /amix=inputs=2/);
  assert.match(mainEditArgs.join(" "), /volume=\(\(0\.12\+/);
  assert.match(mainEditArgs.join(" "), /trim=end_frame=53,setpts=PTS-STARTPTS/);
  assert.match(mainEditArgs.join(" "), /trim=end_frame=46,setpts=PTS-STARTPTS/);
  assert.match(mainEditArgs.join(" "), /trim=end_frame=277,setpts=PTS-STARTPTS/);
  assert.match(mainEditArgs.join(" "), /-ss 0\.000000 -t/);
  assert.match(mainEditArgs.slice(-6).join(" "), /-t 12\.000000 -movflags \+faststart/);
  console.log("PASS aligned mono transmitter masters replace camera audio with a gated two-host program mix");
  console.log("PASS every camera and audio input uses bounded source seeking instead of decoding from file start");
  console.log("PASS camera-shot boundaries share one global 30fps grid so cut rounding cannot accumulate against continuous audio");
  writeJson("episode.json", manifest);
  writeJson("sync.json", syncReceipt);
  writeJson("sync_review.json", syncReview);
  writeJson("timeline.json", timeline);
  writeJson("timeline_preview_review.json", preview);
  writeJson("cta_graphic_manifest.json", ctaManifest);
  writeJson("episode_assembly.json", assembly);
  writeJson("episode_assembly_review.json", assemblyReview);
  writeJson("episode_platform_copy.json", episodePlatformCopy(assembly));

  const render = await renderApprovedEpisode(workDir, { generatedAt: "2026-08-22T20:06:00.000Z" });
  assert.equal(render.status, "complete");
  assert.equal(render.output.width, 3840);
  assert.equal(render.output.height, 2160);
  assert.deepEqual(render.render_profile, FULL_RENDER_PROFILE);
  assert.equal(render.output.video_codec, "h264");
  assert.equal(render.output.audio_codec, "aac");
  assert.equal(render.cta.in_program_cue_count, 1);
  assert.equal(render.cta.closing_overlay, true);
  assert.equal(render.audio_balance.mode, "opening_matched_to_program_v1");
  assert.equal(render.audio_balance.reference_section, "program");
  assert.equal(render.audio_balance.checks.opening_matches_program, true);
  assert.equal(render.audio_balance.checks.opening_true_peak, true);
  assert.ok(Math.abs(render.audio_balance.opening_output.integrated_lufs - render.audio_balance.program.integrated_lufs) <= 1);
  assert.ok(render.audio_balance.opening_output.true_peak_dbtp <= -1);
  assert.equal(render.publication_authorized, false);
  assert.ok(render.output.duration_sec > 14 && render.output.duration_sec < 15.5);
  console.log("PASS approved episode renders side-by-side and isolated views, dissolves, narration-timed packages, and CTA overlays");
  console.log("PASS full-episode render writes technical checks and keeps publication separately unauthorized");

  const channelPreflight = {
    schema: "eaol-channel-preflight-v1",
    status: "passed",
    source_id: "primary_camera",
    source_signature: manifestSourceSignature(sources[0]),
    fingerprint: "channel-preflight-a",
  };
  const speakerActivity = {
    schema: "eaol-speaker-activity-v1",
    status: "complete",
    timeline_generated_at: timeline.generated_at,
    channel_preflight_fingerprint: channelPreflight.fingerprint,
    input_signatures: signatures,
    fingerprint: "speaker-activity-a",
    segments: [
      { id: "activity_0001", start_ms: 0, end_ms: 1_800, state: "host_1", confidence: 0.98 },
      { id: "activity_0002", start_ms: 1_800, end_ms: 2_300, state: "both", confidence: 0.95 },
      { id: "activity_0003", start_ms: 2_300, end_ms: 12_000, state: "host_2", confidence: 0.97 },
    ],
  };
  const cameraPlan = buildCameraPlan({
    manifest,
    timeline,
    channelPreflight,
    speakerActivity,
    generatedAt: "2026-08-22T20:07:00.000Z",
  });
  const automaticAssembly = buildEpisodeAssembly({
    slug: "demo",
    timeline,
    timelinePreviewReview: preview,
    inputSignatures: signatures,
    ctaGraphicManifest: ctaManifest,
    cameraPlan,
    generatedAt: "2026-08-22T20:08:00.000Z",
    draft: {
      title: "Automatic renderer proxy test",
      naming: {
        episode_number: 1,
        production_id: "ep001",
        approval_fingerprint: "episode-naming-a",
        approved_at: "2026-08-22T20:07:30.000Z",
        approved_by: "Host 1",
        platform_titles: {
          podcast_rss: "Automatic renderer proxy test",
          youtube: "Automatic renderer proxy test | Ep. 1",
          website: "Episode 1: Automatic renderer proxy test",
        },
      },
      program_start: 0,
      program_end: 12_000,
      apply_camera_plan: true,
      camera_plan_fingerprint: cameraPlan.fingerprint,
      opening: { visual: asset(graphicPath, "video"), voiceover: asset(introPath, "audio"), trim_end_ms: 200 },
      closing: { visual: asset(graphicPath, "video"), voiceover: asset(outroPath, "audio"), audio_lead_ms: 500, audio_gain_db: -4 },
      cta_graphic: {
        website_url: "https://example.com/podcast",
        website_label: "Explore AI Out Loud",
        actions: ["like", "comment", "subscribe"],
        show_during_closing: true,
      },
      visual_style: {
        program_fade_in_ms: 450,
        side_by_side_divider: {
          enabled: true,
          width_full_px: 8,
          color: "#23333a",
        },
        camera_balance: { enabled: true },
        camera_framing: {
          enabled: true,
          sources: {
            primary_camera: { zoom: 1.08, vertical: 0, temperature: 0.2 },
            secondary_camera: { zoom: 1.12, vertical: 15, temperature: -0.15 },
          },
        },
      },
      program_graphics: {
        enabled: true,
        lower_thirds: [{ start_ms: 500, duration_ms: 2_000, host_1_name: "Host One", host_2_name: "Host Two" }],
        topic_bars: [{ start_ms: 2_500, duration_ms: 30_000, title: "A reviewed topic", position: "bottom" }],
      },
    },
  });
  const automaticAssemblyReview = buildEpisodeAssemblyReview({
    assembly: automaticAssembly,
    status: "approved",
    reviewedAt: "2026-08-22T20:09:00.000Z",
  });
  const samples = buildCameraPlanSamples({ assembly: automaticAssembly, cameraPlan });
  const cameraReview = buildCameraPlanReview({
    assembly: automaticAssembly,
    cameraPlan,
    sampleSet: samples,
    status: "approved",
    checks: Object.fromEntries(samples.samples.map((sample) => [sample.id, true])),
    previewedSampleIds: samples.samples.filter((sample) => sample.available).map((sample) => sample.id),
    reviewedAt: "2026-08-22T20:10:00.000Z",
  });
  writeJson("channel_preflight.json", channelPreflight);
  writeJson("speaker_activity.json", speakerActivity);
  writeJson("camera_decision_manifest.json", cameraPlan);
  writeJson("episode_naming_approval.json", { approval_fingerprint: "episode-naming-a" });
  writeJson("episode_assembly.json", automaticAssembly);
  writeJson("episode_assembly_review.json", automaticAssemblyReview);
  writeJson("camera_plan_review.json", cameraReview);
  await assert.rejects(
    renderApprovedEpisode(workDir, { generatedAt: "2026-08-22T20:11:00.000Z" }),
    /approve the complete current proxy review/,
  );
  const proxy = await renderApprovedEpisode(workDir, { generatedAt: "2026-08-22T20:12:00.000Z", quality: "proxy" });
  assert.equal(proxy.schema, "eaol-episode-proxy-v1");
  assert.equal(proxy.camera_plan_review_required, false);
  assert.equal(proxy.output.width, 960);
  assert.equal(proxy.output.height, 540);
  assert.deepEqual(proxy.render_profile, PROXY_RENDER_PROFILE);
  assert.equal(proxy.camera_plan_fingerprint, cameraPlan.fingerprint);
  assert.equal(proxy.proxy_authorized, true);
  assert.equal(proxy.full_render_authorized, false);
  assert.equal(proxy.visual_style.side_by_side_divider.enabled, true);
  assert.equal(proxy.visual_style.side_by_side_divider.width_full_px, 8);
  assert.equal(proxy.program_graphics.cue_count, 2);
  assert.equal(proxy.closing_audio_lead_ms, 500);
  assert.equal(proxy.visual_style.program_fade_in_ms, 450);
  assert.equal(automaticAssembly.program_graphics.topic_bars[0].position, "bottom");
  const sampleDir = join(root, "revision-sample");
  const sample = await renderEpisodeRevisionSample({ assembly: automaticAssembly, timeline, speakerActivity,
    startMs: 0, endMs: 12_000, outputDir: sampleDir, includeClosing: true });
  assert.equal(sample.output.width, 960);
  assert.equal(sample.human_review, "pending");
  assert.equal(sample.render_authorized, false);
  await assert.rejects(renderEpisodeRevisionSample({ assembly: automaticAssembly, timeline, startMs: 0, endMs: 61_000, outputDir: join(root, "too-long") }), /at most 60/);
  await assert.rejects(renderEpisodeRevisionSample({ assembly: automaticAssembly, timeline, startMs: 0, endMs: 12_000, outputDir: sampleDir }), /EEXIST/);
  assert.deepEqual(proxy.timeline.sections.map((section) => section.type), ["opening", "program", "closing"]);
  assert.equal(proxy.cta.timeline.length, 2);
  assert.equal(proxy.cta.timeline[0].cta_type, "podcast_growth");
  assert.ok(proxy.cta.timeline[0].end_sec > proxy.cta.timeline[0].start_sec);
  assert.equal(proxy.cta.timeline[1].cta_type, "closing");
  assert.equal(proxy.cta.timeline[1].start_sec, proxy.timeline.sections[2].start_sec);
  const proxyReview = buildEpisodeProxyReview({
    proxy,
    status: "approved",
    checks: {
      complete_watch: true,
      opening: true,
      program_sync: true,
      cta: true,
      closing: true,
      divider: true,
      camera_balance: true,
    },
    reviewedAt: "2026-08-22T20:13:00.000Z",
  });
  writeJson("episode_proxy_review.json", proxyReview);
  const olderProxy = { ...proxy, assembly_fingerprint: "older-approved-recipe" };
  const olderProxyReview = buildEpisodeProxyReview({
    proxy: olderProxy, status: "approved", checks: proxyReview.checks,
    reviewedAt: "2026-08-22T20:13:30.000Z",
  });
  writeJson("episode_proxy.json", olderProxy);
  writeJson("episode_proxy_review.json", olderProxyReview);
  await assert.rejects(renderApprovedEpisode(workDir), /approve the complete current proxy review/);
  writeJson("episode_proxy.json", proxy);
  writeJson("episode_proxy_review.json", proxyReview);
  const automaticFull = await renderApprovedEpisode(workDir, { generatedAt: "2026-08-22T20:14:00.000Z" });
  assert.equal(automaticFull.schema, "eaol-episode-render-v1");
  assert.equal(automaticFull.output.width, 3840);
  assert.equal(automaticFull.output.height, 2160);
  assert.deepEqual(automaticFull.render_profile, FULL_RENDER_PROFILE);
  assert.equal(automaticFull.full_render_authorized, true);
  assert.equal(automaticFull.publication_authorized, false);
  console.log("PASS source-bound proxy review binds opening, CTA, closing, divider, and complete watch before full rendering");
  console.log("PASS approved proxy unlocks only the full local render and keeps publication unauthorized");
  console.log("PASS a valid approved proxy from an older recipe cannot unlock a new recipe through the renderer CLI");
} finally {
  rmSync(root, { recursive: true, force: true });
}
