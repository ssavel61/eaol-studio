#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentCtaCues,
  buildEpisodeAssembly,
  buildEpisodeAssemblyReview,
  episodePlatformCopy,
  episodeAssemblyMatchesInputs,
  episodeAssemblyReviewMatchesPlan,
} from "./episode_assembly.mjs";

const root = mkdtempSync(join(tmpdir(), "eaol-assembly-test-"));
const visualPath = join(root, "open.mp4");
const musicPath = join(root, "theme.wav");
const voiceoverPath = join(root, "intro.wav");
writeFileSync(visualPath, "visual");
writeFileSync(musicPath, "music");
writeFileSync(voiceoverPath, "voice");

function asset(path, kind) {
  const stat = statSync(path);
  return { path, kind, bytes: stat.size, modified_ms: Math.round(stat.mtimeMs) };
}

const signatures = ["primary:10:1", "secondary:10:1"];
const timeline = {
  generated_at: "2026-08-22T20:00:00.000Z",
  reference_duration_ms: 120_000,
  input_signatures: signatures,
  tracks: [
    { source_id: "primary_camera", label: "Host 1 camera", media_kind: "video", timeline_start_ms: 0, timeline_end_ms: 120_000 },
    { source_id: "secondary_camera", label: "Host 2 camera", media_kind: "video", timeline_start_ms: 0, timeline_end_ms: 120_000 },
  ],
};
const preview = { status: "approved", reviewed_at: "2026-08-22T20:05:00.000Z" };
const cta = {
  transcript_fingerprint: "transcript-a",
  cue_review_updated_at: "2026-08-22T20:04:00.000Z",
  cues: [{
    id: "cta_1",
    actions: ["like", "subscribe"],
    transcript_segment_start: "00:01:00.000",
    transcript_segment_end: "00:01:05.000",
    matched_text: "Like and subscribe.",
  }],
};
const cameraPlan = {
  fingerprint: "camera-plan-a",
  generated_at: "2026-08-22T20:06:00.000Z",
  policy: { reaction_shots: "disabled" },
  shots: [
    { id: "plan_1", start_ms: 0, end_ms: 60_000, layout: "side_by_side", camera_source_ids: ["primary_camera", "secondary_camera"], reason_code: "overlap_requires_two_shot", activity_ids: ["activity_1"], confidence: 0.8 },
    { id: "plan_2", start_ms: 60_000, end_ms: 120_000, layout: "isolated", camera_source_id: "secondary_camera", reason_code: "confirmed_host_2_sustained", activity_ids: ["activity_2"], confidence: 0.92 },
  ],
};

