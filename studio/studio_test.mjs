#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createStudioServer } from "./server.mjs";
import { manifestSourceSignature } from "./sync.mjs";

const studioDir = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "eaol-studio-test-"));
const episodeDir = join(root, "work", "demo_episode");
const source = join(root, "demo.mp4");
const sourceTwo = join(root, "demo-two.mp4");
const recoveredDir = join(root, "work", "recovered_episode");
const assetRoot = join(root, "show-assets");
const ctaGraphic = join(assetRoot, "graphics", "cta.png");
const introVoice = join(assetRoot, "voice", "intro.wav");

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function jsonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  return { response, body };
}

async function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { host } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

mkdirSync(episodeDir, { recursive: true });
mkdirSync(recoveredDir, { recursive: true });
mkdirSync(dirname(ctaGraphic), { recursive: true });
mkdirSync(dirname(introVoice), { recursive: true });
writeFileSync(source, "0123456789");
writeFileSync(sourceTwo, "abcdefghij");
writeFileSync(ctaGraphic, "graphic");
writeFileSync(introVoice, "voice");
writeJson(join(recoveredDir, "studio_job.json"), {
  schema: "eaol-studio-job-v1",
  id: "00000000-0000-4000-8000-000000000001",
  type: "ingest",
  slug: "recovered_episode",
  status: "running",
  pid: 999_999,
  logs: ["Source inspection was running."],
  started_at: "2026-08-16T11:00:00.000Z",
});
const sourceReceipt = (id, label, path, file) => {
  const stat = statSync(path);
  return {
    id,
    label,
    expected_kind: "video",
    path,
    file,
    bytes: stat.size,
    modified_ms: Math.round(stat.mtimeMs),
    duration_sec: 120,
    video: { codec: "h264", width: 3840, height: 2160, fps: 30 },
    audio: { codec: "aac", sample_rate: 48000, channels: 2 },
  };
};
const primaryReceipt = sourceReceipt("primary_camera", "Host 1 camera", source, "demo.mp4");
const secondaryReceipt = sourceReceipt("secondary_camera", "Host 2 camera", sourceTwo, "demo-two.mp4");
writeJson(join(episodeDir, "meta.json"), {
  source,
  duration_sec: 120,
  model: "test-model",
  transcribed_at: "2026-08-16T12:00:00.000Z",
});
writeJson(join(episodeDir, "probe.json"), {
  format: { duration: "120.000" },
  streams: [{ codec_type: "video", width: 3840, height: 2160 }],
});
writeJson(join(episodeDir, "episode.json"), {
  schema: "eaol-episode-v1",
  slug: "demo_episode",
  analyzed_at: "2026-08-16T12:00:00.000Z",
  sources: [primaryReceipt, secondaryReceipt],
  compatibility: {
    status: "attention",
    blocking: [],
    warnings: ["Only one camera is attached."],
    camera_count: 1,
    isolated_audio_count: 0,
    duration_spread_sec: 0,
    sync_status: "not_measured",
    next_step: "Measure waveform offsets and end-clap drift.",
  },
});
writeJson(join(episodeDir, "sync.json"), {
  schema: "eaol-sync-v1",
  algorithm: "envelope-correlation-v1",
  status: "attention",
  reference_source_id: "primary_camera",
  input_signatures: [primaryReceipt, secondaryReceipt].map(manifestSourceSignature),
  results: [{ source_id: "secondary_camera", label: "Host 2 camera", status: "low_confidence", start_offset_ms: 500, end_offset_ms: 520, drift_ms: 20 }],
});
writeFileSync(
  join(episodeDir, "transcript.srt"),
  "1\n00:00:10,000 --> 00:00:20,000\nThis is the opening thought.\n\n2\n00:00:20,000 --> 00:00:40,000\nPlease like, comment, and subscribe before we go.\n",
);

const initialDocument = {
  schema: "eaol-clips-v1",
  source_slug: "demo_episode",
  selected_by: "Studio test",
  clips: [
    {
      id: "clip_001",
      start: "00:00:10.000",
      end: "00:00:40.000",
      title: "A complete thought",
      hook: "A clear opening",
      rationale: "Tests the complete review path",
      crop_offset_px: 0,
    },
  ],
};
writeJson(join(episodeDir, "clips.json"), initialDocument);

const server = createStudioServer({
  root,
  publicDir: join(studioDir, "public"),
  diskAvailableBytes: 256 * 1024 ** 2,
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await jsonRequest(baseUrl, "/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.local_only, true);
  assert.equal(health.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.response.headers.get("x-frame-options"), "DENY");

  const hostileOrigin = await fetch(`${baseUrl}/api/jobs/ingest`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
    body: "{}",
  });
  assert.equal(hostileOrigin.status, 403);
  assert.match((await hostileOrigin.json()).error, /cross-site requests are not allowed/);

  const wrongContentType = await fetch(`${baseUrl}/api/jobs/ingest`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongContentType.status, 415);
  assert.match((await wrongContentType.json()).error, /must use application\/json/);

  const hostileHost = await requestWithHost(`${baseUrl}/api/health`, "attacker.example");
  assert.equal(hostileHost.status, 403);
  assert.match(hostileHost.body.error, /local address/);

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("cross-origin-resource-policy"), "same-origin");
  const pageHtml = await page.text();
  assert.match(pageHtml, /Explore AI Out Loud Studio/);
  assert.match(pageHtml, /Show package defaults/);
  assert.match(pageHtml, /How to use Studio/);
  assert.match(pageHtml, /Next recommended action/);
  assert.match(pageHtml, /One approved foundation, two production workflows/);
  assert.match(pageHtml, /Shared episode foundation/);
  assert.match(pageHtml, /data-workflow-branch-choice="episode"/);
  assert.match(pageHtml, /data-workflow-branch-choice="social"/);
  assert.match(pageHtml, /Turn complete thoughts into reviewed vertical clips/);
  assert.match(pageHtml, /Who is using this Studio/);
  assert.match(pageHtml, /Shared candidate inbox/);
  assert.match(pageHtml, /9:16 pre-render preview/);
  assert.match(pageHtml, /Needs discussion/);
  assert.match(pageHtml, /Generate up to 6 suggestions/);
  assert.match(pageHtml, /One master · three platform cards/);
  assert.match(pageHtml, /Build new local social delivery version/);
  assert.match(pageHtml, /Local handoff only/);
  assert.match(pageHtml, /What Studio never assumes/);
  assert.match(pageHtml, /Different narration each episode/);
  assert.match(pageHtml, /Refresh from approved defaults/);
  assert.match(pageHtml, /Source readiness/);
  assert.match(pageHtml, /Analyze waveform sync/);
  assert.match(pageHtml, /Build aligned timeline/);
  assert.match(pageHtml, /Transcribe host tracks/);
  assert.match(pageHtml, /Aligned camera preview/);
  assert.match(pageHtml, /CTA graphic cues/);
  assert.match(pageHtml, /Name this numbered episode/);
  assert.match(pageHtml, /Generate with model — setup later/);
  assert.match(pageHtml, /Episode assembly/);
  assert.match(pageHtml, /Production readiness/);
  assert.match(pageHtml, /Test and recovery tools/);
  assert.match(pageHtml, /Prepare 5-minute test window/);
  assert.match(pageHtml, /Show all steps/);
  assert.match(pageHtml, /data-workflow-panel="transcript review"/);
  assert.match(pageHtml, />Start</);
  assert.match(pageHtml, />End</);
  assert.match(pageHtml, /Two-shot separator/);
  assert.match(pageHtml, /Camera image balance/);
  assert.match(pageHtml, /Complete proxy review/);
  assert.match(pageHtml, /Camera exposure balance is acceptable/);
  assert.match(pageHtml, /Split longest shot/);
  assert.match(pageHtml, /Apply source-bound camera plan/);
  assert.match(pageHtml, /Recorded-program camera preview/);
  assert.match(pageHtml, /Opening, CTA graphics, divider, and closing are verified in the integrated proxy/);
  assert.match(pageHtml, /Pause preview/);
  assert.match(pageHtml, /Resume preview/);
  assert.match(pageHtml, /Representative preview position/);
  assert.match(pageHtml, /Rotate camera 1 clockwise/);
  assert.match(pageHtml, /Review display only; source files and renders stay unchanged/);
  assert.match(pageHtml, /Render low-res proxy/);
  assert.match(pageHtml, /Opening package/);
  assert.match(pageHtml, /Recorded intro audio/);
  assert.match(pageHtml, /Podcast-page link/);
  assert.match(pageHtml, /Newsletter CTA · separate/);
  assert.match(pageHtml, /show defaults to side by side/);
  assert.match(pageHtml, /Open simple package review/);
  assert.match(pageHtml, /Render full episode/);
  assert.match(pageHtml, /RSS-ready audio/);
  assert.match(pageHtml, /Create RSS-ready audio/);
  assert.match(pageHtml, /Final captions, transcript & chapters/);
  assert.match(pageHtml, /Build final text package/);
  assert.match(pageHtml, /Swap Host labels/);
  assert.match(pageHtml, /Fix this line/);
  assert.match(pageHtml, /stage-alignment/);
  assert.match(pageHtml, /Measure drift; confirm the claps/);
  assert.match(pageHtml, /Hide job details/);
  assert.match(pageHtml, /Episode checklist/);
  assert.match(pageHtml, /Add Host 1 part/);
  assert.match(pageHtml, /Add Host 2 part/);
  assert.match(pageHtml, /I checked this order against the recorder sequence/);
  const appScript = await (await fetch(`${baseUrl}/app.js`)).text();
  assert.match(appScript, /Proxy acceptance/);
  assert.match(appScript, /Exact-file audit plus focused human review/);
  assert.match(appScript, /3840×2160 4K UHD local master/);
  assert.match(appScript, /function summarizeEvidenceIds/);
  assert.match(appScript, /pause-camera-plan-preview-button.*stopCameraPlanPreview/s);
  assert.match(appScript, /function addAudioPart/);
  assert.match(appScript, /function reviewAudioSeam/);
  assert.match(appScript, /function createBrowserPreview/);
  assert.match(appScript, /function primaryReviewMediaUrl/);
  assert.match(appScript, /raw camera and production render source stay unchanged/i);
  assert.match(appScript, /function rotateReviewSource/);
  assert.match(appScript, /eaol-review-rotation/);
  assert.match(appScript, /function resumeCameraPlanPreview/);
  assert.match(appScript, /function seekCameraPlanPreview/);
  assert.match(appScript, /function prepareE2EProof/);
  assert.match(appScript, /function applyWorkflowView/);
  assert.match(appScript, /function selectWorkflowStage/);
  assert.match(appScript, /alignedPlaybackComplete && channelValidationComplete && speakerActivityComplete/);
  assert.match(appScript, /!hasAssignedIsolatedPair \|\| isolatedTranscriptComplete/);
  assert.match(appScript, /Focused view shows one production step at a time/);
  assert.match(appScript, /episode-proxy-review/);
  assert.match(appScript, /episode-proxy-audit/);
  assert.match(appScript, /metadata_assisted/);
  assert.match(appScript, /function runEpisodeProxyAudit/);
  assert.match(appScript, /Watch the complete package/);
  assert.match(appScript, /proxy-review/);
  assert.match(appScript, /function saveOperatorIdentity/);
  assert.match(appScript, /function updateCandidatePreview/);
  assert.match(appScript, /rejected ideas?.*preserved/i);
  assert.match(appScript, /requestedSlug/);

  const proxyReviewPage = await fetch(`${baseUrl}/proxy_review.html?episode=demo_episode`);
  assert.equal(proxyReviewPage.status, 200);
  const proxyReviewHtml = await proxyReviewPage.text();
  assert.match(proxyReviewHtml, /After a passing metadata audit, confirm the six focused checks/);
  assert.match(proxyReviewHtml, /Choose a complete watch only if you actually watched the video from beginning to end/);
  assert.match(proxyReviewHtml, /proxy_review\.css/);
  assert.match(proxyReviewHtml, /proxy_review\.js/);
  assert.doesNotMatch(proxyReviewHtml, /<style>/);
  assert.doesNotMatch(proxyReviewHtml, /<script>/);
  const proxyReviewScript = await (await fetch(`${baseUrl}/proxy_review.js`)).text();
  assert.match(proxyReviewScript, /episode-proxy-media/);
  assert.match(proxyReviewScript, /Newsletter CTA shown/);
  assert.match(proxyReviewScript, /Podcast CTA shown/);
  assert.match(proxyReviewScript, /Closing CTA shown/);
  assert.match(proxyReviewScript, /Jump to/);
  const proxyReviewStyle = await (await fetch(`${baseUrl}/proxy_review.css`)).text();
  assert.match(proxyReviewStyle, /\.video-panel/);

  const activeJobs = await jsonRequest(baseUrl, "/api/jobs/active");
  assert.equal(activeJobs.response.status, 200);
  assert.equal(activeJobs.body.jobs.length, 1);
  assert.equal(activeJobs.body.jobs[0].status, "interrupted");
  assert.match(activeJobs.body.jobs[0].error, /valid completed phases will be reused/);
  assert.equal(activeJobs.body.jobs[0].pid, undefined);

  const recoveredJob = await jsonRequest(baseUrl, "/api/jobs/00000000-0000-4000-8000-000000000001");
  assert.equal(recoveredJob.body.job.status, "interrupted");

  const missingOperator = await jsonRequest(baseUrl, "/api/operator");
  assert.equal(missingOperator.body.operator, null);
  const invalidOperator = await jsonRequest(baseUrl, "/api/operator", {
    method: "PUT",
    body: JSON.stringify({ operator_id: "someone-else" }),
  });
  assert.equal(invalidOperator.response.status, 400);
  const savedOperator = await jsonRequest(baseUrl, "/api/operator", {
    method: "PUT",
    body: JSON.stringify({ operator_id: "host_1" }),
  });
  assert.equal(savedOperator.body.operator.operator_id, "host_1");
  assert.equal(savedOperator.body.operator.local_only, true);

  const episodeList = await jsonRequest(baseUrl, "/api/episodes");
  assert.equal(episodeList.body.episodes.length, 1);
  assert.equal(episodeList.body.episodes[0].candidate_count, 1);
  assert.equal(episodeList.body.episodes[0].source_count, 2);
  assert.equal(episodeList.body.episodes[0].intake_status, "attention");
  assert.equal(episodeList.body.episodes[0].display_name, "demo.mp4");
  assert.equal(episodeList.body.episodes[0].workflow_status, "Name numbered episode");

  const detail = await jsonRequest(baseUrl, "/api/episodes/demo_episode");
  assert.equal(detail.body.episode.transcript.length, 2);
  assert.equal(detail.body.episode.candidates[0].review.status, "proposed");
  assert.equal(detail.body.episode.intake.compatibility.sync_status, "not_measured");
  assert.equal(detail.body.episode.sync.review.status, "pending");
  assert.deepEqual(detail.body.episode.browser_previews, {});
  assert.deepEqual(detail.body.episode.speaker_transcript_state.missing_sources, ["host_1_audio", "host_2_audio"]);
  assert.equal(detail.body.episode.cta_cues.detected_count, 1);
  assert.equal(detail.body.episode.cta_cues.confirmed_count, 0);
  assert.equal(detail.body.episode.cta_cues.render_authorized, false);
  assert.equal(detail.body.episode.episode_checklist_summary.total > 20, true);
  const completedChecklist = await jsonRequest(baseUrl, "/api/episodes/demo_episode/checklist/recording_part_count", {
    method: "PUT",
    body: JSON.stringify({ status: "complete", notes: "Two parts per host counted", owner: "Host 1" }),
  });
  assert.equal(completedChecklist.response.status, 200);
  assert.equal(completedChecklist.body.episode.episode_checklist.items.find((item) => item.id === "recording_part_count").status, "complete");
  const addedChecklist = await jsonRequest(baseUrl, "/api/episodes/demo_episode/checklist", {
    method: "POST",
    body: JSON.stringify({ phase: "learning", title: "Check receiver cable strain relief", owner: "Both", description: "Learned during this episode" }),
  });
  assert.equal(addedChecklist.response.status, 201);
  assert.equal(addedChecklist.body.episode.episode_checklist.items.some((item) => item.title === "Check receiver cable strain relief"), true);

  const confirmedCta = await jsonRequest(baseUrl, "/api/episodes/demo_episode/cta-cues", {
    method: "PUT",
    body: JSON.stringify({ cue_id: detail.body.episode.cta_cues.cues[0].id, status: "confirmed" }),
  });
  assert.equal(confirmedCta.response.status, 200);
  assert.equal(confirmedCta.body.episode.cta_cues.confirmed_count, 1);
  assert.equal(confirmedCta.body.episode.cta_cues.manifest_current, true);
  const ctaManifest = JSON.parse(readFileSync(join(episodeDir, "cta_graphic_manifest.json"), "utf8"));
  assert.equal(ctaManifest.cues.length, 1);
  assert.equal(ctaManifest.cues[0].actions.join(" / "), "like / comment / subscribe");
  assert.equal(ctaManifest.render_authorized, false);
  assert.equal(ctaManifest.cue_review_updated_at, confirmedCta.body.episode.cta_cues.review_updated_at);
  assert.match(readFileSync(join(episodeDir, "cta_graphic_cue_sheet.md"), "utf8"), /Scrub window/);

  const unsafeApproval = await jsonRequest(baseUrl, "/api/episodes/demo_episode/sync-review", {
    method: "PUT",
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(unsafeApproval.response.status, 400);
  assert.match(unsafeApproval.body.error, /cannot be approved/);

  const rejectedSync = await jsonRequest(baseUrl, "/api/episodes/demo_episode/sync-review", {
    method: "PUT",
    body: JSON.stringify({ status: "rejected", notes: "Low confidence" }),
  });
  assert.equal(rejectedSync.response.status, 200);
  assert.equal(rejectedSync.body.episode.sync.review.status, "rejected");

  const missingPrimary = await jsonRequest(baseUrl, "/api/jobs/ingest", {
    method: "POST",
    body: JSON.stringify({ sources: {} }),
  });
  assert.equal(missingPrimary.response.status, 400);
  assert.match(missingPrimary.body.error, /Host 1 camera is required/);

  const wrongAudio = await jsonRequest(baseUrl, "/api/jobs/ingest", {
    method: "POST",
    body: JSON.stringify({ sources: { primary_camera: source, host_1_audio: source } }),
  });
  assert.equal(wrongAudio.response.status, 400);
  assert.match(wrongAudio.body.error, /supported audio file/);

  const duplicateRole = await jsonRequest(baseUrl, "/api/jobs/ingest", {
    method: "POST",
    body: JSON.stringify({ sources: { primary_camera: source, secondary_camera: source } }),
  });
  assert.equal(duplicateRole.response.status, 400);
  assert.match(duplicateRole.body.error, /different file/);

  const diskBlocked = await jsonRequest(baseUrl, "/api/jobs/transcribe", {
    method: "POST",
    body: JSON.stringify({ input: source }),
  });
  assert.equal(diskBlocked.response.status, 507);
  assert.match(diskBlocked.body.error, /Not enough free space/);

  const blockedRender = await jsonRequest(baseUrl, "/api/episodes/demo_episode/render", {
    method: "POST",
    body: JSON.stringify({ clip_id: "clip_001" }),
  });
  assert.equal(blockedRender.response.status, 400);
  assert.match(blockedRender.body.error, /approve this candidate/);

  const blockedDeliveryAudio = await jsonRequest(baseUrl, "/api/episodes/demo_episode/delivery-audio", {
    method: "POST",
    body: "{}",
  });
  assert.equal(blockedDeliveryAudio.response.status, 400);
  assert.match(blockedDeliveryAudio.body.error, /full episode/);

  const blockedDeliveryText = await jsonRequest(baseUrl, "/api/episodes/demo_episode/delivery-text", {
    method: "PUT",
    body: JSON.stringify({ chapter_lines: ["00:00 Opening", "00:40 Main", "01:20 Close"] }),
  });
  assert.equal(blockedDeliveryText.response.status, 400);
  assert.match(blockedDeliveryText.body.error, /full episode/);

  const media = await fetch(`${baseUrl}/api/episodes/demo_episode/media`, {
    headers: { range: "bytes=2-5" },
  });
  assert.equal(media.status, 206);
  assert.equal(await media.text(), "2345");

  writeJson(join(episodeDir, "meta.json"), {
    source: join(root, "recording-that-moved.mp4"),
    duration_sec: 120,
    model: "test-model",
    transcribed_at: "2026-08-16T12:00:00.000Z",
  });
  const unavailable = await jsonRequest(baseUrl, "/api/episodes/demo_episode");
  assert.equal(unavailable.body.episode.source_available, false);
  const unavailableMedia = await jsonRequest(baseUrl, "/api/episodes/demo_episode/media");
  assert.equal(unavailableMedia.response.status, 404);
  const stillHealthy = await jsonRequest(baseUrl, "/api/health");
  assert.equal(stillHealthy.body.ok, true);

  const malformedPath = await fetch(`${baseUrl}/%`);
  assert.equal(malformedPath.status, 400);
  assert.equal((await jsonRequest(baseUrl, "/api/health")).body.ok, true);

  const interruptedManifest = JSON.parse(readFileSync(join(episodeDir, "episode.json"), "utf8"));
  interruptedManifest.transcription = { status: "failed", updated_at: new Date().toISOString() };
  writeJson(join(episodeDir, "episode.json"), interruptedManifest);
  const interruptedDetail = await jsonRequest(baseUrl, "/api/episodes/demo_episode");
  assert.equal(interruptedDetail.body.episode.transcript.length, 0);
  const interruptedApproval = await jsonRequest(baseUrl, "/api/episodes/demo_episode/review/clip_001", {
    method: "PUT",
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(interruptedApproval.response.status, 400);
  assert.match(interruptedApproval.body.error, /transcript is not current/);
  delete interruptedManifest.transcription;
  writeJson(join(episodeDir, "episode.json"), interruptedManifest);

  const save = await jsonRequest(baseUrl, "/api/episodes/demo_episode/clips", {
    method: "PUT",
    body: JSON.stringify(initialDocument),
  });
  assert.equal(save.response.status, 200);
  assert.equal(JSON.parse(readFileSync(join(episodeDir, "clips.json"), "utf8")).clips[0].id, "clip_001");

  const collaborativeDocument = {
    schema: "eaol-clips-v2",
    selected_by: "Host 1 via Explore AI Out Loud Studio",
    clips: [
      { ...initialDocument.clips[0], segment_ids: [], category: "explainer" },
      {
        id: "clip_002", start: "00:00:30.000", end: "00:00:50.000", segment_ids: [],
        title: "Second complete thought", hook: "A second opening line", rationale: "A separate useful idea",
        crop_offset_px: 0, category: "takeaway",
      },
    ],
  };
  const savedCollaborative = await jsonRequest(baseUrl, "/api/episodes/demo_episode/clips", {
    method: "PUT",
    body: JSON.stringify(collaborativeDocument),
  });
  assert.equal(savedCollaborative.response.status, 200);
  assert.equal(savedCollaborative.body.episode.candidates[1].proposed_by, "host_1");
  assert.equal(savedCollaborative.body.episode.candidates[1].origin, "human");
  assert.equal(savedCollaborative.body.episode.candidates[1].review.status, "proposed");
  await jsonRequest(baseUrl, "/api/episodes/demo_episode/clips", {
    method: "PUT",
    body: JSON.stringify(initialDocument),
  });

  const invalid = structuredClone(initialDocument);
  invalid.clips[0].end = "00:00:14.000";
  const rejectedSave = await jsonRequest(baseUrl, "/api/episodes/demo_episode/clips", {
    method: "PUT",
    body: JSON.stringify(invalid),
  });
  assert.equal(rejectedSave.response.status, 400);
  assert.match(rejectedSave.body.error, /15–90 seconds/);

  const review = await jsonRequest(baseUrl, "/api/episodes/demo_episode/review/clip_001", {
    method: "PUT",
    body: JSON.stringify({ status: "approved", notes: "Ready for render" }),
  });
  assert.equal(review.response.status, 200);
  assert.equal(review.body.episode.candidates[0].review.status, "approved");
  assert.equal(review.body.episode.candidates[0].review.reviewed_by, "host_1");

  const discussionReview = await jsonRequest(baseUrl, "/api/episodes/demo_episode/review/clip_001", {
    method: "PUT",
    body: JSON.stringify({ status: "needs_discussion", notes: "Host 2: compare the tighter ending before approval" }),
  });
  assert.equal(discussionReview.response.status, 200);
  assert.equal(discussionReview.body.episode.candidates[0].review.status, "needs_discussion");
  assert.equal(discussionReview.body.episode.candidates[0].review.discussion.at(-1).by, "host_1");
  assert.match(discussionReview.body.episode.candidates[0].review.discussion.at(-1).note, /tighter ending/);
  const approvalAfterDiscussion = await jsonRequest(baseUrl, "/api/episodes/demo_episode/review/clip_001", {
    method: "PUT",
    body: JSON.stringify({ status: "approved", notes: "Tighter ending reviewed" }),
  });
  assert.equal(approvalAfterDiscussion.body.episode.candidates[0].review.status, "approved");
  assert.equal(approvalAfterDiscussion.body.episode.candidates[0].review.discussion.length, 3);

  const editedDocument = structuredClone(initialDocument);
  editedDocument.clips[0].title = "A revised complete thought";
  const editedCandidate = await jsonRequest(baseUrl, "/api/episodes/demo_episode/clips", {
    method: "PUT",
    body: JSON.stringify(editedDocument),
  });
  assert.equal(editedCandidate.response.status, 200);
  assert.equal(editedCandidate.body.episode.candidates[0].review.status, "proposed");
  assert.ok(editedCandidate.body.episode.candidates[0].review.invalidated_at);
  const reapproveEditedCandidate = await jsonRequest(baseUrl, "/api/episodes/demo_episode/review/clip_001", {
    method: "PUT",
    body: JSON.stringify({ status: "approved", notes: "Re-reviewed after edit" }),
  });
  assert.equal(reapproveEditedCandidate.response.status, 200);
  assert.equal(reapproveEditedCandidate.body.episode.candidates[0].review.status, "approved");

  writeJson(join(episodeDir, "sync.json"), {
    schema: "eaol-sync-v1",
    algorithm: "envelope-correlation-v1",
    status: "review_required",
    analyzed_at: "2026-08-16T12:30:00.000Z",
    reference_source_id: "primary_camera",
    input_signatures: [primaryReceipt, secondaryReceipt].map(manifestSourceSignature),
    results: [{ source_id: "secondary_camera", label: "Host 2 camera", status: "measured", start_offset_ms: 500, end_offset_ms: 500, drift_ms: 0 }],
  });
  writeJson(join(episodeDir, "sync_review.json"), {
    schema: "eaol-sync-review-v1",
    status: "pending",
    input_signatures: [primaryReceipt, secondaryReceipt].map(manifestSourceSignature),
  });
  const unconfirmedTimeline = await jsonRequest(baseUrl, "/api/episodes/demo_episode/timeline", {
    method: "POST",
    body: "{}",
  });
  assert.equal(unconfirmedTimeline.response.status, 400);
  assert.match(unconfirmedTimeline.body.error, /confirm the current sync measurement/);
  const approvedSync = await jsonRequest(baseUrl, "/api/episodes/demo_episode/sync-review", {
    method: "PUT",
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(approvedSync.response.status, 200);
  assert.equal(approvedSync.body.episode.sync.review.status, "approved");

  const builtTimeline = await jsonRequest(baseUrl, "/api/episodes/demo_episode/timeline", {
    method: "POST",
    body: "{}",
  });
  assert.equal(builtTimeline.response.status, 200);
  assert.equal(builtTimeline.body.episode.timeline.status, "preview_required");
  assert.equal(builtTimeline.body.episode.timeline.render_authorized, false);
  assert.equal(builtTimeline.body.episode.timeline.tracks.length, 2);
  assert.equal(builtTimeline.body.episode.timeline.tracks[1].source_in_ms, 500);
  assert.equal(JSON.parse(readFileSync(join(episodeDir, "timeline.json"), "utf8")).editable, true);
  const companionMedia = await fetch(`${baseUrl}/api/episodes/demo_episode/media/secondary_camera`, {
    headers: { range: "bytes=1-3" },
  });
  assert.equal(companionMedia.status, 206);
  assert.equal(await companionMedia.text(), "bcd");
  const uncheckedPreview = await jsonRequest(baseUrl, "/api/episodes/demo_episode/timeline-review", {
    method: "PUT",
    body: JSON.stringify({ status: "approved", checked_start: true, checked_end: false }),
  });
  assert.equal(uncheckedPreview.response.status, 400);
  assert.match(uncheckedPreview.body.error, /check both the start and end/);
  const startChecked = await jsonRequest(baseUrl, "/api/episodes/demo_episode/timeline-review", {
    method: "PUT",
    body: JSON.stringify({ status: "pending", checked_start: true, checked_end: false }),
  });
  assert.equal(startChecked.response.status, 200);
  assert.equal(startChecked.body.episode.timeline_preview_review.checked_start, true);
  const approvedPreview = await jsonRequest(baseUrl, "/api/episodes/demo_episode/timeline-review", {
    method: "PUT",
    body: JSON.stringify({ status: "approved", checked_start: true, checked_end: true }),
  });
  assert.equal(approvedPreview.response.status, 200);
  assert.equal(approvedPreview.body.episode.timeline_preview_review.status, "approved");
  assert.equal(approvedPreview.body.episode.timeline_preview_review.render_authorized, false);
  assert.equal(approvedPreview.body.episode.episode_assembly_state.eligible, false);
  assert.equal(approvedPreview.body.episode.episode_assembly_state.naming_required, true);
  const namingRequest = await jsonRequest(baseUrl, "/api/episodes/demo_episode/episode-naming/request", {
    method: "POST",
    body: JSON.stringify({ episode_number: 1 }),
  });
  assert.equal(namingRequest.response.status, 201);
  assert.equal(namingRequest.body.request.production_id, "ep001");
  assert.equal(namingRequest.body.episode.episode_naming.provider_connected, false);
  assert.equal(namingRequest.body.episode.episode_naming.generation_available, false);
  const humanTitle = await jsonRequest(baseUrl, "/api/episodes/demo_episode/episode-naming/human-candidate", {
    method: "POST",
    body: JSON.stringify({ canonical_title: "Demo episode", rationale: "The test transcript supports this direct title." }),
  });
  assert.equal(humanTitle.response.status, 201);
  assert.equal(humanTitle.body.proposal.generator.provider, "none");
  const approvedTitle = await jsonRequest(baseUrl, "/api/episodes/demo_episode/episode-naming/approval", {
    method: "PUT",
    body: JSON.stringify({ candidate_id: "title_001" }),
  });
  assert.equal(approvedTitle.response.status, 200);
  assert.equal(approvedTitle.body.episode.episode_naming.approved, true);
  assert.equal(approvedTitle.body.episode.episode_assembly_state.eligible, true);
  assert.equal(approvedTitle.body.approval.platform_titles.youtube, "Demo episode | Ep. 1");
  assert.equal(approvedTitle.body.approval.assembly_authorized, false);
  const emptyShowPackage = await jsonRequest(baseUrl, "/api/show-package");
  assert.equal(emptyShowPackage.response.status, 200);
  assert.equal(emptyShowPackage.body.show_package, null);
  const savedShowPackage = await jsonRequest(baseUrl, "/api/show-package", {
    method: "PUT",
    body: JSON.stringify({
      name: "Explore AI Out Loud",
      opening: { narration_mode: "episode_specific", visual_path: source },
      closing: { narration_mode: "evergreen", visual_path: sourceTwo, voiceover_path: introVoice },
      cta_graphic: {
        asset_path: ctaGraphic,
        website_url: "https://example.com/podcast",
        website_label: "Explore AI Out Loud",
        actions: ["like", "comment", "subscribe"],
        show_during_closing: true,
      },
    }),
  });
  assert.equal(savedShowPackage.response.status, 200);
  assert.equal(savedShowPackage.body.current, true);
  assert.equal(savedShowPackage.body.approved, false);
  assert.equal(savedShowPackage.body.show_package.opening.episode_voiceover_required, true);
  const blockedShowPackageApproval = await jsonRequest(baseUrl, "/api/show-package-review", {
    method: "PUT",
    body: JSON.stringify({ status: "approved", notes: "Reusable opening, closing, and CTA reviewed." }),
  });
  assert.equal(blockedShowPackageApproval.response.status, 400);
  assert.match(blockedShowPackageApproval.body.error, /render and watch the current opening and closing previews/);
  const showPackagePreviewDir = join(root, "work", "show_package", "previews");
  mkdirSync(showPackagePreviewDir, { recursive: true });
  for (const section of ["opening", "closing"]) {
    const outputPath = join(showPackagePreviewDir, `${section}_preview.mp4`);
    writeFileSync(outputPath, `${section}-preview`);
    const stat = statSync(outputPath);
    writeJson(join(root, "work", "show_package", `${section}_preview.json`), {
      schema: "eaol-show-package-preview-v1",
      status: "complete",
      section,
      show_package_fingerprint: savedShowPackage.body.show_package.fingerprint,
      output: {
        path: outputPath,
        bytes: stat.size,
        modified_ms: Math.round(stat.mtimeMs),
      },
      checks: { dimensions: true, video_codec: true, audio_codec: true, audio: true, duration: true },
      episode_inheritance_authorized: false,
      publication_authorized: false,
    });
  }
  const approvedShowPackage = await jsonRequest(baseUrl, "/api/show-package-review", {
    method: "PUT",
    body: JSON.stringify({ status: "approved", notes: "Reusable opening, closing, and CTA reviewed." }),
  });
  assert.equal(approvedShowPackage.response.status, 200);
  assert.equal(approvedShowPackage.body.approved, true);
  const savedAssembly = await jsonRequest(baseUrl, "/api/episodes/demo_episode/assembly", {
    method: "PUT",
    body: JSON.stringify({
      title: "Demo episode",
      program_start: "00:00:00.000",
      program_end: "00:01:59.500",
      shots: [
        { start: "00:00:00.000", end: "00:01:00.000", layout: "side_by_side", transition_in: { type: "cut" } },
        { start: "00:01:00.000", end: "00:01:59.500", layout: "isolated", camera_source_id: "secondary_camera", transition_in: { type: "dissolve", duration_ms: 350 } },
      ],
      opening: { use_show_default: true, voiceover_path: introVoice, trim_end_ms: 2_000 },
      closing: { use_show_default: true, audio_gain_db: -4 },
      cta_graphic: {
        use_show_default: true,
      },
      program_graphics: { enabled: true,
        lower_thirds: [5, 15, 25, 35, 45].map((second) => ({ start: `00:00:${second.toString().padStart(2, "0")}.000`, duration_ms: 8_000, host_1_name: "Host 1", host_2_name: "Host 2" })),
        topic_bars: [{ start: "00:01:00.000", title: "Reviewed topic", duration_ms: 30_000, position: "bottom" }] },
      visual_style: {
        program_fade_in_ms: 450,
        camera_framing: { enabled: true, sources: { secondary_camera: { zoom: 1.14, horizontal: -14 } } },
        side_by_side_divider: { enabled: true, width_full_px: 4, color: "#23333a" },
      },
    }),
  });
  assert.equal(savedAssembly.response.status, 200);
  assert.equal(savedAssembly.body.episode.episode_assembly.status, "review_required");
  assert.equal(savedAssembly.body.episode.episode_assembly.program.shots.length, 2);
  assert.equal(savedAssembly.body.episode.episode_assembly.program.shots[0].layout, "side_by_side");
  assert.equal(savedAssembly.body.episode.episode_assembly.cta_graphic.cues.length, 1);
  assert.equal(savedAssembly.body.episode.episode_assembly.opening.duration_source, "voiceover");
  assert.equal(savedAssembly.body.episode.episode_assembly.closing.duration_source, "voiceover");
  assert.equal(savedAssembly.body.episode.episode_assembly.show_package.sections.opening, "show_default");
  assert.equal(savedAssembly.body.episode.episode_assembly.show_package.refresh_behavior, "explicit");
  assert.equal(savedAssembly.body.episode.episode_assembly.cta_graphic.website_url, "https://example.com/podcast");
  assert.equal(savedAssembly.body.episode.episode_assembly.visual_style.side_by_side_divider.enabled, true);
  assert.equal(savedAssembly.body.episode.episode_assembly.render_authorized, false);
  const savedRecipe = savedAssembly.body.episode.episode_assembly;
  assert.equal(savedRecipe.opening.trim_end_ms, 2_000);
  assert.equal(savedRecipe.closing.audio_gain_db, -4);
  assert.equal(savedRecipe.visual_style.program_fade_in_ms, 450);
  assert.equal(savedRecipe.visual_style.camera_framing.sources.secondary_camera.horizontal, -14);
  assert.equal(savedRecipe.program_graphics.lower_thirds.length, 5);
  assert.equal(savedRecipe.program_graphics.topic_bars[0].duration_ms, 30_000);
  assert.equal(savedRecipe.program_graphics.topic_bars[0].position, "bottom");
  const platformCopy = JSON.parse(readFileSync(join(episodeDir, "episode_platform_copy.json"), "utf8"));
  assert.match(platformCopy.youtube.description_lines[0], /https:\/\/example\.com\/podcast/);
  assert.match(platformCopy.spotify.show_notes_html, /Explore AI Out Loud/);
  assert.equal(platformCopy.publication_authorized, false);
  const approvedAssembly = await jsonRequest(baseUrl, "/api/episodes/demo_episode/assembly-review", {
    method: "PUT",
    body: JSON.stringify({ status: "approved", notes: "Camera cuts and package reviewed." }),
  });
  assert.equal(approvedAssembly.response.status, 400);
  assert.match(approvedAssembly.body.error, /build and apply the current source-bound camera plan/);
  assert.equal(JSON.parse(readFileSync(join(episodeDir, "episode_assembly.json"), "utf8")).program.shots[1].camera_source_id, "secondary_camera");
  const blockedSpeakerTranscript = await jsonRequest(baseUrl, "/api/episodes/demo_episode/speaker-transcript", {
    method: "POST",
    body: "{}",
  });
  assert.equal(blockedSpeakerTranscript.response.status, 400);
  assert.match(blockedSpeakerTranscript.body.error, /isolated audio are required/);

  const currentTimeline = JSON.parse(readFileSync(join(episodeDir, "timeline.json"), "utf8"));
  writeJson(join(episodeDir, "speaker_transcript.json"), {
    schema: "eaol-speaker-transcript-v1",
    status: "review_required",
    generated_at: "2026-08-16T12:45:00.000Z",
    timeline_generated_at: currentTimeline.generated_at,
    input_signatures: [primaryReceipt, secondaryReceipt].map(manifestSourceSignature),
    model: "test-model",
    speakers: [
      { source_id: "host_1_audio", speaker_id: "host_1", speaker_label: "Host 1", segment_count: 1 },
      { source_id: "host_2_audio", speaker_id: "host_2", speaker_label: "Host 2", segment_count: 1 },
    ],
    overlap_count: 0,
    overlaps: [],
    segments: [
      { speaker_id: "host_1", speaker_label: "Host 1", source_id: "host_1_audio", start_ms: 10_000, end_ms: 20_000, start: "00:00:10.000", end: "00:00:20.000", text: "This is the wrong wording." },
      { speaker_id: "host_2", speaker_label: "Host 2", source_id: "host_2_audio", start_ms: 20_000, end_ms: 40_000, start: "00:00:20.000", end: "00:00:40.000", text: "You can start with one workflow, inspect the result, and improve only the step that broke." },
    ],
  });
  const unreviewedSpeaker = await jsonRequest(baseUrl, "/api/episodes/demo_episode");
  assert.equal(unreviewedSpeaker.body.episode.transcript_mode, "speaker");
  assert.equal(unreviewedSpeaker.body.episode.transcript_review_ready, false);
  assert.equal(unreviewedSpeaker.body.episode.transcript[0].segment_id, "segment_0001");
  assert.equal(unreviewedSpeaker.body.episode.cta_cues.review_stale, true);
  assert.equal(unreviewedSpeaker.body.episode.cta_cues.confirmed_count, 0);
  assert.equal(unreviewedSpeaker.body.episode.cta_cues.manifest_current, false);
  assert.equal(unreviewedSpeaker.body.episode.episode_assembly.stale, true);
  assert.equal(unreviewedSpeaker.body.episode.episode_assembly_review.status, "unavailable");
  const blockedCandidateApproval = await jsonRequest(baseUrl, "/api/episodes/demo_episode/review/clip_001", {
    method: "PUT",
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(blockedCandidateApproval.response.status, 400);
  assert.match(blockedCandidateApproval.body.error, /review and confirm the current speaker transcript/);
  const correctedSpeaker = await jsonRequest(baseUrl, "/api/episodes/demo_episode/speaker-transcript-review", {
    method: "PUT",
    body: JSON.stringify({
      status: "draft",
      roles_swapped: true,
      edits: { segment_0001: "This is the corrected wording." },
    }),
  });
  assert.equal(correctedSpeaker.response.status, 200);
  assert.equal(correctedSpeaker.body.episode.transcript[0].speaker_label, "Host 2");
  assert.equal(correctedSpeaker.body.episode.transcript[0].text, "This is the corrected wording.");
  assert.equal(correctedSpeaker.body.episode.candidates[0].review.status, "proposed");
  assert.match(readFileSync(join(episodeDir, "speaker_transcript_review.srt"), "utf8"), /\[Host 2\] This is the corrected wording\./);
  const approvedSpeakerReview = await jsonRequest(baseUrl, "/api/episodes/demo_episode/speaker-transcript-review", {
    method: "PUT",
    body: JSON.stringify({
      status: "approved",
      roles_swapped: true,
      edits: { segment_0001: "This is the corrected wording." },
    }),
  });
  assert.equal(approvedSpeakerReview.response.status, 200);
  assert.equal(approvedSpeakerReview.body.episode.transcript_review_ready, true);
  assert.equal(approvedSpeakerReview.body.episode.speaker_transcript_review.render_authorized, false);
  const reapprovedCandidate = await jsonRequest(baseUrl, "/api/episodes/demo_episode/review/clip_001", {
    method: "PUT",
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(reapprovedCandidate.response.status, 200);

  const generatedSocial = await jsonRequest(baseUrl, "/api/episodes/demo_episode/social-suggestions", {
    method: "POST",
    body: "{}",
  });
  assert.equal(generatedSocial.response.status, 201);
  assert.equal(generatedSocial.body.suggestions.schema, "eaol-social-suggestions-v1");
  assert.equal(generatedSocial.body.suggestions.policy.provider_calls, false);
  assert.equal(generatedSocial.body.episode.candidates.at(-1).proposed_by, "studio");
  assert.equal(generatedSocial.body.episode.candidates.at(-1).review.status, "suggested");
  assert.equal(generatedSocial.body.episode.social_state.suggestions_current, true);
  const currentSuggestions = JSON.parse(readFileSync(join(episodeDir, "social_suggestions.json"), "utf8"));
  writeJson(join(episodeDir, "social_suggestions.json"), { ...currentSuggestions, policy: { ...currentSuggestions.policy, engine: "deterministic_local_v1" } });
  const oldSuggestionPolicy = await jsonRequest(baseUrl, "/api/episodes/demo_episode");
  assert.equal(oldSuggestionPolicy.body.episode.social_state.suggestions_current, false);
  writeJson(join(episodeDir, "social_suggestions.json"), currentSuggestions);

  const renewedSyncReview = JSON.parse(readFileSync(join(episodeDir, "sync_review.json"), "utf8"));
  renewedSyncReview.reviewed_at = "2026-08-16T13:00:00.000Z";
  writeJson(join(episodeDir, "sync_review.json"), renewedSyncReview);
  const supersededTimeline = await jsonRequest(baseUrl, "/api/episodes/demo_episode");
  assert.equal(supersededTimeline.body.episode.timeline.stale, true);
  assert.equal(supersededTimeline.body.episode.timeline_preview_review.stale, true);
  assert.equal(supersededTimeline.body.episode.speaker_transcript_review.stale, true);
  assert.equal(supersededTimeline.body.episode.transcript_review_ready, false);
  assert.equal(supersededTimeline.body.episode.candidates[0].review.status, "approved");
  const rebuiltTimeline = await jsonRequest(baseUrl, "/api/episodes/demo_episode/timeline", {
    method: "POST",
    body: "{}",
  });
  assert.equal(rebuiltTimeline.response.status, 200);
  assert.equal(rebuiltTimeline.body.episode.timeline.stale, false);
  assert.equal(rebuiltTimeline.body.episode.timeline.sync_reviewed_at, "2026-08-16T13:00:00.000Z");

  writeFileSync(sourceTwo, "the-companion-source-changed");
  const staleDetail = await jsonRequest(baseUrl, "/api/episodes/demo_episode");
  assert.equal(staleDetail.body.episode.intake_stale, true);
  assert.equal(staleDetail.body.episode.sync.stale, true);
  assert.equal(staleDetail.body.episode.sync.review.status, "pending");
  assert.equal(staleDetail.body.episode.timeline.stale, true);
  const staleApproval = await jsonRequest(baseUrl, "/api/episodes/demo_episode/sync-review", {
    method: "PUT",
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(staleApproval.response.status, 400);
  assert.match(staleApproval.body.error, /changed after sync analysis/);

  console.log("PASS studio health and local-only contract");
  console.log("PASS loopback host, same-origin, JSON-only writes, and browser security headers");
  console.log("PASS static interface and episode discovery");
  console.log("PASS per-episode checklist API preserves default work and accepts episode-specific lessons");
  console.log("PASS interrupted-job recovery API and disk-space rejection");
  console.log("PASS transcript, media ranges, approval gate, candidate-edit invalidation, recovery, validation, and review state");
  console.log("PASS confirmed sync builds an editable, non-rendering timeline receipt");
  console.log("PASS aligned media preview review requires both ends and never authorizes rendering");
  console.log("PASS speaker transcription refuses to infer identity without both isolated audio roles");
  console.log("PASS speaker transcript corrections reset candidates and require explicit review approval");
  console.log("PASS deterministic social suggestion API adds transcript-bound Studio proposals without a provider call");
  console.log("PASS reviewed CTA cues produce non-rendering editor handoff files and expire with transcript changes");
  console.log("PASS reviewed two-camera assembly binds narration, CTA, and platform copy while keeping full render and proxy locked without camera evidence");
  console.log("PASS reusable show package is separately approved and explicitly inherited without authorizing publication");
  console.log("PASS changed sources expire sync and timeline approval and block stale reuse");
} finally {
  server.close();
  await once(server, "close").catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