try {
  const assembly = buildEpisodeAssembly({
    slug: "demo_episode",
    timeline,
    timelinePreviewReview: preview,
    inputSignatures: signatures,
    ctaGraphicManifest: cta,
    generatedAt: "2026-08-22T20:10:00.000Z",
    draft: {
      title: "Demo episode",
      program_start: "00:00:10.000",
      program_end: "00:01:50.000",
      shots: [
        { start: "00:00:10.000", end: "00:01:00.000", layout: "side_by_side", transition_in: { type: "cut" } },
        { start: "00:01:00.000", end: "00:01:50.000", layout: "isolated", camera_source_id: "secondary_camera", transition_in: { type: "dissolve", duration_ms: 350 } },
      ],
      opening: {
        visual: asset(visualPath, "video"),
        voiceover: asset(voiceoverPath, "audio"),
        music: asset(musicPath, "audio"),
      },
      closing: { visual: asset(visualPath, "video"), audio_lead_ms: 8_000 },
      cta_graphic: {
        website_url: "https://example.com/podcast",
        website_label: "Explore AI Out Loud",
        actions: ["like", "comment", "subscribe"],
      },
      visual_style: {
        side_by_side_divider: { enabled: true, width_full_px: 8, color: "#23333a" },
        camera_balance: { enabled: true },
        camera_framing: {
          enabled: true,
          sources: {
            primary_camera: { zoom: 1.08, vertical: 0, temperature: 0.25 },
            secondary_camera: { zoom: 1.12, vertical: 15, temperature: -0.15 },
          },
        },
      },
      program_graphics: {
        enabled: true,
        lower_thirds: [{ start: "00:00:15.000", host_1_name: "Host One", host_2_name: "Host Two" }],
        topic_bars: [{ start: "00:01:00.000", title: "A reviewed topic" }],
      },
    },
  });
  assert.equal(assembly.program.shots.length, 2);
  assert.equal(assembly.program.shots[0].layout, "side_by_side");
  assert.deepEqual(assembly.program.shots[0].camera_source_ids, ["primary_camera", "secondary_camera"]);
  assert.equal(assembly.program.shots[1].layout, "isolated");
  assert.equal(assembly.program.shots[1].transition_in.type, "dissolve");
  assert.equal(assembly.opening.duration_source, "voiceover");
  assert.equal(assembly.opening.audio_behavior, "recorded voiceover with lowered background music");
  assert.equal(assembly.closing.audio_lead_ms, 8_000);
  assert.equal(assembly.cta_graphic.cues.length, 1);
  assert.equal(assembly.cta_graphic.cues[0].spoken_start_ms, 60_000);
  assert.equal(assembly.cta_graphic.cues[0].spoken_end_ms, 65_000);
  assert.equal(assembly.cta_graphic.cues[0].start_ms, 59_750);
  assert.equal(assembly.cta_graphic.cues[0].end_ms, 69_750);
  assert.equal(assembly.cta_graphic.cues[0].display_duration_ms, 10_000);
  const tailCue={cues:[{...cta.cues[0],transcript_segment_start:'00:00:18.000',transcript_segment_end:'00:00:19.000'}]};
  const tail=currentCtaCues(tailCue,0,20_000)[0];
  assert.equal(tail.start_ms,10_000);assert.equal(tail.end_ms,20_000,'Shift earlier at the tail, preserving ten seconds');
  assert.throws(()=>currentCtaCues(tailCue,15_000,20_000),/ten seconds at full opacity/,'Never silently shorten a CTA to fit');
  assert.equal(assembly.cta_graphic.website_url, "https://example.com/podcast");
  assert.equal(assembly.cta_graphic.visual_destination, "youtube");
  assert.equal(assembly.cta_graphic.visual_secondary_label, "SUBSCRIBE ON YOUTUBE");
  assert.match(assembly.warnings.join(" "), /no custom podcast CTA asset/i);
  assert.equal(assembly.newsletter_cta.website_url, null);
  assert.equal(assembly.output.width, 3840);
  assert.equal(assembly.output.height, 2160);
  assert.equal(assembly.visual_style.side_by_side_divider.width_full_px, 8);
  assert.equal(assembly.visual_style.camera_framing.sources.secondary_camera.vertical, 15);
  assert.equal(assembly.program_graphics.cue_count, 2);
  assert.equal(assembly.render_authorized, false);
  assert.equal(episodeAssemblyMatchesInputs(assembly, timeline, preview, signatures, cta), true);
  console.log("PASS assembly binds the complete camera plan and optional show assets to current receipts");
  console.log("PASS spoken CTA cues trigger a concise context-bound display window");

  const platformCopy = episodePlatformCopy(assembly);
  assert.match(platformCopy.youtube.description_lines[0], /https:\/\/example\.com\/podcast/);
  assert.match(platformCopy.spotify.show_notes_html, /<a href="https:\/\/example\.com\/podcast">/);
  assert.equal(platformCopy.publication_authorized, false);
  console.log("PASS assembly prepares clickable YouTube and Spotify copy without authorizing publication");

  assert.throws(() => buildEpisodeAssembly({
    slug: "demo_episode",
    timeline,
    timelinePreviewReview: preview,
    inputSignatures: signatures,
    draft: {
      program_start: 0,
      program_end: 120_000,
      shots: [
        { start_ms: 0, end_ms: 50_000, layout: "side_by_side" },
        { start_ms: 51_000, end_ms: 120_000, layout: "isolated", camera_source_id: "secondary_camera" },
      ],
    },
  }), /no gap or overlap/);
  console.log("PASS assembly rejects gaps and overlaps in the camera cut plan");

  assert.throws(() => buildEpisodeAssembly({
    slug: "demo_episode",
    timeline,
    timelinePreviewReview: { ...preview, status: "pending" },
    inputSignatures: signatures,
  }), /confirm the current aligned camera preview/);
  console.log("PASS assembly requires the human-reviewed aligned preview");

  const review = buildEpisodeAssemblyReview({
    assembly,
    status: "approved",
    reviewedAt: "2026-08-22T20:12:00.000Z",
  });
  assert.equal(episodeAssemblyReviewMatchesPlan(review, assembly), true);
  assert.equal(review.render_authorized, false);
  console.log("PASS assembly approval is plan-bound and does not overclaim render capability");

  const inherited = buildEpisodeAssembly({
    slug: "demo_episode",
    timeline,
    timelinePreviewReview: preview,
    inputSignatures: signatures,
    ctaGraphicManifest: cta,
    draft: {
      title: "Inherited package demo",
      program_start: 0,
      program_end: 120_000,
      opening: {}, closing: {}, cta_graphic: {}, newsletter_cta: {},
      show_package: {
        fingerprint: "show-package-a",
        reviewed_at: "2026-08-22T20:09:00.000Z",
        sections: { opening: "show_default", closing: "show_default", cta_graphic: "show_default" },
      },
    },
  });
  assert.equal(episodeAssemblyMatchesInputs(inherited, timeline, preview, signatures, cta, null, "show-package-a"), true);
  assert.equal(episodeAssemblyMatchesInputs(inherited, timeline, preview, signatures, cta, null, "show-package-b"), false);
  assert.equal(inherited.show_package.refresh_behavior, "explicit");
  console.log("PASS inherited recipes expire when the approved show package changes and require explicit refresh");

  writeFileSync(visualPath, "visual changed");
  assert.equal(episodeAssemblyMatchesInputs(assembly, timeline, preview, signatures, cta), false);
  console.log("PASS changed show assets expire the assembly receipt");

  writeFileSync(visualPath, "visual");
  const automatic = buildEpisodeAssembly({
    slug: "demo_episode",
    timeline,
    timelinePreviewReview: preview,
    inputSignatures: signatures,
    ctaGraphicManifest: cta,
    cameraPlan,
    draft: {
      title: "Automatic demo",
      program_start: 10_000,
      program_end: 110_000,
      apply_camera_plan: true,
      camera_plan_fingerprint: cameraPlan.fingerprint,
      opening: {}, closing: {}, cta_graphic: {}, newsletter_cta: {},
    },
  });
  assert.equal(automatic.camera_direction.mode, "automatic_source_bound");
  assert.equal(automatic.program.shots[0].start_ms, 10_000);
  assert.equal(automatic.program.shots[0].end_ms, 60_000);
  assert.deepEqual(automatic.program.shots[0].source_camera_plan_shot_ids, ["plan_1"]);
  assert.deepEqual(automatic.program.shots[1].reason_codes, ["confirmed_host_2_sustained"]);
  assert.equal(episodeAssemblyMatchesInputs(automatic, timeline, preview, signatures, cta, cameraPlan), true);
  assert.equal(episodeAssemblyMatchesInputs(automatic, timeline, preview, signatures, cta, { ...cameraPlan, fingerprint: "changed" }), false);
  console.log("PASS automatic assembly preserves exact internal plan boundaries, reasons, evidence, and fingerprint expiry");
  const revisionDraft = { ...assembly, shots: assembly.program.shots,
    opening: { ...assembly.opening, trim_end_ms: 2_000 },
    closing: { ...assembly.closing, audio_gain_db: -4 },
    visual_style: { ...assembly.visual_style, program_fade_in_ms: 450 },
    program_graphics: { enabled: true,
      lower_thirds: [{ start_ms: 12_000, duration_ms: 8_000 }],
      topic_bars: [{ start_ms: 30_000, duration_ms: 30_000, title: "Long bottom topic", position: "bottom" }] } };
  const makeRevision = (draft) => buildEpisodeAssembly({ slug: "demo_episode", timeline, timelinePreviewReview: preview, inputSignatures: signatures, draft });
  const revision = makeRevision(revisionDraft);
  assert.equal(revision.opening.trim_end_ms, 2_000);
  assert.equal(revision.closing.audio_gain_db, -4);
  assert.equal(revision.program_graphics.topic_bars[0].end_ms, 60_000);
  assert.equal(revision.program_graphics.topic_bars[0].position, "bottom");
  assert.equal(episodeAssemblyReviewMatchesPlan(buildEpisodeAssemblyReview({ assembly, status: "approved" }), revision), false);
  assert.throws(() => makeRevision({ ...revisionDraft, opening: { ...revisionDraft.opening, trim_end_ms: 10_001 } }), /tail trim/);
  assert.throws(() => makeRevision({ ...revisionDraft, closing: { ...revisionDraft.closing, audio_gain_db: 1 } }), /audio gain/);
  assert.throws(() => makeRevision({ ...revisionDraft, visual_style: { program_fade_in_ms: 1_001 } }), /fade-in/);
  assert.throws(() => makeRevision({ ...revisionDraft, program_graphics: { ...revisionDraft.program_graphics,
    topic_bars: [{ start_ms: 19_000, duration_ms: 30_000, title: "Collision", position: "bottom" }] } }), /must not overlap/);
  assert.throws(() => makeRevision({ ...revisionDraft, program_graphics: { topic_bars: [{ start_ms: 30_000, duration_ms: 60_001, title: "Too long" }] } }), /2-60 seconds/);
  assert.equal(assembly.program_graphics.topic_bars[0].position, "top");
  assert.equal(assembly.opening.trim_end_ms, 0);
  assert.equal(assembly.closing.audio_gain_db, 0);
  console.log("PASS bounded editorial controls, bottom-graphic collision checks, legacy defaults, and revision approval expiry");
} finally {
  rmSync(root, { recursive: true, force: true });
}
