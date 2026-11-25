#!/usr/bin/env node
import {deliveryCopyFromWorkspace, releaseBrief, releaseBriefMarkdown} from './release_copy.mjs';
import {loadSocialWorkspace, saveSocialWorkspace, socialJobArgs, socialPreviewPath} from './social_workspace.mjs';
import {loadFinishes, finishJobArgs, finishArtifactPath} from './social_finish_workspace.mjs';
import {episodeNumber} from './release_policy.mjs';

import { createServer } from "node:http";
import {
  accessSync,
  constants,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { inside, loadRecovery, readRecoveryJson, recoveryDestination, saveRecoveryShot, saveRecoveryFraming, saveRecoveryColor, validatePackage, previewSegments, probe as probeRecoveryMedia } from "./recovery.mjs";
import { loadOpeningTransition, transitionInputs, validateTransitionSettings } from "./opening_transition.mjs";
import { loadClosingTransition, closingInputs, validateClosingSettings } from "./closing_transition.mjs";
import { loadReleaseWorkspace, saveReleaseWorkspace } from './release_workspace.mjs';
import { buildProductionWorkflow, loadWorkflowChecklist, saveWorkflowItem, workflowHandoff } from "./production_workflow.mjs";
import { loadNumberedOpening, saveNumberedOpening } from "./numbered_opening.mjs";
import { filePickerCommand, folderOpenCommand, resolveTool } from "../platform_tools.mjs";
import { loadOperatorIdentity, saveOperatorIdentity } from "./operator.mjs";
import { loadShowConfig, publicShowConfig } from "./show_config.mjs";
import {
  manifestSourceSignature,
  sourceReceiptsAreCurrent,
} from "./sync.mjs";
import { buildTimeline, timelineReceiptMatchesInputs } from "./timeline.mjs";
import { loadBrowserPreviews } from "./browser_preview.mjs";
import { speakerTranscriptMatchesInputs } from "./speaker_transcript.mjs";
import { channelPreflightMatchesInputs } from "./channel_preflight.mjs";
import { speakerActivityMatchesInputs } from "./speaker_activity.mjs";
import { buildCameraPlan, cameraPlanMatchesInputs } from "./camera_plan.mjs";
import {
  buildCameraPlanReview,
  buildCameraPlanSamples,
  cameraPlanReviewMatchesInputs,
  requiresRepresentativeCameraReview,
} from "./camera_plan_review.mjs";
import { buildTimelinePreviewReview, timelinePreviewMatchesInputs } from "./timeline_preview.mjs";
import {
  applySpeakerTranscriptReview,
  buildSpeakerTranscriptReview,
  speakerTranscriptReviewMatchesInputs,
  speakerTranscriptReviewSrt,
} from "./speaker_transcript_review.mjs";
import { buildBleedReviewAssistant } from "./bleed_review_assistant.mjs";
import { resetCandidateReviewContext } from "./review_context.mjs";
import {
  buildDiskPreflight,
  formatBytes,
  loadJobJournals,
  publicJob,
  refreshRecoveredJob,
  writeJobJournal,
} from "./job_state.mjs";
import {
  buildCtaCueState,
  buildCtaGraphicManifest,
  ctaGraphicCueSheet,
  updateCtaCueReview,
} from "./cta_cues.mjs";
import {
  buildEpisodeAssembly,
  buildEpisodeAssemblyReview,
  episodePlatformCopy,
  episodeAssemblyMatchesInputs,
  episodeAssemblyReviewMatchesPlan,
} from "./episode_assembly.mjs";
import {
  buildShowPackage,
  buildShowPackageReview,
  loadShowPackageState,
  showPackageAssets,
  showPackagePaths,
} from "./show_package.mjs";
import {
  buildEpisodeProxyReview,
  episodeProxyReviewMatches,
} from "./episode_proxy_review.mjs";
import { episodeProxyAuditMatches } from "./episode_proxy_audit.mjs";
import { deliveryAudioMatchesRender } from "./delivery_audio.mjs";
import {
  deliveryTextMatchesInputs,
  suggestChapterLines,
  writeDeliveryText,
} from "./delivery_text.mjs";
import {
  buildDerivedTrack,
  reviewSequenceSeam,
} from "./audio_sequence.mjs";
import { buildCompatibility, logicalSourceFromSequence } from "./ingest.mjs";
import {
  addEpisodeChecklistItem,
  checklistSummary,
  loadEpisodeChecklist,
  saveEpisodeChecklist,
  updateEpisodeChecklistItem,
} from "./episode_checklist.mjs";
import {
  buildEpisodeNamingApproval,
  buildEpisodeNamingRequest,
  buildHumanEpisodeNamingProposal,
  EPISODE_NAMING_POLICY,
  EPISODE_NAMING_POLICY_VERSION,
  episodeNamingPolicyFingerprint,
  episodeNamingState,
  validateEpisodeNamingProposal,
} from "./episode_naming.mjs";
import { buildSocialSuggestions, SOCIAL_SUGGESTION_ENGINE } from "./social_suggestions.mjs";
import { SOCIAL_QUALITY_VERSION } from "./social_captions.mjs";
import { buildSocialEditPlan } from "./social_edit_plan.mjs";
import { buildSocialPostKit } from "./social_post_kit.mjs";
import {
  buildSocialPackageReview,
  buildSocialRenderReview,
  socialPackageReviewMatches,
  socialRenderReviewMatches,
  writeSocialDelivery,
} from "./social_delivery.mjs";

const STUDIO_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = dirname(STUDIO_DIR);
const ALLOWED_VIDEO = new Set([".mp4", ".mov", ".m4v", ".mkv"]);
const ALLOWED_AUDIO = new Set([".wav", ".m4a", ".mp3", ".flac", ".aac"]);
const ALLOWED_IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const REVIEW_STATUSES = new Set(["pending", "approved", "rejected"]);
const CLIP_REVIEW_STATUSES = new Set(["suggested", "proposed", "needs_discussion", "approved", "rejected"]);
const CANDIDATE_PROPOSERS = new Set(["host_1", "host_2", "studio"]);
const CANDIDATE_ORIGINS = new Set(["human", "suggestion", "suggestion_revised"]);
const CANDIDATE_CATEGORIES = new Set([
  "thesis", "takeaway", "story", "disagreement", "surprising_fact", "myth_correction",
  "explainer", "question", "evergreen", "timely", "teaser",
]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i;
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const FFPROBE = resolveTool("ffprobe");

function isReadableFile(path) {
  if (!path) return false;
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertTrustedRequest(req, pathname) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!LOOPBACK_HOST.test(host)) {
    throw requestError(403, "Studio accepts requests only through its local address");
  }
  if (!pathname.startsWith("/api/")) return;

  const origin = String(req.headers.origin || "");
  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw requestError(403, "cross-site requests are not allowed");
    }
    if (parsed.protocol !== "http:" || parsed.host.toLowerCase() !== host) {
      throw requestError(403, "cross-site requests are not allowed");
    }
  }

  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite && !new Set(["same-origin", "none"]).has(fetchSite)) {
    throw requestError(403, "cross-site requests are not allowed");
  }

  if (MUTATING_METHODS.has(req.method || "")) {
    const contentType = String(req.headers["content-type"] || "");
    if (!/^application\/json(?:;|$)/i.test(contentType)) {
      throw requestError(415, "write requests must use application/json");
    }
  }
}

function boundedText(value, label, maximum, { required = false } = {}) {
  const result = String(value ?? "").trim();
  if (required && !result) throw new Error(`${label} is required`);
  if (result.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer`);
  return result;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request is too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function readJsonFile(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function signaturesMatch(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function syncReceiptMatchesSources(receipt, intake) {
  if (!receipt || !intake || !sourceReceiptsAreCurrent(intake.sources || [])) return false;
  const expected = (intake.sources || []).map(manifestSourceSignature);
  return signaturesMatch(receipt.input_signatures, expected);
}

function requireCurrentIntake(intake, { requireTranscript = false } = {}) {
  if (intake && !sourceReceiptsAreCurrent(intake.sources || [])) {
    throw new Error("source files changed after intake; run source checks again before reviewing or rendering");
  }
  if (intake?.compatibility?.status === "blocked") {
    throw new Error("source intake has blocking problems; fix them before reviewing or rendering");
  }
  const pendingSequence = Object.values(intake?.audio_sequences || {}).find((sequence) => !sequence.ready);
  if (pendingSequence) {
    throw new Error(`${pendingSequence.label} still needs part-order and seam approval; finish split-audio review before downstream work`);
  }
  if (requireTranscript && ["blocked", "failed", "not_run", "pending"].includes(intake?.transcription?.status)) {
    throw new Error("the Host 1 transcript is not current; complete source intake before reviewing or rendering");
  }
}

function speakerReviewContext(dir) {
  const manifest = readJsonFile(join(dir, "episode.json"), null);
  const syncReceipt = readJsonFile(join(dir, "sync.json"), null);
  const syncReview = readJsonFile(join(dir, "sync_review.json"), null);
  const timeline = readJsonFile(join(dir, "timeline.json"), null);
  const speakerTranscript = readJsonFile(join(dir, "speaker_transcript.json"), null);
  const review = readJsonFile(join(dir, "speaker_transcript_review.json"), null);
  const timelineCurrent = timelineReceiptMatchesInputs(timeline, manifest, syncReceipt, syncReview);
  const speakerCurrent = Boolean(timelineCurrent
    && speakerTranscriptMatchesInputs(speakerTranscript, manifest, timeline));
  const reviewCurrent = Boolean(speakerCurrent
    && speakerTranscriptReviewMatchesInputs(review, speakerTranscript, manifest, timeline));
  return { manifest, timeline, speakerTranscript, review, timelineCurrent, speakerCurrent, reviewCurrent };
}

function requireCurrentReviewContext(dir) {
  const context = speakerReviewContext(dir);
  requireCurrentIntake(context.manifest, { requireTranscript: true });
  if (context.speakerTranscript && !context.speakerCurrent) {
    throw new Error("the speaker transcript has expired; rebuild and review it before changing candidates or rendering");
  }
  if (context.speakerCurrent && (!context.reviewCurrent || context.review.status !== "approved")) {
    throw new Error("review and confirm the current speaker transcript before changing candidates or rendering");
  }
  return context;
}

function speakerCorrectionKey(review) {
  return JSON.stringify({
    roles_swapped: Boolean(review?.roles_swapped),
    edits: review?.edits || {},
    speaker_overrides: review?.speaker_overrides || {},
    dismissed_segment_ids: review?.dismissed_segment_ids || [],
  });
}

function parseSrt(text) {
  const blocks = text.replace(/\r/g, "").trim().split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) continue;
    const match = lines[1].match(/^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/);
    if (!match) continue;
    cues.push({
      index: Number(lines[0]),
      start: match[1].replace(",", "."),
      end: match[2].replace(",", "."),
      text: lines.slice(2).join(" ").trim(),
    });
  }
  return cues;
}

function timestampMs(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(String(value || ""));
  if (!match) return null;
  const [, h, m, s, ms] = match.map(Number);
  if (m > 59 || s > 59) return null;
  return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

function safeEpisodeDir(workRoot, slug) {
  if (!/^[a-z0-9_]+$/.test(slug || "")) throw new Error("invalid episode identifier");
  const dir = resolve(workRoot, slug);
  const rootPrefix = `${resolve(workRoot)}${sep}`;
  if (!dir.startsWith(rootPrefix)) throw new Error("episode path leaves the work folder");
  if (!existsSync(dir)) throw new Error("episode not found");
  return dir;
}

function validateClipDocument(doc, slug, meta, probe) {
  if (!doc || !["eaol-clips-v1", "eaol-clips-v2"].includes(doc.schema)) {
    throw new Error('schema must be "eaol-clips-v1" or "eaol-clips-v2"');
  }
  if (doc.source_slug !== slug) throw new Error("source episode does not match this work folder");
  boundedText(doc.selected_by, "selected_by", 120, { required: true });
  if (!Array.isArray(doc.clips) || doc.clips.length === 0) throw new Error("add at least one candidate");
  const durationMs = Math.round(Number(meta.duration_sec || probe?.format?.duration || 0) * 1000);
  const video = (probe?.streams || []).find((stream) => stream.codec_type === "video");
  if (!durationMs || !video) throw new Error("episode metadata is incomplete");
  const cropWidth = Math.floor((video.height * 9) / 16 / 2) * 2;
  const seen = new Set();
  for (const clip of doc.clips) {
    if (!/^clip_\d{3}$/.test(clip.id || "")) throw new Error("candidate IDs must look like clip_001");
    if (seen.has(clip.id)) throw new Error(`duplicate candidate ${clip.id}`);
    seen.add(clip.id);
    const start = timestampMs(clip.start);
    const end = timestampMs(clip.end);
    if (start === null || end === null) throw new Error(`${clip.id} needs timestamps like 00:01:23.456`);
    if (end <= start) throw new Error(`${clip.id} must end after it starts`);
    const seconds = (end - start) / 1000;
    if (seconds < 15 || seconds > 90) throw new Error(`${clip.id} must run 15–90 seconds`);
    if (end > durationMs) throw new Error(`${clip.id} ends after the recording`);
    boundedText(clip.title, `${clip.id} title`, 120, { required: true });
    boundedText(clip.hook, `${clip.id} hook`, 500, { required: true });
    boundedText(clip.rationale, `${clip.id} rationale`, 1_000, { required: true });
    if ("hook_overlay" in clip && !String(clip.hook_overlay || "").trim()) {
      throw new Error(`${clip.id} has an empty hook overlay`);
    }
    if ("hook_overlay" in clip) boundedText(clip.hook_overlay, `${clip.id} hook overlay`, 80, { required: true });
    if (doc.schema === "eaol-clips-v2") {
      if (!Array.isArray(clip.segment_ids)) throw new Error(`${clip.id} segment_ids must be an array`);
      for (const segmentId of clip.segment_ids) boundedText(segmentId, `${clip.id} segment ID`, 120, { required: true });
      if ("proposed_by" in clip && !CANDIDATE_PROPOSERS.has(clip.proposed_by)) throw new Error(`${clip.id} proposed_by is invalid`);
      if ("proposed_at" in clip && !Number.isFinite(Date.parse(clip.proposed_at))) throw new Error(`${clip.id} proposed_at must be an ISO timestamp`);
      if ("origin" in clip && !CANDIDATE_ORIGINS.has(clip.origin)) throw new Error(`${clip.id} origin is invalid`);
      if (!CANDIDATE_CATEGORIES.has(clip.category)) throw new Error(`${clip.id} category is invalid`);
      if ("cluster_id" in clip) boundedText(clip.cluster_id, `${clip.id} cluster ID`, 120, { required: true });
      for (const field of ["signals", "flags", "boundary_notes"]) {
        if (field in clip && !Array.isArray(clip[field])) throw new Error(`${clip.id} ${field} must be an array`);
      }
      if ("recommendation" in clip && !["recommended", "alternate"].includes(clip.recommendation)) {
        throw new Error(`${clip.id} recommendation is invalid`);
      }
      if ("speaker_balance" in clip && !Array.isArray(clip.speaker_balance)) throw new Error(`${clip.id} speaker_balance must be an array`);
    }
    const offset = clip.crop_offset_px ?? 0;
    if (!Number.isInteger(offset)) throw new Error(`${clip.id} crop offset must be a whole number`);
    const x = Math.round((video.width - cropWidth) / 2) + offset;
    if (x < 0 || x + cropWidth > video.width) throw new Error(`${clip.id} crop leaves the source frame`);
  }
}

function clipContentKey(clip) {
  return JSON.stringify({
    start: clip.start,
    end: clip.end,
    title: clip.title,
    hook: clip.hook,
    rationale: clip.rationale,
    crop_offset_px: clip.crop_offset_px ?? 0,
    hook_overlay: clip.hook_overlay || null,
    segment_ids: clip.segment_ids || [],
    proposed_by: clip.proposed_by || null,
    proposed_at: clip.proposed_at || null,
    origin: clip.origin || null,
    category: clip.category || null,
    cluster_id: clip.cluster_id || null,
    signals: clip.signals || [],
    flags: clip.flags || [],
    boundary_notes: clip.boundary_notes || [],
    recommendation: clip.recommendation || null,
    speaker_balance: clip.speaker_balance || [],
  });
}

function loadReview(dir, clips = []) {
  const saved = readJsonFile(join(dir, "studio_review.json"), { schema: "eaol-review-v1", clips: {} });
  const states = {};
  for (const clip of clips) {
    const state = saved?.clips?.[clip.id] || {};
    const savedStatus = state.status === "pending" ? (clip.proposed_by === "studio" ? "suggested" : "proposed") : state.status;
    states[clip.id] = {
      status: CLIP_REVIEW_STATUSES.has(savedStatus) ? savedStatus : (clip.proposed_by === "studio" ? "suggested" : "proposed"),
      notes: String(state.notes || ""),
      invalidated_at: state.invalidated_at || null,
      reviewed_by: CANDIDATE_PROPOSERS.has(state.reviewed_by) ? state.reviewed_by : null,
      reviewed_at: state.reviewed_at || null,
      discussion: Array.isArray(state.discussion) ? state.discussion : [],
    };
  }
  return { schema: "eaol-review-v2", clips: states, updated_at: saved?.updated_at || null };
}

function outputReceipt(file) {
  if (!existsSync(file)) return null;
  const result = spawnSync(
    FFPROBE,
    ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt", "-of", "json", file],
    { encoding: "utf8" },
  );
  const stat = statSync(file);
  const bytes = stat.size;
  const modified_ms = Math.round(stat.mtimeMs);
  if (result.status !== 0) return { file: basename(file), bytes, modified_ms, probe_error: true };
  try {
    const probe = JSON.parse(result.stdout);
    const video = (probe.streams || []).find((stream) => stream.codec_type === "video");
    const audio = (probe.streams || []).find((stream) => stream.codec_type === "audio");
    return {
      file: basename(file),
      bytes,
      duration_sec: Number(probe.format?.duration || 0),
      width: video?.width || null,
      height: video?.height || null,
      video_codec: video?.codec_name || null,
      audio_codec: audio?.codec_name || null,
      pixel_format: video?.pix_fmt || null,
      modified_ms,
    };
  } catch {
    return { file: basename(file), bytes, modified_ms, probe_error: true };
  }
}

function assemblyAssetReceipt(rawPath, kind) {
  const value = String(rawPath || "").trim();
  if (!value) return null;
  const path = normalizeUserPath(value);
  if (!isReadableFile(path)) throw new Error(`${kind} asset was not found or is not readable`);
  const extension = extname(path).toLowerCase();
  const allowed = kind === "audio" ? ALLOWED_AUDIO : new Set([...ALLOWED_VIDEO, ...ALLOWED_IMAGE]);
  if (!allowed.has(extension)) {
    throw new Error(kind === "audio"
      ? "choose WAV, M4A, MP3, FLAC, or AAC for music"
      : "choose MP4, MOV, M4V, MKV, PNG, JPG, or WEBP for a visual asset");
  }
  const stat = statSync(path);
  return {
    path,
    file: basename(path),
    kind: kind === "audio" ? "audio" : ALLOWED_VIDEO.has(extension) ? "video" : "image",
    bytes: stat.size,
    modified_ms: Math.round(stat.mtimeMs),
  };
}

function writeLocalStudioJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function socialTranscriptFingerprint(transcript, review) {
  return createHash("sha256").update(JSON.stringify({
    transcript: (transcript || []).filter((segment) => !segment.dismissed_as_bleed).map((segment) => ({
      segment_id: segment.segment_id || null,
      speaker_id: segment.speaker_id || null,
      start_ms: Number(segment.start_ms),
      end_ms: Number(segment.end_ms),
      text: String(segment.text || ""),
    })),
    review_updated_at: review?.updated_at || null,
  })).digest("hex");
}

function loadEpisodeNamingPolicy() {
  return {
    version: EPISODE_NAMING_POLICY_VERSION,
    fingerprint: episodeNamingPolicyFingerprint(EPISODE_NAMING_POLICY),
  };
}

function suggestedEpisodeNumber(slug, intake, request = null) {
  if (Number.isInteger(Number(request?.episode_number)) && Number(request.episode_number) > 0) {
    return Number(request.episode_number);
  }
  const candidates = [slug];
  for (const value of candidates) {
    const match = String(value).match(/(?:^|[\\/])ep(\d{3,4})(?:_|[\\/]|$)/i)
      || String(value).match(/^ep(\d{3,4})(?:_|$)/i);
    if (match && Number(match[1]) > 0) return Number(match[1]);
  }
  return null;
}

function previousApprovedEpisodeTitles(workRoot, currentSlug) {
  if (!existsSync(workRoot)) return [];
  return [...new Set(readdirSync(workRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== currentSlug)
    .map((entry) => readJsonFile(join(workRoot, entry.name, "episode_naming_approval.json"), null)?.canonical_title)
    .filter(Boolean))];
}

function publicEpisodeNamingState(state, suggestedNumber) {
  return {
    ...state,
    suggested_episode_number: suggestedNumber,
    request: state.request ? {
      schema: state.request.schema,
      source_slug: state.request.source_slug,
      episode_number: state.request.episode_number,
      production_id: state.request.production_id,
      created_at: state.request.created_at,
      policy: state.request.policy,
      transcript_fingerprint: state.request.transcript_fingerprint,
      request_fingerprint: state.request.request_fingerprint,
      transcript_count: state.request.transcript?.length || 0,
      stale: state.request.stale,
    } : null,
  };
}

function inheritedPackageSection(bodySection, showSection, label) {
  if (!showSection?.visual) throw new Error(`the approved show package has no ${label} visual`);
  const episodeVoiceover = showSection.narration_mode === "episode_specific"
    ? assemblyAssetReceipt(bodySection?.voiceover_path, "audio")
    : showSection.voiceover;
  return {
    visual: showSection.visual,
    voiceover: episodeVoiceover,
    music: showSection.music,
  };
}

function resolveAssemblyPackageDraft(body, showState) {
  const sectionModes = {
    opening: body.opening?.use_show_default === true ? "show_default" : "episode_override",
    closing: body.closing?.use_show_default === true ? "show_default" : "episode_override",
    cta_graphic: body.cta_graphic?.use_show_default === true ? "show_default" : "episode_override",
    newsletter_cta: body.newsletter_cta?.use_show_default === true ? "show_default" : "episode_override",
  };
  const inherits = Object.values(sectionModes).includes("show_default");
  if (inherits && !showState.approved) {
    throw new Error("approve the current reusable show package before inheriting it into an episode");
  }
  const preset = showState.show_package;
  const opening = sectionModes.opening === "show_default"
    ? inheritedPackageSection(body.opening, preset.opening, "opening")
    : {
      visual: assemblyAssetReceipt(body.opening?.visual_path, "visual"),
      voiceover: assemblyAssetReceipt(body.opening?.voiceover_path, "audio"),
      music: assemblyAssetReceipt(body.opening?.music_path, "audio"),
    };
  const closing = sectionModes.closing === "show_default"
    ? { ...inheritedPackageSection(body.closing, preset.closing, "closing"), audio_lead_ms: Number(body.closing?.audio_lead_ms || 0) }
    : {
      visual: assemblyAssetReceipt(body.closing?.visual_path, "visual"),
      voiceover: assemblyAssetReceipt(body.closing?.voiceover_path, "audio"),
      music: assemblyAssetReceipt(body.closing?.music_path, "audio"),
      audio_lead_ms: Number(body.closing?.audio_lead_ms || 0),
    };
  for (const [name, section] of [["opening", opening], ["closing", closing]]) {
    section.trim_end_ms = Number(body[name]?.trim_end_ms ?? 0);
    section.audio_gain_db = Number(body[name]?.audio_gain_db ?? 0);
  }
  const ctaGraphic = sectionModes.cta_graphic === "show_default" ? {
    asset: preset.cta_graphic.asset,
    website_url: preset.cta_graphic.website_url,
    website_label: preset.cta_graphic.website_label,
    actions: preset.cta_graphic.actions,
    show_during_closing: preset.cta_graphic.show_during_closing,
  } : {
    asset: assemblyAssetReceipt(body.cta_graphic?.asset_path, "visual"),
    website_url: boundedText(body.cta_graphic?.website_url, "CTA website URL", 500),
    website_label: boundedText(body.cta_graphic?.website_label, "CTA website label", 80),
    actions: Array.isArray(body.cta_graphic?.actions) ? body.cta_graphic.actions.slice(0, 3) : undefined,
    show_during_closing: body.cta_graphic?.show_during_closing !== false,
  };
  const newsletterCta = sectionModes.newsletter_cta === "show_default" ? {
    asset: preset.newsletter_cta.asset,
    website_url: preset.newsletter_cta.website_url,
    website_label: preset.newsletter_cta.website_label,
  } : {
    asset: assemblyAssetReceipt(body.newsletter_cta?.asset_path, "visual"),
    website_url: boundedText(body.newsletter_cta?.website_url, "newsletter CTA URL", 500),
    website_label: boundedText(body.newsletter_cta?.website_label, "newsletter CTA label", 80),
  };
  return {
    opening,
    closing,
    cta_graphic: ctaGraphic,
    newsletter_cta: newsletterCta,
    show_package: inherits ? {
      fingerprint: preset.fingerprint,
      reviewed_at: showState.review.reviewed_at,
      sections: sectionModes,
    } : null,
  };
}

export function loadEpisode(workRoot, slug) {
  const dir = safeEpisodeDir(workRoot, slug);
  if (existsSync(join(dir, "recovery.json"))) {
    return loadRecovery(dir);
  }
  const meta = readJsonFile(join(dir, "meta.json"), {});
  const probe = readJsonFile(join(dir, "probe.json"), {});
  const intake = readJsonFile(join(dir, "episode.json"), null);
  const syncReceipt = readJsonFile(join(dir, "sync.json"), null);
  const syncReview = readJsonFile(join(dir, "sync_review.json"), { status: "pending", notes: "", reviewed_at: null });
  const timelineReceipt = readJsonFile(join(dir, "timeline.json"), null);
  const intakeStale = Boolean(intake && !sourceReceiptsAreCurrent(intake.sources || []));
  const syncCurrent = Boolean(syncReceipt && syncReceiptMatchesSources(syncReceipt, intake));
  const syncReviewCurrent = syncReview.status === "pending"
    || signaturesMatch(syncReview.input_signatures, syncReceipt?.input_signatures);
  const sync = syncReceipt ? {
    ...syncReceipt,
    original_status: syncReceipt.status,
    status: syncCurrent ? syncReceipt.status : "stale",
    stale: !syncCurrent,
    review: syncCurrent && syncReviewCurrent
      ? syncReview
      : { status: "pending", notes: "", reviewed_at: null },
  } : null;
  const timelineCurrent = Boolean(timelineReceipt
    && timelineReceiptMatchesInputs(timelineReceipt, intake, syncReceipt, syncReview));
  const timeline = timelineReceipt ? {
    ...timelineReceipt,
    original_status: timelineReceipt.status,
    status: timelineCurrent ? timelineReceipt.status : "stale",
    stale: !timelineCurrent,
  } : null;
  const timelinePreviewReceipt = readJsonFile(join(dir, "timeline_preview_review.json"), null);
  const timelinePreviewCurrent = Boolean(timelinePreviewReceipt
    && timelineCurrent
    && timelinePreviewMatchesInputs(timelinePreviewReceipt, timeline, intake));
  const timelinePreviewReview = timelinePreviewReceipt ? {
    ...timelinePreviewReceipt,
    original_status: timelinePreviewReceipt.status,
    status: timelinePreviewCurrent ? timelinePreviewReceipt.status : "stale",
    stale: !timelinePreviewCurrent,
  } : {
    status: "pending",
    checked_start: false,
    checked_end: false,
    notes: "",
    reviewed_at: null,
    stale: false,
    render_authorized: false,
  };
  const browserPreviews = loadBrowserPreviews(dir, intake);
  const isolatedSourceIds = new Set((intake?.sources || []).map((source) => source.id));
  const missingSpeakerSources = ["host_1_audio", "host_2_audio"].filter((id) => !isolatedSourceIds.has(id));
  const speakerReceipt = readJsonFile(join(dir, "speaker_transcript.json"), null);
  const speakerTranscriptCurrent = Boolean(speakerReceipt
    && timelineCurrent
    && speakerTranscriptMatchesInputs(speakerReceipt, intake, timeline));
  const speakerTranscript = speakerReceipt ? {
    ...speakerReceipt,
    original_status: speakerReceipt.status,
    status: speakerTranscriptCurrent ? speakerReceipt.status : "stale",
    stale: !speakerTranscriptCurrent,
  } : null;
  const speakerReviewReceipt = readJsonFile(join(dir, "speaker_transcript_review.json"), null);
  const speakerReviewCurrent = Boolean(speakerTranscriptCurrent
    && speakerTranscriptReviewMatchesInputs(speakerReviewReceipt, speakerReceipt, intake, timeline));
  const speakerTranscriptReview = speakerReviewReceipt ? {
    ...speakerReviewReceipt,
    original_status: speakerReviewReceipt.status,
    status: speakerReviewCurrent ? speakerReviewReceipt.status : "stale",
    stale: !speakerReviewCurrent,
  } : {
    status: speakerTranscriptCurrent ? "review_required" : "unavailable",
    roles_swapped: false,
    edits: {},
    speaker_overrides: {},
    dismissed_segment_ids: [],
    confirmed_overlap_pair_ids: [],
    correction_count: 0,
    reviewed_at: null,
    stale: false,
    render_authorized: false,
  };
  const speakerTranscriptState = {
    eligible: Boolean(timelineCurrent && missingSpeakerSources.length === 0 && !intakeStale),
    missing_sources: missingSpeakerSources,
    requires_timeline: !timelineCurrent,
  };
  const channelPreflightReceipt = readJsonFile(join(dir, "channel_preflight.json"), null);
  const channelPreflightCurrent = Boolean(channelPreflightReceipt
    && channelPreflightMatchesInputs(channelPreflightReceipt, intake));
  const channelPreflight = channelPreflightReceipt ? {
    ...channelPreflightReceipt,
    original_status: channelPreflightReceipt.status,
    status: channelPreflightCurrent ? channelPreflightReceipt.status : "stale",
    stale: !channelPreflightCurrent,
  } : null;
  const speakerActivityReceipt = readJsonFile(join(dir, "speaker_activity.json"), null);
  const speakerActivityCurrent = Boolean(speakerActivityReceipt
    && timelineCurrent
    && channelPreflightCurrent
    && speakerActivityMatchesInputs(speakerActivityReceipt, intake, timelineReceipt, channelPreflightReceipt));
  const speakerActivity = speakerActivityReceipt ? {
    ...speakerActivityReceipt,
    original_status: speakerActivityReceipt.status,
    status: speakerActivityCurrent ? speakerActivityReceipt.status : "stale",
    stale: !speakerActivityCurrent,
  } : null;
  const cameraPlanReceipt = readJsonFile(join(dir, "camera_decision_manifest.json"), null);
  const cameraPlanCurrent = Boolean(cameraPlanReceipt
    && speakerActivityCurrent
    && cameraPlanMatchesInputs(cameraPlanReceipt, intake, timelineReceipt, channelPreflightReceipt, speakerActivityReceipt));
  const cameraPlan = cameraPlanReceipt ? {
    ...cameraPlanReceipt,
    original_status: cameraPlanReceipt.status,
    status: cameraPlanCurrent ? cameraPlanReceipt.status : "stale",
    stale: !cameraPlanCurrent,
  } : null;
  const primarySource = intake?.sources?.find((source) => source.id === "primary_camera") || null;
  const clipDoc = readJsonFile(join(dir, "clips.json"), {
    schema: "eaol-clips-v1",
    source_slug: slug,
    selected_by: "Studio",
    clips: [],
  });
  const transcriptIsCurrent = !intake?.transcription
    || ["complete", "reused"].includes(intake.transcription.status);
  const primaryTranscript = transcriptIsCurrent && existsSync(join(dir, "transcript.srt"))
    ? parseSrt(readFileSync(join(dir, "transcript.srt"), "utf8"))
    : [];
  const transcript = speakerTranscriptCurrent
    ? applySpeakerTranscriptReview(speakerReceipt, speakerReviewCurrent ? speakerReviewReceipt : null)
      .map((segment, index) => ({ ...segment, index: index + 1 }))
    : primaryTranscript;
  const bleedReviewAssistant = speakerTranscriptCurrent
    ? buildBleedReviewAssistant(transcript, speakerReviewCurrent ? speakerReviewReceipt : null)
    : null;
  const namingPolicy = loadEpisodeNamingPolicy(DEFAULT_ROOT);
  const namingRequest = readJsonFile(join(dir, "episode_naming_request.json"), null);
  const namingProposal = readJsonFile(join(dir, "episode_naming_proposal.json"), null);
  const namingApproval = readJsonFile(join(dir, "episode_naming_approval.json"), null);
  const namingState = episodeNamingState({
    request: namingRequest,
    proposal: namingProposal,
    approval: namingApproval,
    segments: transcript,
    policyFingerprint: namingPolicy.fingerprint,
  });
  const ctaCueReview = readJsonFile(join(dir, "cta_cue_review.json"), null);
  const ctaCueManifest = readJsonFile(join(dir, "cta_graphic_manifest.json"), null);
  const ctaCues = buildCtaCueState(transcript, ctaCueReview);
  ctaCues.manifest_current = Boolean(ctaCueManifest
    && ctaCueManifest.transcript_fingerprint === ctaCues.transcript_fingerprint
    && ctaCueManifest.cue_review_updated_at === ctaCues.review_updated_at);
  const assemblyReceipt = readJsonFile(join(dir, "episode_assembly.json"), null);
  const showPackageState = loadShowPackageState(workRoot);
  const currentSignatures = (intake?.sources || []).map(manifestSourceSignature);
  const assemblyCurrent = Boolean(assemblyReceipt
    && timelineCurrent
    && timelinePreviewCurrent
    && episodeAssemblyMatchesInputs(
      assemblyReceipt,
      timeline,
      timelinePreviewReview,
      currentSignatures,
      ctaCues.manifest_current ? ctaCueManifest : null,
      cameraPlanCurrent ? cameraPlanReceipt : null,
      showPackageState.approved ? showPackageState.show_package.fingerprint : null,
      namingState.approved ? namingState.approval.approval_fingerprint : null,
    ));
  const episodeAssembly = assemblyReceipt ? {
    ...assemblyReceipt,
    original_status: assemblyReceipt.status,
    status: assemblyCurrent ? assemblyReceipt.status : "stale",
    stale: !assemblyCurrent,
  } : null;
  const assemblyReviewReceipt = readJsonFile(join(dir, "episode_assembly_review.json"), null);
  const assemblyReviewCurrent = Boolean(assemblyCurrent
    && episodeAssemblyReviewMatchesPlan(assemblyReviewReceipt, assemblyReceipt));
  const episodeAssemblyReview = assemblyReviewReceipt ? {
    ...assemblyReviewReceipt,
    original_status: assemblyReviewReceipt.status,
    status: assemblyReviewCurrent ? assemblyReviewReceipt.status : "stale",
    stale: !assemblyReviewCurrent,
  } : {
    status: assemblyCurrent ? "pending" : "unavailable",
    notes: "",
    reviewed_at: null,
    stale: false,
    render_authorized: false,
  };
  let cameraPlanSamples = null;
  if (assemblyCurrent && cameraPlanCurrent && assemblyReceipt?.camera_direction?.mode === "automatic_source_bound") {
    try {
      cameraPlanSamples = buildCameraPlanSamples({ assembly: assemblyReceipt, cameraPlan: cameraPlanReceipt });
    } catch {
      cameraPlanSamples = null;
    }
  }
  const cameraPlanReviewReceipt = readJsonFile(join(dir, "camera_plan_review.json"), null);
  const cameraPlanReviewCurrent = Boolean(cameraPlanSamples
    && cameraPlanReviewMatchesInputs(cameraPlanReviewReceipt, assemblyReceipt, cameraPlanReceipt, cameraPlanSamples));
  const cameraPlanReview = cameraPlanReviewReceipt ? {
    ...cameraPlanReviewReceipt,
    original_status: cameraPlanReviewReceipt.status,
    status: cameraPlanReviewCurrent ? cameraPlanReviewReceipt.status : "stale",
    stale: !cameraPlanReviewCurrent,
  } : {
    status: cameraPlanSamples ? "pending" : "unavailable",
    checks: {},
    previewed_sample_ids: [],
    proxy_authorized: false,
    full_render_authorized: false,
    stale: false,
  };
  const cameraTrackCount = (timelineReceipt?.tracks || []).filter((track) => track.media_kind === "video").length;
  const automaticDirectionRequired = cameraTrackCount >= 2;
  const automaticAssemblyCurrent = Boolean(assemblyCurrent
    && cameraPlanCurrent
    && assemblyReceipt?.camera_direction?.mode === "automatic_source_bound"
    && assemblyReceipt.camera_direction.camera_plan_fingerprint === cameraPlanReceipt.fingerprint);
  const cameraSampleReviewRequired = Boolean(automaticAssemblyCurrent
    && requiresRepresentativeCameraReview(assemblyReceipt));
  const cameraReviewApproved = !cameraSampleReviewRequired
    || Boolean(cameraPlanReviewCurrent && cameraPlanReviewReceipt?.status === "approved");
  const episodeProxyReceipt = readJsonFile(join(dir, "episode_proxy.json"), null);
  let episodeProxyCurrent = false;
  if (episodeProxyReceipt && automaticAssemblyCurrent && cameraReviewApproved) {
    try {
      const outputStat = statSync(episodeProxyReceipt.output?.path);
      const expectedSampleFingerprint = cameraSampleReviewRequired ? cameraPlanSamples?.fingerprint : null;
      episodeProxyCurrent = episodeProxyReceipt.status === "complete"
        && episodeProxyReceipt.quality === "proxy"
        && episodeProxyReceipt.assembly_fingerprint === assemblyReceipt.plan_fingerprint
        && episodeProxyReceipt.camera_plan_fingerprint === cameraPlanReceipt.fingerprint
        && episodeProxyReceipt.camera_plan_review_required === cameraSampleReviewRequired
        && episodeProxyReceipt.camera_plan_sample_set_fingerprint === expectedSampleFingerprint
        && outputStat.isFile()
        && outputStat.size === Number(episodeProxyReceipt.output?.bytes)
        && Math.round(outputStat.mtimeMs) === Number(episodeProxyReceipt.output?.modified_ms)
        && Object.values(episodeProxyReceipt.checks || {}).every(Boolean);
    } catch {
      episodeProxyCurrent = false;
    }
  }
  const episodeProxy = episodeProxyReceipt ? {
    ...episodeProxyReceipt,
    original_status: episodeProxyReceipt.status,
    status: episodeProxyCurrent ? episodeProxyReceipt.status : "stale",
    stale: !episodeProxyCurrent,
  } : null;
  const episodeProxyAuditReceipt = readJsonFile(join(dir, "episode_proxy_audit.json"), null);
  const episodeProxyAuditCurrent = Boolean(episodeProxyCurrent
    && episodeProxyAuditMatches(episodeProxyAuditReceipt, episodeProxyReceipt));
  const episodeProxyAudit = episodeProxyAuditReceipt ? {
    ...episodeProxyAuditReceipt,
    original_status: episodeProxyAuditReceipt.status,
    status: episodeProxyAuditCurrent ? episodeProxyAuditReceipt.status : "stale",
    stale: !episodeProxyAuditCurrent,
  } : {
    status: episodeProxyCurrent ? "pending" : "unavailable",
    checks: {},
    acceptance_eligible: false,
    stale: false,
  };
  const episodeProxyReviewReceipt = readJsonFile(join(dir, "episode_proxy_review.json"), null);
  const episodeProxyReviewCurrent = Boolean(episodeProxyCurrent
    && episodeProxyReviewMatches(episodeProxyReviewReceipt, episodeProxyReceipt, episodeProxyAuditReceipt));
  const episodeProxyReview = episodeProxyReviewReceipt ? {
    ...episodeProxyReviewReceipt,
    original_status: episodeProxyReviewReceipt.status,
    status: episodeProxyReviewCurrent ? episodeProxyReviewReceipt.status : "stale",
    stale: !episodeProxyReviewCurrent,
  } : {
    status: episodeProxyCurrent ? "pending" : "unavailable",
    checks: {},
    notes: "",
    reviewed_at: null,
    full_render_authorized: false,
    publication_authorized: false,
    stale: false,
  };
  const proxyReviewApproved = Boolean(episodeProxyReviewCurrent
    && episodeProxyReviewReceipt?.status === "approved"
    && episodeProxyReviewReceipt.full_render_authorized === true);
  const episodeRenderReceipt = readJsonFile(join(dir, "episode_render.json"), null);
  let episodeRenderCurrent = false;
  if (episodeRenderReceipt && assemblyCurrent && assemblyReviewCurrent
    && assemblyReviewReceipt?.status === "approved"
    && (!automaticDirectionRequired || proxyReviewApproved)) {
    try {
      const outputStat = statSync(episodeRenderReceipt.output?.path);
      episodeRenderCurrent = episodeRenderReceipt.status === "complete"
        && episodeRenderReceipt.quality === "full"
        && episodeRenderReceipt.assembly_fingerprint === assemblyReceipt.plan_fingerprint
        && (!automaticDirectionRequired || episodeRenderReceipt.camera_plan_fingerprint === cameraPlanReceipt.fingerprint)
        && outputStat.isFile()
        && outputStat.size === Number(episodeRenderReceipt.output?.bytes)
        && Math.round(outputStat.mtimeMs) === Number(episodeRenderReceipt.output?.modified_ms)
        && Object.values(episodeRenderReceipt.checks || {}).every(Boolean);
    } catch {
      episodeRenderCurrent = false;
    }
  }
  const episodeRender = episodeRenderReceipt ? {
    ...episodeRenderReceipt,
    original_status: episodeRenderReceipt.status,
    status: episodeRenderCurrent ? episodeRenderReceipt.status : "stale",
    stale: !episodeRenderCurrent,
  } : null;
  const deliveryAudioReceipt = readJsonFile(join(dir, "delivery_audio.json"), null);
  const deliveryAudioCurrent = Boolean(episodeRenderCurrent
    && deliveryAudioMatchesRender(deliveryAudioReceipt, episodeRenderReceipt));
  const deliveryAudio = deliveryAudioReceipt ? {
    ...deliveryAudioReceipt,
    original_status: deliveryAudioReceipt.status,
    status: deliveryAudioCurrent ? deliveryAudioReceipt.status : "stale",
    stale: !deliveryAudioCurrent,
  } : null;
  const deliveryTextReceipt = readJsonFile(join(dir, "delivery_text.json"), null);
  const deliveryTextCurrent = Boolean(episodeRenderCurrent
    && speakerReviewCurrent
    && speakerReviewReceipt?.status === "approved"
    && deliveryTextMatchesInputs(deliveryTextReceipt, episodeRenderReceipt, speakerReceipt, speakerReviewReceipt));
  const deliveryText = deliveryTextReceipt ? {
    ...deliveryTextReceipt,
    original_status: deliveryTextReceipt.status,
    status: deliveryTextCurrent ? deliveryTextReceipt.status : "stale",
    stale: !deliveryTextCurrent,
  } : null;
  let platformCopyReceipt=null,deliveryCopyError=null;
  try {platformCopyReceipt=deliveryCopyFromWorkspace(dir,episodeRenderReceipt,assemblyReceipt,readJsonFile(join(dir,"episode_platform_copy.json"),null),deliveryTextReceipt);}
  catch(error) {deliveryCopyError=error.message;}
  const openingDurationMs = Math.round(Number((episodeRenderReceipt?.segments || [])
    .find((segment) => segment.type === "opening")?.duration_sec || 0) * 1_000);
  const deliveryTextSuggestedChapters = episodeRenderCurrent
    ? suggestChapterLines(Math.round(Number(episodeRenderReceipt.output?.duration_sec || 0) * 1_000), openingDurationMs, episodeAssembly?.naming?.episode_number)
    : [];
  const episodeChecklist = loadEpisodeChecklist(dir, {
    slug,
    title: namingState.approved
      ? namingState.approval.canonical_title
      : episodeAssembly?.title || basename(meta.source || primarySource?.path || slug),
  });
  const review = loadReview(dir, clipDoc.clips || []);
  const transcriptFingerprint = socialTranscriptFingerprint(transcript, speakerReviewCurrent ? speakerReviewReceipt : null);
  const socialSuggestionsReceipt = readJsonFile(join(dir, "social_suggestions.json"), null);
  const socialSuggestionsCurrent = Boolean(socialSuggestionsReceipt
    && socialSuggestionsReceipt.policy?.engine === SOCIAL_SUGGESTION_ENGINE
    && socialSuggestionsReceipt.transcript_fingerprint === transcriptFingerprint
    && socialSuggestionsReceipt.speaker_activity_fingerprint === (speakerActivityCurrent ? speakerActivityReceipt?.fingerprint : null)
    && socialSuggestionsReceipt.assembly_fingerprint === (assemblyCurrent ? assemblyReceipt?.plan_fingerprint : null));
  const socialEditPlans = readJsonFile(join(dir, "social_edit_plans.json"), { schema: "eaol-social-edit-plans-v1", plans: {} });
  const socialRenderReceipts = readJsonFile(join(dir, "social_render_receipts.json"), { schema: "eaol-social-render-receipts-v1", renders: {} });
  const socialRenderReviews = readJsonFile(join(dir, "social_render_review.json"), { schema: "eaol-social-render-reviews-v1", clips: {} });
  const socialPackages = readJsonFile(join(dir, "social_packaging.json"), { schema: "eaol-social-packages-v2", clips: {} });
  const socialPackageReviews = readJsonFile(join(dir, "social_package_review.json"), { schema: "eaol-social-package-reviews-v1", clips: {} });
  const socialDeliveryReceipt = readJsonFile(join(dir, "social_delivery.json"), null);
  const candidateResetMs = Date.parse(intake?.candidate_context_reset_at || "") || 0;
  const candidates = (clipDoc.clips || []).map((clip) => {
    const output = outputReceipt(join(dir, "clips", `${clip.id}.mp4`));
    const clipResetMs = Date.parse(review.clips[clip.id]?.invalidated_at || "") || 0;
    if (output && output.modified_ms <= Math.max(candidateResetMs, clipResetMs)) output.stale = true;
    const editPlan = socialEditPlans.plans?.[clip.id] || null;
    const renderReceipt = socialRenderReceipts.renders?.[clip.id] || null;
    const renderCurrent = Boolean(editPlan?.fingerprint
      && editPlan.quality_policy_version === SOCIAL_QUALITY_VERSION
      && renderReceipt?.quality_policy_version === SOCIAL_QUALITY_VERSION
      && renderReceipt?.edit_plan_fingerprint === editPlan.fingerprint
      && output && !output.stale
      && output.bytes === Number(renderReceipt.output?.bytes)
      && output.modified_ms === Number(renderReceipt.output?.modified_ms));
    const renderReview = socialRenderReviews.clips?.[clip.id] || null;
    const renderReviewCurrent = renderCurrent && socialRenderReviewMatches(renderReview, renderReceipt);
    const socialPackage = socialPackages.clips?.[clip.id] || null;
    const packageCurrent = Boolean(renderReviewCurrent
      && socialPackage?.source?.master?.sha256 === renderReceipt?.output?.sha256);
    const packageReview = socialPackageReviews.clips?.[clip.id] || null;
    const packageReviewCurrent = packageCurrent && socialPackageReviewMatches(packageReview, socialPackage);
    return {
      ...clip,
      review: review.clips[clip.id] || { status: "pending", notes: "" },
      output,
      social_edit_plan: editPlan ? { ...editPlan, stale: !renderCurrent && Boolean(renderReceipt) } : null,
      social_render: renderReceipt ? { ...renderReceipt, stale: !renderCurrent } : null,
      social_render_review: renderReview ? { ...renderReview, stale: !renderReviewCurrent } : null,
      social_package: socialPackage ? { ...socialPackage, stale: !packageCurrent } : null,
      social_package_review: packageReview ? { ...packageReview, stale: !packageReviewCurrent } : null,
    };
  });
  return {
    slug,
    source_name: basename(meta.source || primarySource?.path || slug),
    episode_title: namingState.approved
      ? namingState.approval.canonical_title
      : episodeAssembly?.title || basename(meta.source || primarySource?.path || slug),
    source_path: meta.source || primarySource?.path || null,
    source_available: isReadableFile(meta.source || primarySource?.path),
    duration_sec: Number(meta.duration_sec || primarySource?.duration_sec || probe?.format?.duration || 0),
    model: meta.model || null,
    transcribed_at: meta.transcribed_at || intake?.analyzed_at || null,
    intake,
    intake_stale: intakeStale,
    sync,
    timeline,
    timeline_preview_review: timelinePreviewReview,
    browser_previews: browserPreviews,
    speaker_transcript: speakerTranscript,
    speaker_transcript_review: speakerTranscriptReview,
    speaker_transcript_state: speakerTranscriptState,
    channel_preflight: channelPreflight,
    speaker_activity: speakerActivity,
    camera_plan: cameraPlan,
    camera_plan_samples: cameraPlanSamples,
    camera_plan_review: cameraPlanReview,
    camera_direction_state: {
      channel_eligible: Boolean(intake && !intakeStale),
      speaker_activity_eligible: Boolean(timelineCurrent && channelPreflightCurrent && channelPreflightReceipt?.status === "passed"),
      camera_plan_eligible: Boolean(speakerActivityCurrent && (timelineReceipt?.tracks || []).filter((track) => track.media_kind === "video").length >= 2),
      automatic_camera_ready: Boolean(cameraPlanCurrent && cameraPlanReceipt?.status === "review_required"),
      render_authorized: false,
      proxy_authorized: Boolean(automaticAssemblyCurrent && cameraReviewApproved),
      camera_plan_review_required: cameraSampleReviewRequired,
    },
    transcript_mode: speakerTranscriptCurrent ? "speaker" : "primary",
    transcript_review_ready: !speakerReceipt
      || (speakerTranscriptCurrent && speakerReviewCurrent && speakerReviewReceipt.status === "approved"),
    primary_transcript_count: primaryTranscript.length,
    transcript,
    bleed_review_assistant: bleedReviewAssistant,
    episode_naming: publicEpisodeNamingState(
      namingState,
      suggestedEpisodeNumber(slug, intake, namingRequest),
    ),
    cta_cues: ctaCues,
    episode_assembly: episodeAssembly,
    episode_assembly_review: episodeAssemblyReview,
    episode_render: episodeRender,
    delivery_audio: deliveryAudio,
    delivery_text: deliveryText,
    delivery_text_suggested_chapters: deliveryTextSuggestedChapters,
    delivery_copy_error: deliveryCopyError,
    episode_checklist: episodeChecklist,
    episode_checklist_summary: checklistSummary(episodeChecklist),
    social_suggestions: socialSuggestionsReceipt ? { ...socialSuggestionsReceipt, stale: !socialSuggestionsCurrent } : null,
    social_delivery: socialDeliveryReceipt,
    social_state: {
      transcript_fingerprint: transcriptFingerprint,
      suggestions_current: socialSuggestionsCurrent,
      suggestion_eligible: Boolean(speakerTranscriptCurrent && speakerReviewCurrent && speakerReviewReceipt?.status === "approved"),
      approved_count: candidates.filter((clip) => clip.review.status === "approved").length,
      watched_count: candidates.filter((clip) => clip.social_render_review?.status === "approved" && !clip.social_render_review.stale).length,
      packaged_count: candidates.filter((clip) => clip.social_package_review?.status === "approved" && !clip.social_package_review.stale).length,
      delivery_ready: Boolean(socialDeliveryReceipt?.status === "ready_for_local_handoff"),
      provider_calls: false,
      publication_authorized: false,
    },
    episode_proxy: episodeProxy,
    episode_proxy_audit: episodeProxyAudit,
    episode_proxy_review: episodeProxyReview,
    episode_assembly_state: {
      eligible: Boolean(timelineCurrent
        && timelinePreviewCurrent
        && timelinePreviewReview.status === "approved"
        && namingState.approved
        && !intakeStale),
      naming_required: !namingState.approved,
      requires_aligned_preview: !(timelineCurrent
        && timelinePreviewCurrent
        && timelinePreviewReview.status === "approved"),
      render_eligible: Boolean(assemblyCurrent
        && assemblyReviewCurrent
        && assemblyReviewReceipt?.status === "approved"
        && (!automaticDirectionRequired || proxyReviewApproved)),
      proxy_eligible: Boolean(automaticAssemblyCurrent
        && assemblyReviewCurrent
        && assemblyReviewReceipt?.status === "approved"
        && cameraReviewApproved),
      automatic_direction_required: automaticDirectionRequired,
      automatic_assembly_current: automaticAssemblyCurrent,
      camera_plan_review_approved: cameraReviewApproved,
      camera_plan_review_required: cameraSampleReviewRequired,
      proxy_review_approved: proxyReviewApproved,
      automatic_camera_ready: Boolean(cameraPlanCurrent && cameraPlanReceipt?.status === "review_required"),
      camera_tracks: (timeline?.tracks || []).filter((track) => track.media_kind === "video").map((track) => ({
        source_id: track.source_id,
        label: track.label,
        timeline_start_ms: track.timeline_start_ms,
        timeline_end_ms: track.timeline_end_ms,
      })),
    },
    candidates,
    selected_by: clipDoc.selected_by || "Studio",
    output_dir: join(dir, "clips"),
  };
}

function episodeWorkflowStatus(episode) {
  if (episode.recovery) return episode.recovery.staleInputs.length ? "Recovery inputs changed" : "Recovered episode · visual finishing";
  if (episode.delivery_audio && !episode.delivery_audio.stale && episode.delivery_text && !episode.delivery_text.stale) return "Delivery files ready";
  if (episode.episode_render && !episode.episode_render.stale) return "Full render ready";
  if (episode.episode_proxy_review?.status === "approved" && !episode.episode_proxy_review?.stale) return "Ready for full render";
  if (episode.episode_proxy && !episode.episode_proxy.stale) return "Proxy review needed";
  if (episode.episode_assembly_review?.status === "approved" && !episode.episode_assembly_review?.stale) return "Ready for proxy";
  if (episode.episode_assembly && !episode.episode_assembly.stale) return "Episode recipe review";
  if (episode.transcript_review_ready && episode.transcript?.length && !episode.episode_naming?.approved) return "Name numbered episode";
  if (episode.transcript_review_ready && episode.transcript?.length) return "Build episode recipe";
  if (episode.timeline_preview_review?.status === "approved" && !episode.timeline_preview_review?.stale) return "Review transcript";
  if (episode.timeline && !episode.timeline.stale) return "Check synchronization";
  return episode.intake_stale ? "Sources changed" : "Prepare sources";
}

function listEpisodes(workRoot) {
  if (!existsSync(workRoot)) return [];
  return readdirSync(workRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => existsSync(join(workRoot, slug, "meta.json")) || existsSync(join(workRoot, slug, "episode.json")) || existsSync(join(workRoot, slug, "recovery.json")))
    .map((slug) => {
      const episode = loadEpisode(workRoot, slug);
      return {
        slug,
        source_name: episode.source_name,
        display_name: episode.episode_title || episode.source_name,
        workflow_status: episodeWorkflowStatus(episode),
        duration_sec: episode.duration_sec,
        transcribed_at: episode.transcribed_at,
        candidate_count: episode.candidates.length,
        approved_count: episode.candidates.filter((clip) => clip.review.status === "approved").length,
        source_count: episode.intake?.sources?.length || 1,
        intake_status: episode.intake_stale ? "stale" : episode.intake?.compatibility?.status || "single_source",
      };
    })
    .sort((a, b) => String(b.transcribed_at || "").localeCompare(String(a.transcribed_at || "")));
}

function episodeSourcePaths(dir) {
  const manifest = readJsonFile(join(dir, "episode.json"), null);
  const meta = readJsonFile(join(dir, "meta.json"), null);
  return [...new Set([
    ...(manifest?.sources || []).map((source) => source.path),
    meta?.source,
  ].filter(Boolean))];
}

function startJob({ root, workRoot, jobs, type, args, slug, sourcePaths, availableBytes }) {
  for (const [id, prior] of jobs) {
    if (prior.slug !== slug) continue;
    const refreshed = refreshRecoveredJob(workRoot, prior);
    jobs.set(id, refreshed);
  }
  const active = [...jobs.values()].find((job) => job.slug === slug && job.status === "running");
  if (active) throw new Error(`${active.type} is already running for this episode`);
  const preflight = buildDiskPreflight({ workRoot, sourcePaths, availableBytes });
  if (!preflight.ok) {
    throw requestError(
      507,
      `Not enough free space for this local job. Studio found ${formatBytes(preflight.available_bytes)} free and requires ${formatBytes(preflight.required_bytes)}.`,
    );
  }
  for (const [id, prior] of jobs) {
    if (prior.slug === slug) jobs.delete(id);
  }
  const id = randomUUID();
  const job = {
    id,
    type,
    slug,
    status: "running",
    logs: [
      `Job receipt: ${id}`,
      `Disk preflight: ${formatBytes(preflight.available_bytes)} free · ${formatBytes(preflight.required_bytes)} required.`,
    ],
    started_at: new Date().toISOString(),
    preflight,
  };
  jobs.set(id, job);
  writeJobJournal(workRoot, job);
  const child = spawn(process.execPath, args, { cwd: root, env: process.env });
  job.pid = child.pid || null;
  const persist = () => {
    try {
      writeJobJournal(workRoot, job);
      return true;
    } catch (error) {
      job.status = "failed";
      job.error = `Could not update the on-disk job journal: ${error.message}`;
      return false;
    }
  };
  const collect = (chunk) => {
    const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
    job.logs.push(...lines);
    if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
    persist();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    job.completed_at = new Date().toISOString();
    persist();
  });
  child.on("close", (code) => {
    const journalFailed = String(job.error || "").startsWith("Could not update the on-disk job journal:");
    job.status = code === 0 && !journalFailed ? "complete" : "failed";
    if (code !== 0 && !job.error) job.error = `process exited ${code}`;
    job.completed_at = new Date().toISOString();
    persist();
  });
  if (!persist()) child.kill();
  return publicJob(job);
}

function normalizeUserPath(value) {
  let input = String(value || "").trim();
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) {
    input = input.slice(1, -1);
  }
  if (input === "~") input = homedir();
  if (input.startsWith(`~${sep}`)) input = join(homedir(), input.slice(2));
  return resolve(input);
}

function serveStatic(publicDir, pathname, res) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = resolve(publicDir, relative);
  const prefix = `${resolve(publicDir)}${sep}`;
  if (!file.startsWith(prefix) || !existsSync(file) || !statSync(file).isFile()) return false;
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  res.writeHead(200, { ...SECURITY_HEADERS, "content-type": types[extname(file)] || "application/octet-stream" });
  const stream = createReadStream(file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
  return true;
}

function serveMedia(req, res, file) {
  const size = statSync(file).size;
  const range = req.headers.range;
  const contentType = ({
    ".png": "image/png",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
  })[extname(file).toLowerCase()] || "video/mp4";
  if (!range) {
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": contentType, "content-length": size, "accept-ranges": "bytes" });
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return sendError(res, 416, "invalid media range");
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size) return sendError(res, 416, "media range is outside the file");
  res.writeHead(206, {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
    "accept-ranges": "bytes",
  });
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

export function createStudioServer(options = {}) {
  const root = resolve(options.root || DEFAULT_ROOT);
  const workRoot = resolve(options.workRoot || join(root, "work"));
  const publicDir = resolve(options.publicDir || join(STUDIO_DIR, "public"));
  mkdirSync(workRoot, { recursive: true });
  const jobs = new Map(loadJobJournals(workRoot).map((job) => [job.id, job]));
  const availableBytes = typeof options.diskAvailableBytes === "function"
    ? options.diskAvailableBytes
    : () => options.diskAvailableBytes;
  const jobOptions = (sourcePaths) => ({
    root,
    workRoot,
    jobs,
    sourcePaths,
    availableBytes: availableBytes(),
  });
  const refreshJob = (job) => {
    const refreshed = refreshRecoveredJob(workRoot, job);
    jobs.set(refreshed.id, refreshed);
    return refreshed;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      const pathname = decodeURIComponent(url.pathname);
      assertTrustedRequest(req, pathname);
      if (req.method === "GET" && pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, local_only: true, root });
      }
      if (req.method === "GET" && pathname === "/api/show-config") {
        return sendJson(res, 200, { show: publicShowConfig(loadShowConfig(root)) });
      }
      if (req.method === "GET" && pathname === "/api/operator") {
        return sendJson(res, 200, { operator: loadOperatorIdentity(workRoot, loadShowConfig(root)), local_only: true });
      }
      if (req.method === "PUT" && pathname === "/api/operator") {
        const body = await readJson(req);
        return sendJson(res, 200, { operator: saveOperatorIdentity(workRoot, body.operator_id, loadShowConfig(root)), local_only: true });
      }
      if (req.method === "GET" && pathname === "/api/show-package") {
        return sendJson(res, 200, loadShowPackageState(workRoot));
      }
      if (req.method === "PUT" && pathname === "/api/show-package") {
        const body = await readJson(req);
        const openingNarrationMode = boundedText(body.opening?.narration_mode, "opening narration mode", 40) || "episode_specific";
        const closingNarrationMode = boundedText(body.closing?.narration_mode, "closing narration mode", 40) || "episode_specific";
        const showPackage = buildShowPackage({
          draft: {
            name: boundedText(body.name, "show-package name", 120) || loadShowConfig(root).show_name,
            opening: {
              narration_mode: openingNarrationMode,
              visual: assemblyAssetReceipt(body.opening?.visual_path, "visual"),
              voiceover: openingNarrationMode === "evergreen"
                ? assemblyAssetReceipt(body.opening?.voiceover_path, "audio")
                : null,
              music: assemblyAssetReceipt(body.opening?.music_path, "audio"),
            },
            closing: {
              narration_mode: closingNarrationMode,
              visual: assemblyAssetReceipt(body.closing?.visual_path, "visual"),
              voiceover: closingNarrationMode === "evergreen"
                ? assemblyAssetReceipt(body.closing?.voiceover_path, "audio")
                : null,
              music: assemblyAssetReceipt(body.closing?.music_path, "audio"),
            },
            cta_graphic: {
              asset: assemblyAssetReceipt(body.cta_graphic?.asset_path, "visual"),
              website_url: boundedText(body.cta_graphic?.website_url, "CTA website URL", 500),
              website_label: boundedText(body.cta_graphic?.website_label, "CTA website label", 80),
              actions: Array.isArray(body.cta_graphic?.actions) ? body.cta_graphic.actions.slice(0, 3) : undefined,
              show_during_closing: body.cta_graphic?.show_during_closing !== false,
            },
            newsletter_cta: {
              asset: assemblyAssetReceipt(body.newsletter_cta?.asset_path, "visual"),
              website_url: boundedText(body.newsletter_cta?.website_url, "newsletter CTA URL", 500),
              website_label: boundedText(body.newsletter_cta?.website_label, "newsletter CTA label", 80),
            },
          },
        });
        const paths = showPackagePaths(workRoot);
        writeLocalStudioJson(paths.package, showPackage);
        return sendJson(res, 200, loadShowPackageState(workRoot));
      }
      if (req.method === "PUT" && pathname === "/api/show-package-review") {
        const body = await readJson(req);
        const state = loadShowPackageState(workRoot);
        if (!state.current || !state.show_package) throw new Error("save the current show package before reviewing it");
        const reviewStatus = boundedText(body.status, "show-package review", 20, { required: true });
        if (reviewStatus === "approved"
          && (!state.previews.opening || state.previews.opening.stale
            || !state.previews.closing || state.previews.closing.stale)) {
          throw new Error("render and watch the current opening and closing previews before approving the show package");
        }
        const review = buildShowPackageReview({
          showPackage: state.show_package,
          status: reviewStatus,
          notes: boundedText(body.notes, "show-package review notes", 2_000),
        });
        writeLocalStudioJson(showPackagePaths(workRoot).review, review);
        return sendJson(res, 200, loadShowPackageState(workRoot));
      }
      const showPackagePreviewMediaMatch = pathname.match(/^\/api\/show-package\/preview\/(opening|closing)$/);
      if (req.method === "GET" && showPackagePreviewMediaMatch) {
        const section = showPackagePreviewMediaMatch[1];
        const state = loadShowPackageState(workRoot);
        const preview = state.previews[section];
        if (!preview || preview.stale || !isReadableFile(preview.output?.path)) {
          return sendError(res, 404, `${section} preview is not current`);
        }
        return serveMedia(req, res, preview.output.path);
      }
      if (req.method === "POST" && pathname === "/api/show-package/preview") {
        const body = await readJson(req);
        const section = boundedText(body.section, "show-package preview section", 20, { required: true });
        if (!["opening", "closing"].includes(section)) throw new Error("preview section must be opening or closing");
        const state = loadShowPackageState(workRoot);
        if (!state.current || !state.show_package) throw new Error("save the current show package before previewing it");
        const job = startJob({
          ...jobOptions(showPackageAssets(state.show_package).map((asset) => asset.path)),
          type: "show_package_preview",
          slug: "show_package",
          args: [join(root, "studio", "show_package_preview.mjs"), "--work-root", workRoot, "--section", section],
        });
        return sendJson(res, 202, { job });
      }
      if (req.method === "GET" && pathname === "/api/episodes") {
        return sendJson(res, 200, { episodes: listEpisodes(workRoot) });
      }
      if (req.method === "POST" && pathname === "/api/recovery/import") {
        const body = await readJson(req);
        const file = inside(normalizeUserPath(body.path), [workRoot]);
        const pack = validatePackage(readRecoveryJson(file));
        const target = recoveryDestination(workRoot, pack.slug);
        if (existsSync(join(target, "episode.json")) || existsSync(join(target, "meta.json"))) throw new Error("That episode already has normal intake; choose a separate recovery slug");
        const job = startJob({ ...jobOptions([]), type: "recovery_import", slug: pack.slug,
          args: [join(root, "studio", "recovery.mjs"), workRoot, file, ""] });
        return sendJson(res, 202, { job });
      }
      const recoveryMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/recovery\/(shot|framing|color|preview|playback|media|preview-media|comparison-media|alternate-media|alternate-comparison-media)$/);
      if (recoveryMatch) {
        const slug = recoveryMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const recovery = loadRecovery(dir).recovery;
        const action = recoveryMatch[2];
        if (req.method === "PUT" && ["shot", "framing", "color"].includes(action)) {
          if ([...jobs.values()].some(job => job.slug === slug && refreshJob(job).status === "running")) throw new Error("Wait for the current episode job before editing");
          return sendJson(res, 200, { episode: ({ shot: saveRecoveryShot, framing: saveRecoveryFraming, color: saveRecoveryColor }[action])(dir, await readJson(req)) });
        }
        if (req.method === "POST" && action === "playback") {
          const body = await readJson(req);
          if (!recovery.preview || recovery.preview.stale || body.previewSha256 !== recovery.preview.sha256) throw new Error("Render a current preview before repairing playback");
          const job = startJob({ ...jobOptions([]), type: "recovery_playback", slug,
            args: [join(root, "studio", "recovery_render.mjs"), dir, "--alternate-playback", body.previewSha256] });
          return sendJson(res, 202, { job });
        }
        if (req.method === "POST" && action === "preview") {
          const body = await readJson(req);
          if (recovery.staleInputs.length || body.draftFingerprint !== recovery.draftFingerprint) throw new Error("Recovery inputs or draft changed; reload first");
          previewSegments(recovery, body.startFrame, body.endFrame);
          const job = startJob({ ...jobOptions([]), type: "recovery_preview", slug,
            args: [join(root, "studio", "recovery_render.mjs"), dir, String(body.startFrame), String(body.endFrame), recovery.draftFingerprint] });
          return sendJson(res, 202, { job });
        }
        if (req.method === "GET" && ["media", "preview-media", "comparison-media", "alternate-media", "alternate-comparison-media"].includes(action)) {
          if (recovery.staleInputs.length) return sendError(res, 409, "Recovery inputs changed; re-verify before playback");
          if (action !== "media" && (!recovery.preview || recovery.preview.stale)) return sendError(res, 409, "Render a current camera preview first");
          if (action === "comparison-media" && !recovery.preview.comparisonFile) return sendError(res, 404, "Render a comparison preview first");
          const alternate = action.startsWith("alternate-");
          if (alternate && (!recovery.preview.alternatePlayback || recovery.preview.alternatePlayback.stale)) return sendError(res, 409, "Prepare current alternate playback first");
          const media = alternate ? recovery.preview.alternatePlayback : recovery.preview;
          const file = action === "media" ? recovery.review.path : join(dir, ["comparison-media", "alternate-comparison-media"].includes(action) ? media.comparisonFile : media.file);
          inside(file, [workRoot]);
          return serveMedia(req, res, file);
        }
        return sendError(res, 405, "Unsupported recovery operation");
      }
      const closingTransitionMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/recovery\/closing-transition(?:\/(media))?$/);
      if (closingTransitionMatch) {
        const slug=closingTransitionMatch[1],dir=safeEpisodeDir(workRoot,slug);
        recoveryDestination(workRoot,slug);
        const state=loadClosingTransition(dir);
        if(req.method==='GET'&&!closingTransitionMatch[2])return sendJson(res,200,state);
        if(req.method==='GET'&&closingTransitionMatch[2]==='media') {
          if(!state.receipt||state.receipt.stale)return sendError(res,409,'Render a current closing transition first');
          inside(state.receipt.output.path,[dir]);return serveMedia(req,res,state.receipt.output.path);
        }
        if(req.method==='POST'&&!closingTransitionMatch[2]) {
          const body=await readJson(req),inputs=closingInputs(dir);
          if(body.inputsKey!==inputs.key)throw new Error('Closing inputs changed; reload first');
          const sourcePath=inside(body.sourcePath,[workRoot]);
          validateClosingSettings(body,probeRecoveryMedia(sourcePath));
          const job=startJob({...jobOptions([]),type:'closing_transition',slug,args:[join(root,'studio','closing_transition.mjs'),dir,JSON.stringify({inputsKey:body.inputsKey,sourcePath,leadSec:body.leadSec,gainDb:body.gainDb,trimProgramEndSec:body.trimProgramEndSec})]});
          return sendJson(res,202,{job});
        }
        return sendError(res,405,'Unsupported closing transition operation');
      }
      const openingTransitionMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/recovery\/opening-transition(?:\/(media))?$/);
      if (openingTransitionMatch) {
        const slug = openingTransitionMatch[1], dir = safeEpisodeDir(workRoot, slug);
        recoveryDestination(workRoot, slug);
        const state = loadOpeningTransition(dir);
        if (req.method === "GET" && !openingTransitionMatch[2]) return sendJson(res, 200, state);
        if (req.method === "GET" && openingTransitionMatch[2] === "media") {
          if (!state.receipt || state.receipt.stale) return sendError(res, 409, "Render a current opening transition first");
          inside(state.receipt.output.path, [dir]);
          return serveMedia(req, res, state.receipt.output.path);
        }
        if (req.method === "POST" && !openingTransitionMatch[2]) {
          const body = await readJson(req), inputs = transitionInputs(dir);
          if (body.inputsKey !== inputs.key) throw new Error("Transition inputs changed; reload first");
          inside(inputs.opening.output.path, [dir]);
          validateTransitionSettings(body, Number(inputs.opening.recipe.sourceMetadata.format.duration));
          const job = startJob({ ...jobOptions([]), type: "opening_transition", slug,
            args: [join(root, "studio", "opening_transition.mjs"), dir, JSON.stringify({inputsKey:body.inputsKey,trimEndSec:body.trimEndSec,fadeInSec:body.fadeInSec})] });
          return sendJson(res, 202, { job });
        }
        return sendError(res, 405, "Unsupported opening transition operation");
      }
      const numberedOpeningMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/numbered-opening(?:\/(render|media))?$/);
      if (numberedOpeningMatch) {
        const slug = numberedOpeningMatch[1], action = numberedOpeningMatch[2];
        const dir = safeEpisodeDir(workRoot, slug);
        recoveryDestination(workRoot, slug); // Reject a symlinked episode directory escaping work.
        if (!existsSync(join(dir, "recovery.json")) && !existsSync(join(dir, "meta.json")) && !existsSync(join(dir, "episode.json"))) throw new Error("Episode intake is required");
        const state = loadNumberedOpening(dir);
        if (req.method === "GET" && !action) return sendJson(res, 200, state);
        if (req.method === "PUT" && !action) {
          if ([...jobs.values()].some(job => job.slug === slug && refreshJob(job).status === "running")) throw new Error("Wait for the current episode job before editing");
          const saved = await saveNumberedOpening(dir, await readJson(req), [workRoot]);
          return sendJson(res, 200, saved);
        }
        if (req.method === "POST" && action === "render") {
          const body = await readJson(req);
          if (!state.current || body.fingerprint !== state.recipe.fingerprint) throw new Error("Save a current numbered opening first");
          inside(state.recipe.source.path, [workRoot]);
          const job = startJob({ ...jobOptions([]), type: "numbered_opening", slug,
            args: [join(root, "studio", "numbered_opening.mjs"), dir, state.recipe.fingerprint] });
          return sendJson(res, 202, { job });
        }
        if (req.method === "GET" && action === "media") {
          if (!state.render || state.render.stale) return sendError(res, 409, "Render a current numbered opening first");
          inside(state.render.preview.path, [dir]);
          return serveMedia(req, res, state.render.preview.path);
        }
        return sendError(res, 405, "Unsupported numbered opening operation");
      }
      const socialWorkspaceMatch=pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/social-workspace(?:\/(render|preview|finish)(?:\/([a-f0-9-]{36}))?(?:\/([a-f0-9-]{36})\/(preview|master|review|receipt))?)?$/);
      if(socialWorkspaceMatch) {
        const [,slug,action,id,finishId,kind]=socialWorkspaceMatch,dir=safeEpisodeDir(workRoot,slug);recoveryDestination(workRoot,slug);
        const episode=loadEpisode(workRoot,slug),files={};
        const source=loadReleaseWorkspace(dir,episode,files).source,state=loadSocialWorkspace(dir,source);
        if(req.method==='GET'&&!action)return sendJson(res,200,{...state,episode_number:episodeNumber(episode),drafts:state.drafts.map(d=>({...d,finishes:loadFinishes(dir,d,state.stale)}))});
        if(req.method==='PUT'&&!action)return sendJson(res,200,saveSocialWorkspace(dir,source,await readJson(req)));
        if(req.method==='POST'&&action==='render') {
          const args=socialJobArgs(root,dir,state,await readJson(req));
          const job=startJob({...jobOptions([source.path]),slug,type:'social_portable',args});return sendJson(res,202,{job});
        }
        if(req.method==='GET'&&action==='preview')return serveMedia(req,res,socialPreviewPath(dir,state,id));
        if(req.method==='POST'&&action==='finish'&&!finishId) {
          const body=await readJson(req),args=finishJobArgs(root,dir,state,{...body,id},episodeNumber(episode));
          const paths=[source.path,...(body.recipe?.ending?[body.recipe.ending.path]:[])];
          const job=startJob({...jobOptions(paths),slug,type:'social_finish',args});return sendJson(res,202,{job});
        }
        if(req.method==='GET'&&action==='finish'&&finishId) {
          const file=finishArtifactPath(dir,state,id,finishId,kind);
          if(['preview','master'].includes(kind))return serveMedia(req,res,file);
          res.writeHead(200,{...SECURITY_HEADERS,'content-type':kind==='receipt'?'application/json; charset=utf-8':'text/plain; charset=utf-8'});return res.end(readFileSync(file,'utf8'));
        }
        return sendError(res,405,'Unsupported social workspace operation');
      }
      const releaseMatch=pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/release-workspace(?:\/(brief|brief-json))?$/);
      if(releaseMatch) {
        const slug=releaseMatch[1],dir=safeEpisodeDir(workRoot,slug);recoveryDestination(workRoot,slug);
        const episode=loadEpisode(workRoot,slug),files={};
        const state=loadReleaseWorkspace(dir,episode,files),action=releaseMatch[2];
        if(req.method==='GET'&&!action)return sendJson(res,200,state);
        if(req.method==='PUT'&&!action)return sendJson(res,200,saveReleaseWorkspace(dir,episode,files,await readJson(req)));
        if(req.method==='GET'&&['brief','brief-json'].includes(action)) {
          const brief=releaseBrief(state),json=action==='brief-json';
          res.writeHead(200,{...SECURITY_HEADERS,'content-type':json?'application/json; charset=utf-8':'text/markdown; charset=utf-8','content-disposition':`attachment; filename="${slug}_RELEASE_BRIEF.${json?'json':'md'}"`});
          return res.end(json?JSON.stringify(brief,null,2)+'\n':releaseBriefMarkdown(brief));
        }
        return sendError(res,405,'Unsupported release operation');
      }
      const workflowMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/production-workflow(?:\/(handoff|[a-z0-9_]+))?$/);
      if (workflowMatch) {
        const slug = workflowMatch[1], dir = safeEpisodeDir(workRoot, slug);
        recoveryDestination(workRoot, slug);
        const episode = loadEpisode(workRoot, slug);
        const checklist = loadWorkflowChecklist(dir, episode);
        const workflow = buildProductionWorkflow(episode, checklist, loadOperatorIdentity(workRoot, loadShowConfig(root)));
        if (req.method === "GET" && !workflowMatch[2]) return sendJson(res, 200, workflow);
        if (req.method === "GET" && workflowMatch[2] === "handoff") {
          const body = workflowHandoff(workflow);
          res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${slug}_UI_TRIAL.md"` });
          return res.end(body);
        }
        if (req.method === "PUT" && workflowMatch[2] && workflowMatch[2] !== "handoff") {
          const next = saveWorkflowItem(dir, checklist, workflowMatch[2], await readJson(req), workflow);
          return sendJson(res, 200, buildProductionWorkflow(episode, next, loadOperatorIdentity(workRoot, loadShowConfig(root))));
        }
        return sendError(res, 405, "Unsupported production workflow operation");
      }
      // Recovery episodes have their own honest gates; normal pipeline writes cannot
      // accidentally replace their sources or fabricate synchronization approvals.
      const recoveryGuard = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\//);
      if (recoveryGuard && existsSync(join(workRoot, recoveryGuard[1], "recovery.json"))) {
        return sendError(res, 409, "Continue this episode in the recovered-episode workspace");
      }
      const episodeMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)$/);
      if (req.method === "GET" && episodeMatch) {
        return sendJson(res, 200, { episode: loadEpisode(workRoot, episodeMatch[1]) });
      }
      const namingRequestMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/episode-naming\/request$/);
      if (req.method === "GET" && namingRequestMatch) {
        const dir = safeEpisodeDir(workRoot, namingRequestMatch[1]);
        const request = readJsonFile(join(dir, "episode_naming_request.json"), null);
        if (!request) return sendError(res, 404, "prepare the episode-naming request first");
        return sendJson(res, 200, { request });
      }
      if (req.method === "POST" && namingRequestMatch) {
        const slug = namingRequestMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        requireCurrentReviewContext(dir);
        const episode = loadEpisode(workRoot, slug);
        if (!episode.transcript_review_ready || !episode.transcript.length) {
          throw new Error("confirm the current transcript before preparing episode-title options");
        }
        const policy = loadEpisodeNamingPolicy();
        const request = buildEpisodeNamingRequest({
          slug,
          episodeNumber: body.episode_number,
          segments: episode.transcript,
          previousApprovedTitles: previousApprovedEpisodeTitles(workRoot, slug),
          policyVersion: policy.version,
          policyFingerprint: policy.fingerprint,
        });
        writeLocalStudioJson(join(dir, "episode_naming_request.json"), request);
        return sendJson(res, 201, { request, episode: loadEpisode(workRoot, slug) });
      }
      const namingProposalMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/episode-naming\/proposal$/);
      if (req.method === "POST" && namingProposalMatch) {
        const slug = namingProposalMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const request = readJsonFile(join(dir, "episode_naming_request.json"), null);
        const current = loadEpisode(workRoot, slug);
        if (!current.episode_naming.request_current) throw new Error("prepare a current naming request before importing title options");
        const proposal = validateEpisodeNamingProposal(body.proposal || body, request);
        writeLocalStudioJson(join(dir, "episode_naming_proposal.json"), proposal);
        return sendJson(res, 201, { proposal, episode: loadEpisode(workRoot, slug) });
      }
      const namingHumanMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/episode-naming\/human-candidate$/);
      if (req.method === "POST" && namingHumanMatch) {
        const slug = namingHumanMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const request = readJsonFile(join(dir, "episode_naming_request.json"), null);
        const current = loadEpisode(workRoot, slug);
        if (!current.episode_naming.request_current) throw new Error("prepare a current naming request before adding a human title");
        const proposal = buildHumanEpisodeNamingProposal({
          request,
          title: boundedText(body.canonical_title, "canonical title", 160, { required: true }),
          rationale: boundedText(body.rationale, "title rationale", 1_000, { required: true }),
        });
        writeLocalStudioJson(join(dir, "episode_naming_proposal.json"), proposal);
        return sendJson(res, 201, { proposal, episode: loadEpisode(workRoot, slug) });
      }
      const namingApprovalMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/episode-naming\/approval$/);
      if (req.method === "PUT" && namingApprovalMatch) {
        const slug = namingApprovalMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const operator = loadOperatorIdentity(workRoot, loadShowConfig(root));
        if (!operator) throw new Error("choose which host is operating this machine before approving a title");
        const current = loadEpisode(workRoot, slug);
        if (!current.episode_naming.request_current || !current.episode_naming.proposal_current) {
          throw new Error("prepare and import current title options before approval");
        }
        const request = readJsonFile(join(dir, "episode_naming_request.json"), null);
        const proposal = readJsonFile(join(dir, "episode_naming_proposal.json"), null);
        const approval = buildEpisodeNamingApproval({
          request,
          proposal,
          candidateId: boundedText(body.candidate_id, "title option", 40, { required: true }),
          approvedBy: operator.operator_id,
        });
        writeLocalStudioJson(join(dir, "episode_naming_approval.json"), approval);
        return sendJson(res, 200, { approval, episode: loadEpisode(workRoot, slug) });
      }
      const mediaMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/media$/);
      if (req.method === "GET" && mediaMatch) {
        const dir = safeEpisodeDir(workRoot, mediaMatch[1]);
        const meta = readJsonFile(join(dir, "meta.json"), {});
        // Before transcription there is no meta.json; fall back to the Host 1 camera from intake.
        const primary = (readJsonFile(join(dir, "episode.json"), null)?.sources || []).find((item) => item.id === "primary_camera");
        const path = meta.source || primary?.path;
        if (!isReadableFile(path)) return sendError(res, 404, "source recording is not available locally");
        return serveMedia(req, res, path);
      }
      const sourceMediaMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/media\/([a-z0-9_]+)$/);
      if (req.method === "GET" && sourceMediaMatch) {
        const [, slug, sourceId] = sourceMediaMatch;
        const dir = safeEpisodeDir(workRoot, slug);
        const intake = readJsonFile(join(dir, "episode.json"), null);
        requireCurrentIntake(intake);
        const source = (intake?.sources || []).find((item) => item.id === sourceId);
        if (!source || !isReadableFile(source.path)) return sendError(res, 404, "source recording is not available locally");
        return serveMedia(req, res, source.path);
      }
      const browserPreviewMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/browser-preview\/([a-z0-9_]+)$/);
      if (req.method === "POST" && browserPreviewMatch) {
        const [, slug, sourceId] = browserPreviewMatch;
        const dir = safeEpisodeDir(workRoot, slug);
        const intake = readJsonFile(join(dir, "episode.json"), null);
        requireCurrentIntake(intake);
        const source = (intake?.sources || []).find((item) => item.id === sourceId);
        if (!source || (source.expected_kind !== "video" && source.media_kind !== "video" && !source.video) || !isReadableFile(source.path)) {
          throw new Error("choose a current camera source for the browser preview");
        }
        const job = startJob({
          ...jobOptions([source.path]),
          type: "browser_preview",
          slug,
          args: [join(root, "studio", "browser_preview.mjs"), "--run", dir, "--source", sourceId],
        });
        return sendJson(res, 202, { job });
      }
      const browserPreviewMediaMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/browser-preview\/([a-z0-9_]+)\/media$/);
      if (req.method === "GET" && browserPreviewMediaMatch) {
        const [, slug, sourceId] = browserPreviewMediaMatch;
        const episode = loadEpisode(workRoot, slug);
        const preview = episode.browser_previews?.[sourceId];
        if (!preview?.current || !isReadableFile(preview.output?.path)) {
          return sendError(res, 404, "a current local browser preview is not available");
        }
        return serveMedia(req, res, preview.output.path);
      }
      const seamMediaMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/audio-sequences\/(host_[12]_audio)\/seams\/(seam_[0-9]{3})\/media$/);
      if (req.method === "GET" && seamMediaMatch) {
        const [, slug, role, seamId] = seamMediaMatch;
        const dir = safeEpisodeDir(workRoot, slug);
        const intake = readJsonFile(join(dir, "episode.json"), null);
        const seam = intake?.audio_sequences?.[role]?.seams?.find((item) => item.id === seamId);
        if (!seam || !isReadableFile(seam.preview_file)) return sendError(res, 404, "the seam preview is not available locally");
        return serveMedia(req, res, seam.preview_file);
      }
      const episodeMediaMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/episode-media$/);
      if (req.method === "GET" && episodeMediaMatch) {
        const episode = loadEpisode(workRoot, episodeMediaMatch[1]);
        if (!episode.episode_render || episode.episode_render.stale || !isReadableFile(episode.episode_render.output?.path)) {
          return sendError(res, 404, "a current full-episode render is not available locally");
        }
        return serveMedia(req, res, episode.episode_render.output.path);
      }
      const deliveryAudioMediaMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/delivery-audio-media$/);
      if (req.method === "GET" && deliveryAudioMediaMatch) {
        const episode = loadEpisode(workRoot, deliveryAudioMediaMatch[1]);
        if (!episode.delivery_audio || episode.delivery_audio.stale || !isReadableFile(episode.delivery_audio.output?.path)) {
          return sendError(res, 404, "a current RSS audio deliverable is not available locally");
        }
        return serveMedia(req, res, episode.delivery_audio.output.path);
      }
      const episodeProxyMediaMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/episode-proxy-media$/);
      if (req.method === "GET" && episodeProxyMediaMatch) {
        const episode = loadEpisode(workRoot, episodeProxyMediaMatch[1]);
        if (!episode.episode_proxy || episode.episode_proxy.stale || !isReadableFile(episode.episode_proxy.output?.path)) {
          return sendError(res, 404, "a current camera-direction proxy is not available locally");
        }
        return serveMedia(req, res, episode.episode_proxy.output.path);
      }
      const socialMediaMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/social-media\/([a-z0-9_]+)$/);
      if (req.method === "GET" && socialMediaMatch) {
        const [, slug, clipId] = socialMediaMatch;
        const episode = loadEpisode(workRoot, slug);
        const candidate = episode.candidates.find((item) => item.id === clipId);
        if (!candidate?.social_render || candidate.social_render.stale || !isReadableFile(candidate.social_render.output?.path)) {
          return sendError(res, 404, "a current source-bound social render is not available");
        }
        return serveMedia(req, res, candidate.social_render.output.path);
      }
      const clipsMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/clips$/);
      if (req.method === "PUT" && clipsMatch) {
        const slug = clipsMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const meta = readJsonFile(join(dir, "meta.json"), {});
        const probe = readJsonFile(join(dir, "probe.json"), {});
        const previousDoc = readJsonFile(join(dir, "clips.json"), { clips: [] });
        requireCurrentReviewContext(dir);
        const previousById = new Map((previousDoc.clips || []).map((clip) => [clip.id, clip]));
        const schema = body.schema === "eaol-clips-v2" ? "eaol-clips-v2" : "eaol-clips-v1";
        const operator = loadOperatorIdentity(workRoot, loadShowConfig(root));
        const savedAt = new Date().toISOString();
        const requestedClips = Array.isArray(body.clips) ? body.clips : [];
        const clips = schema === "eaol-clips-v2" ? requestedClips.map((clip) => {
          const previousClip = previousById.get(clip.id);
          if (previousClip) {
            const preserved = { ...clip };
            if (previousClip.proposed_by) preserved.proposed_by = previousClip.proposed_by;
            else delete preserved.proposed_by;
            if (previousClip.proposed_at) preserved.proposed_at = previousClip.proposed_at;
            else delete preserved.proposed_at;
            if (previousClip.origin) preserved.origin = previousClip.origin;
            else delete preserved.origin;
            return preserved;
          }
          if (!operator) throw new Error("choose which host is operating this machine before adding a candidate");
          return {
            ...clip,
            proposed_by: operator.operator_id,
            proposed_at: savedAt,
            origin: "human",
          };
        }) : requestedClips;
        const doc = {
          schema,
          source_slug: slug,
          selected_by: String(body.selected_by || (operator ? `${operator.display_name} via Studio` : "Studio")).trim(),
          clips,
        };
        validateClipDocument(doc, slug, meta, probe);
        const changedIds = new Set(doc.clips
          .filter((clip) => !previousById.has(clip.id) || clipContentKey(previousById.get(clip.id)) !== clipContentKey(clip))
          .map((clip) => clip.id));
        const removed = (previousDoc.clips || []).some((clip) => !doc.clips.some((current) => current.id === clip.id));
        let nextReview = null;
        if (changedIds.size || removed) {
          nextReview = loadReview(dir, doc.clips);
          const invalidatedAt = new Date().toISOString();
          for (const clipId of changedIds) {
            nextReview.clips[clipId] = {
              ...nextReview.clips[clipId],
              status: doc.clips.find((clip) => clip.id === clipId)?.proposed_by === "studio" ? "suggested" : "proposed",
              invalidated_at: invalidatedAt,
            };
          }
          nextReview.schema = "eaol-review-v2";
          nextReview.updated_at = invalidatedAt;
          // Persist the conservative review reset first so an interrupted write
          // can never leave changed candidate instructions carrying old approval.
          writeFileSync(join(dir, "studio_review.json"), `${JSON.stringify(nextReview, null, 2)}\n`);
        }
        writeFileSync(join(dir, "clips.json"), `${JSON.stringify(doc, null, 2)}\n`);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const socialSuggestionsMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/social-suggestions$/);
      if (req.method === "POST" && socialSuggestionsMatch) {
        const slug = socialSuggestionsMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        requireCurrentReviewContext(dir);
        const loaded = loadEpisode(workRoot, slug);
        if (!loaded.social_state.suggestion_eligible) throw new Error("confirm the current speaker transcript before generating social suggestions");
        if (loaded.social_state.suggestions_current) {
          return sendJson(res, 200, { suggestions: loaded.social_suggestions, episode: loaded, reused: true });
        }
        const prior = readJsonFile(join(dir, "clips.json"), { clips: [] });
        const receipt = buildSocialSuggestions({
          slug,
          segments: loaded.transcript,
          transcriptFingerprint: loaded.social_state.transcript_fingerprint,
          speakerActivityFingerprint: loaded.speaker_activity?.fingerprint || null,
          assemblyFingerprint: loaded.episode_assembly && !loaded.episode_assembly.stale ? loaded.episode_assembly.plan_fingerprint : null,
          programStartMs: loaded.episode_assembly && !loaded.episode_assembly.stale ? loaded.episode_assembly.program.start_ms : 0,
          programEndMs: loaded.episode_assembly && !loaded.episode_assembly.stale
            ? loaded.episode_assembly.program.end_ms
            : Math.round(loaded.duration_sec * 1_000),
          existingClips: prior.clips || [],
        });
        const legacyNormalized = (prior.clips || []).map((clip) => ({
          ...clip,
          segment_ids: Array.isArray(clip.segment_ids) ? clip.segment_ids : [],
          category: clip.category || "explainer",
        }));
        const doc = {
          schema: "eaol-clips-v2",
          source_slug: slug,
          selected_by: "Studio deterministic local suggestions",
          clips: [...legacyNormalized, ...receipt.suggestions],
        };
        const meta = readJsonFile(join(dir, "meta.json"), {});
        const probe = readJsonFile(join(dir, "probe.json"), {});
        validateClipDocument(doc, slug, meta, probe);
        const review = loadReview(dir, doc.clips);
        for (const suggestion of receipt.suggestions) {
          review.clips[suggestion.id] = {
            status: "suggested",
            notes: "",
            invalidated_at: null,
            reviewed_by: null,
            reviewed_at: null,
            discussion: [],
          };
        }
        review.updated_at = receipt.generated_at;
        writeLocalStudioJson(join(dir, "studio_review.json"), review);
        writeLocalStudioJson(join(dir, "clips.json"), doc);
        writeLocalStudioJson(join(dir, "social_suggestions.json"), receipt);
        return sendJson(res, 201, { suggestions: receipt, episode: loadEpisode(workRoot, slug), reused: false });
      }
      const reviewMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/review\/([a-z0-9_]+)$/);
      if (req.method === "PUT" && reviewMatch) {
        const [, slug, clipId] = reviewMatch;
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        if (!CLIP_REVIEW_STATUSES.has(body.status)) throw new Error("review status must be suggested, proposed, needs_discussion, approved, or rejected");
        const operator = loadOperatorIdentity(workRoot, loadShowConfig(root));
        if (!operator) throw new Error("choose which host is operating this machine before reviewing a candidate");
        if (body.status === "approved") {
          requireCurrentReviewContext(dir);
        }
        const clipDoc = readJsonFile(join(dir, "clips.json"), { clips: [] });
        if (!(clipDoc.clips || []).some((clip) => clip.id === clipId)) throw new Error("candidate not found");
        const review = loadReview(dir, clipDoc.clips || []);
        const notes = boundedText(body.notes, "review notes", 2_000);
        if (body.status === "needs_discussion" && !notes) throw new Error("add a discussion note before asking the other host to review");
        const reviewedAt = new Date().toISOString();
        const discussion = [...(review.clips[clipId]?.discussion || [])];
        if (notes) discussion.push({ by: operator.operator_id, at: reviewedAt, note: notes });
        review.clips[clipId] = {
          status: body.status,
          notes,
          invalidated_at: review.clips[clipId]?.invalidated_at || null,
          reviewed_by: operator.operator_id,
          reviewed_at: reviewedAt,
          discussion,
        };
        review.schema = "eaol-review-v2";
        review.updated_at = reviewedAt;
        writeFileSync(join(dir, "studio_review.json"), `${JSON.stringify(review, null, 2)}\n`);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const socialRenderReviewMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/social-render-review\/([a-z0-9_]+)$/);
      if (req.method === "PUT" && socialRenderReviewMatch) {
        const [, slug, clipId] = socialRenderReviewMatch;
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const operator = loadOperatorIdentity(workRoot, loadShowConfig(root));
        if (!operator) throw new Error("choose which host is operating this machine before reviewing a social render");
        const loaded = loadEpisode(workRoot, slug);
        const candidate = loaded.candidates.find((item) => item.id === clipId);
        if (!candidate?.social_render || candidate.social_render.stale) throw new Error("render the current source-bound social clip before reviewing it");
        const review = buildSocialRenderReview({
          renderReceipt: candidate.social_render,
          status: boundedText(body.status, "social render review status", 20, { required: true }),
          completeWatch: body.complete_watch === true,
          checks: body.checks,
          reviewedBy: operator.operator_id,
          notes: boundedText(body.notes, "social render review notes", 2_000),
        });
        const saved = readJsonFile(join(dir, "social_render_review.json"), { schema: "eaol-social-render-reviews-v1", clips: {} });
        saved.schema = "eaol-social-render-reviews-v1";
        saved.updated_at = review.reviewed_at;
        saved.clips ||= {};
        saved.clips[clipId] = review;
        writeLocalStudioJson(join(dir, "social_render_review.json"), saved);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const socialPackageMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/social-package\/([a-z0-9_]+)$/);
      if (req.method === "PUT" && socialPackageMatch) {
        const [, slug, clipId] = socialPackageMatch;
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const loaded = loadEpisode(workRoot, slug);
        const candidate = loaded.candidates.find((item) => item.id === clipId);
        if (!candidate || candidate.review.status !== "approved") throw new Error("approve the social candidate before packaging it");
        if (!candidate.social_render_review || candidate.social_render_review.stale || candidate.social_render_review.status !== "approved") {
          throw new Error("watch and approve the complete rendered clip before packaging it");
        }
        const kit = buildSocialPostKit({
          episodeId: loaded.episode_naming?.approval?.production_id,
          episodeTitle: loaded.episode_title,
          publicEpisodeUrl: boundedText(body.public_episode_url, "public YouTube episode URL", 2_000, { required: true }),
          clip: candidate,
          renderedMasterPath: candidate.social_render.output.path,
          caption: boundedText(body.caption, "core social caption", 2_200, { required: true }),
          hashtags: Array.isArray(body.hashtags) ? body.hashtags : [],
          coverNote: boundedText(body.cover_headline, "cover headline", 120, { required: true }),
          releaseSlot: boundedText(body.release_slot, "release slot", 20, { required: true }),
          tiktokBioLinkAvailable: body.tiktok_bio_link_available === true,
        });
        const saved = readJsonFile(join(dir, "social_packaging.json"), { schema: "eaol-social-packages-v2", clips: {} });
        saved.schema = "eaol-social-packages-v2";
        saved.updated_at = kit.generated_at;
        saved.clips ||= {};
        saved.clips[clipId] = kit;
        writeLocalStudioJson(join(dir, "social_packaging.json"), saved);
        const reviews = readJsonFile(join(dir, "social_package_review.json"), { schema: "eaol-social-package-reviews-v1", clips: {} });
        if (reviews.clips?.[clipId]) {
          delete reviews.clips[clipId];
          reviews.updated_at = kit.generated_at;
          writeLocalStudioJson(join(dir, "social_package_review.json"), reviews);
        }
        return sendJson(res, 200, { package: kit, episode: loadEpisode(workRoot, slug) });
      }
      const socialPackageReviewMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/social-package-review\/([a-z0-9_]+)$/);
      if (req.method === "PUT" && socialPackageReviewMatch) {
        const [, slug, clipId] = socialPackageReviewMatch;
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const operator = loadOperatorIdentity(workRoot, loadShowConfig(root));
        if (!operator) throw new Error("choose which host is operating this machine before approving a social package");
        const loaded = loadEpisode(workRoot, slug);
        const candidate = loaded.candidates.find((item) => item.id === clipId);
        if (!candidate?.social_package || candidate.social_package.stale) throw new Error("save the current three-platform package before approving it");
        const review = buildSocialPackageReview({
          kit: candidate.social_package,
          status: boundedText(body.status, "social package review status", 20, { required: true }),
          reviewedBy: operator.operator_id,
          checks: body.checks,
          notes: boundedText(body.notes, "social package review notes", 2_000),
        });
        const saved = readJsonFile(join(dir, "social_package_review.json"), { schema: "eaol-social-package-reviews-v1", clips: {} });
        saved.schema = "eaol-social-package-reviews-v1";
        saved.updated_at = review.reviewed_at;
        saved.clips ||= {};
        saved.clips[clipId] = review;
        writeLocalStudioJson(join(dir, "social_package_review.json"), saved);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const socialDeliveryMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/social-delivery$/);
      if (req.method === "POST" && socialDeliveryMatch) {
        const slug = socialDeliveryMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const loaded = loadEpisode(workRoot, slug);
        const receipt = writeSocialDelivery(dir, {
          slug,
          episodeId: loaded.episode_naming?.approval?.production_id,
          episodeTitle: loaded.episode_title,
          clips: loaded.candidates,
          renderReceipts: readJsonFile(join(dir, "social_render_receipts.json"), { renders: {} }).renders,
          renderReviews: readJsonFile(join(dir, "social_render_review.json"), { clips: {} }).clips,
          packages: readJsonFile(join(dir, "social_packaging.json"), { clips: {} }).clips,
          packageReviews: readJsonFile(join(dir, "social_package_review.json"), { clips: {} }).clips,
          qualityException: body.quality_over_quota === true ? {
            approved: true,
            reason: boundedText(body.quality_exception_reason, "quality-over-quota reason", 1_000, { required: true }),
          } : null,
        });
        return sendJson(res, 201, { receipt, episode: loadEpisode(workRoot, slug) });
      }
      const ctaCueMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/cta-cues$/);
      if (req.method === "PUT" && ctaCueMatch) {
        const slug = ctaCueMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        requireCurrentReviewContext(dir);
        const episode = loadEpisode(workRoot, slug);
        if (!episode.transcript_review_ready || !episode.transcript.length) {
          throw new Error("confirm the current transcript review before reviewing CTA graphic cues");
        }
        const updatedAt = new Date().toISOString();
        const { review, state } = updateCtaCueReview({
          segments: episode.transcript,
          currentReview: readJsonFile(join(dir, "cta_cue_review.json"), null),
          cueId: body.cue_id,
          segmentIndex: body.segment_index,
          status: boundedText(body.status, "CTA cue status", 20, { required: true }),
          ctaType: body.cta_type == null ? null : boundedText(body.cta_type, "CTA cue type", 30, { required: true }),
          notes: boundedText(body.notes, "CTA cue notes", 2_000),
          updatedAt,
        });
        const manifest = buildCtaGraphicManifest({ slug, state, generatedAt: updatedAt });
        writeFileSync(join(dir, "cta_cue_review.json"), `${JSON.stringify(review, null, 2)}\n`);
        writeFileSync(join(dir, state.cue_sheet_file), `${ctaGraphicCueSheet(manifest)}\n`);
        // The manifest is the completion receipt and is written last. Its exact
        // review revision prevents an interrupted prior write from looking current.
        writeFileSync(join(dir, state.manifest_file), `${JSON.stringify(manifest, null, 2)}\n`);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const assemblyMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/assembly$/);
      if (req.method === "PUT" && assemblyMatch) {
        const slug = assemblyMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const manifest = readJsonFile(join(dir, "episode.json"), null);
        const syncReceipt = readJsonFile(join(dir, "sync.json"), null);
        const syncReview = readJsonFile(join(dir, "sync_review.json"), null);
        const timeline = readJsonFile(join(dir, "timeline.json"), null);
        const timelinePreviewReview = readJsonFile(join(dir, "timeline_preview_review.json"), null);
        requireCurrentIntake(manifest);
        if (!timelineReceiptMatchesInputs(timeline, manifest, syncReceipt, syncReview)
          || !timelinePreviewMatchesInputs(timelinePreviewReview, timeline, manifest)
          || timelinePreviewReview.status !== "approved") {
          throw new Error("confirm the current aligned camera preview before assembling the episode");
        }
        if (body.apply_camera_plan !== true && (!Array.isArray(body.shots) || body.shots.length > 500)) {
          throw new Error("the camera plan must contain between 1 and 500 shots");
        }
        const loaded = loadEpisode(workRoot, slug);
        if (!loaded.episode_naming?.approved) {
          throw new Error("approve a current numbered episode title before saving the assembly recipe");
        }
        if (String(body.title || "").trim() !== loaded.episode_naming.approval.canonical_title) {
          throw new Error("the assembly title must match the approved canonical episode title");
        }
        if (body.apply_camera_plan === true && (!loaded.camera_plan || loaded.camera_plan.stale)) {
          throw new Error("build the current source-bound camera plan before applying it to assembly");
        }
        const ctaGraphicManifest = loaded.cta_cues.manifest_current
          ? readJsonFile(join(dir, "cta_graphic_manifest.json"), null)
          : null;
        const packageDraft = resolveAssemblyPackageDraft(body, loadShowPackageState(workRoot));
        const assembly = buildEpisodeAssembly({
          slug,
          timeline,
          timelinePreviewReview,
          inputSignatures: (manifest.sources || []).map(manifestSourceSignature),
          ctaGraphicManifest,
          cameraPlan: loaded.camera_plan && !loaded.camera_plan.stale ? loaded.camera_plan : null,
          draft: {
            title: boundedText(body.title, "episode title", 160, { required: true }),
            naming: {
              episode_number: loaded.episode_naming.approval.episode_number,
              production_id: loaded.episode_naming.approval.production_id,
              approval_fingerprint: loaded.episode_naming.approval.approval_fingerprint,
              approved_at: loaded.episode_naming.approval.approved_at,
              approved_by: loaded.episode_naming.approval.approved_by,
              platform_titles: loaded.episode_naming.approval.platform_titles,
            },
            program_start: body.program_start,
            program_end: body.program_end,
            shots: body.shots,
            apply_camera_plan: body.apply_camera_plan === true,
            camera_plan_fingerprint: boundedText(body.camera_plan_fingerprint, "camera plan fingerprint", 128),
            visual_style: {
              program_fade_in_ms: Number(body.visual_style?.program_fade_in_ms ?? 0),
              side_by_side_divider: {
                enabled: body.visual_style?.side_by_side_divider?.enabled === true,
                width_full_px: Number(body.visual_style?.side_by_side_divider?.width_full_px ?? 4),
                color: boundedText(body.visual_style?.side_by_side_divider?.color, "two-shot divider color", 20) || "#23333a",
              },
              camera_balance: {
                enabled: body.visual_style?.camera_balance?.enabled === true,
              },
              camera_framing: {
                enabled: body.visual_style?.camera_framing?.enabled === true,
                sources: body.visual_style?.camera_framing?.sources || {},
              },
            },
            program_graphics: {
              enabled: body.program_graphics?.enabled === true,
              lower_thirds: (Array.isArray(body.program_graphics?.lower_thirds) ? body.program_graphics.lower_thirds : []).slice(0, 20).map((cue) => ({
                start: boundedText(cue.start, "lower-third timestamp", 24, { required: true }),
                duration_ms: Number(cue.duration_ms ?? 6_000),
                host_1_name: boundedText(cue.host_1_name, "Host 1 lower-third name", 80, { required: true }),
                host_2_name: boundedText(cue.host_2_name, "Host 2 lower-third name", 80, { required: true }),
              })),
              topic_bars: (Array.isArray(body.program_graphics?.topic_bars) ? body.program_graphics.topic_bars : []).slice(0, 20).map((cue) => ({
                start: boundedText(cue.start, "topic-bar timestamp", 24, { required: true }),
                duration_ms: Number(cue.duration_ms ?? 6_000),
                title: boundedText(cue.title, "topic-bar title", 120, { required: true }),
                position: boundedText(cue.position ?? "top", "topic-bar position", 10),
              })),
            },
            ...packageDraft,
          },
        });
        writeFileSync(join(dir, "episode_assembly.json"), `${JSON.stringify(assembly, null, 2)}\n`);
        writeFileSync(join(dir, "episode_platform_copy.json"), `${JSON.stringify(episodePlatformCopy(assembly), null, 2)}\n`);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const assemblyReviewMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/assembly-review$/);
      if (req.method === "PUT" && assemblyReviewMatch) {
        const slug = assemblyReviewMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const loaded = loadEpisode(workRoot, slug);
        if (!loaded.episode_assembly || loaded.episode_assembly.stale) {
          throw new Error("save the current episode assembly before reviewing it");
        }
        if (loaded.episode_assembly_state.automatic_direction_required
          && loaded.episode_assembly.camera_direction?.mode !== "automatic_source_bound") {
          throw new Error("build and apply the current source-bound camera plan before approving a two-camera episode recipe");
        }
        const review = buildEpisodeAssemblyReview({
          assembly: loaded.episode_assembly,
          status: boundedText(body.status, "episode assembly review", 20, { required: true }),
          notes: boundedText(body.notes, "episode assembly review notes", 2_000),
        });
        writeFileSync(join(dir, "episode_assembly_review.json"), `${JSON.stringify(review, null, 2)}\n`);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const cameraPlanReviewMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/camera-plan-review$/);
      if (req.method === "PUT" && cameraPlanReviewMatch) {
        const slug = cameraPlanReviewMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const loaded = loadEpisode(workRoot, slug);
        if (!loaded.episode_assembly || loaded.episode_assembly.stale
          || !loaded.camera_plan || loaded.camera_plan.stale
          || !loaded.camera_plan_samples) {
          throw new Error("save the current automatic camera-plan assembly before reviewing it");
        }
        const review = buildCameraPlanReview({
          assembly: loaded.episode_assembly,
          cameraPlan: loaded.camera_plan,
          sampleSet: loaded.camera_plan_samples,
          status: boundedText(body.status, "camera plan review", 20, { required: true }),
          checks: body.checks,
          previewedSampleIds: Array.isArray(body.previewed_sample_ids) ? body.previewed_sample_ids.slice(0, 20) : [],
          notes: boundedText(body.notes, "camera plan review notes", 2_000),
        });
        writeFileSync(join(dir, "camera_plan_review.json"), `${JSON.stringify(review, null, 2)}\n`);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const renderMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/render$/);
      if (req.method === "POST" && renderMatch) {
        const slug = renderMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        requireCurrentReviewContext(dir);
        const clipId = String(body.clip_id || "");
        const clipDoc = readJsonFile(join(dir, "clips.json"), { clips: [] });
        const review = loadReview(dir, clipDoc.clips || []);
        if (review.clips[clipId]?.status !== "approved") throw new Error("approve this candidate before rendering it");
        const clip = (clipDoc.clips || []).find((item) => item.id === clipId);
        if (!clip) throw new Error("candidate not found");
        let script = join(root, "render.mjs");
        let scriptArgs = [script, "--run", dir, "--clip", clipId];
        let sourcePaths = episodeSourcePaths(dir);
        if (clipDoc.schema === "eaol-clips-v2") {
          const loaded = loadEpisode(workRoot, slug);
          if (!loaded.timeline || loaded.timeline.stale || !loaded.speaker_activity || loaded.speaker_activity.stale) {
            throw new Error("build the current aligned timeline and speaker activity before source-bound social rendering");
          }
          const plan = buildSocialEditPlan({
            slug,
            clip,
            timeline: readJsonFile(join(dir, "timeline.json"), null),
            transcriptSegments: loaded.transcript,
            speakerActivitySegments: loaded.speaker_activity.segments || [],
            transcriptFingerprint: loaded.social_state.transcript_fingerprint,
            speakerActivityFingerprint: loaded.speaker_activity.fingerprint,
          });
          const plans = readJsonFile(join(dir, "social_edit_plans.json"), { schema: "eaol-social-edit-plans-v1", plans: {} });
          plans.schema = "eaol-social-edit-plans-v1";
          plans.updated_at = plan.generated_at;
          plans.plans ||= {};
          plans.plans[clipId] = plan;
          writeLocalStudioJson(join(dir, "social_edit_plans.json"), plans);
          script = join(root, "studio", "social_clip_renderer.mjs");
          scriptArgs = [script, "--run", dir, "--clip", clipId];
          sourcePaths = [...plan.video.shots, ...plan.audio.tracks].map((item) => item.source_path);
        }
        const job = startJob({
          ...jobOptions(sourcePaths),
          type: clipDoc.schema === "eaol-clips-v2" ? "social_render" : "render",
          slug,
          args: scriptArgs,
        });
        return sendJson(res, 202, { job });
      }
      const episodeRenderMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/episode-render$/);
      if (req.method === "POST" && episodeRenderMatch) {
        const slug = episodeRenderMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const loaded = loadEpisode(workRoot, slug);
        if (!loaded.episode_assembly_state.render_eligible) {
          if (loaded.episode_assembly_state.automatic_direction_required
            && !loaded.episode_assembly_state.proxy_review_approved) {
            throw new Error("approve the current proxy through a complete watch or metadata-assisted acceptance before rendering the full episode");
          }
          throw new Error("approve the current full-episode recipe before rendering it");
        }
        const assetPaths = [
          loaded.episode_assembly?.opening?.visual?.path,
          loaded.episode_assembly?.opening?.voiceover?.path,
          loaded.episode_assembly?.opening?.music?.path,
          loaded.episode_assembly?.closing?.visual?.path,
          loaded.episode_assembly?.closing?.voiceover?.path,
          loaded.episode_assembly?.closing?.music?.path,
          loaded.episode_assembly?.cta_graphic?.asset?.path,
          loaded.episode_assembly?.newsletter_cta?.asset?.path,
        ].filter(Boolean);
        const job = startJob({
          ...jobOptions([...episodeSourcePaths(dir), ...assetPaths]),
          type: "episode_render",
          slug,
          args: [join(root, "studio", "episode_renderer.mjs"), "--run", dir],
        });
        return sendJson(res, 202, { job });
      }
      const deliveryAudioMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/delivery-audio$/);
      if (req.method === "POST" && deliveryAudioMatch) {
        const slug = deliveryAudioMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const loaded = loadEpisode(workRoot, slug);
        if (!loaded.episode_render || loaded.episode_render.stale) {
          throw new Error("render the current approved full episode before creating RSS audio");
        }
        const job = startJob({
          ...jobOptions([loaded.episode_render.output.path]),
          type: "delivery_audio",
          slug,
          args: [join(root, "studio", "delivery_audio.mjs"), "--run", dir],
        });
        return sendJson(res, 202, { job });
      }
      const deliveryTextMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/delivery-text$/);
      if (req.method === "PUT" && deliveryTextMatch) {
        const slug = deliveryTextMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const loaded = loadEpisode(workRoot, slug);
        if (!loaded.episode_render || loaded.episode_render.stale) {
          throw new Error("render the current approved full episode before building final text");
        }
        if (loaded.speaker_transcript_review?.status !== "approved" || loaded.speaker_transcript_review.stale) {
          throw new Error("approve the current speaker transcript before building final text");
        }
        const body = await readJson(req);
        if (!Array.isArray(body.chapter_lines)) throw new Error("add the chapter timestamps and titles first");
        const chapterLines = body.chapter_lines.slice(0, 100)
          .map((line, index) => boundedText(line, `chapter ${index + 1}`, 120, { required: true }));
        writeDeliveryText(dir, { chapterLines });
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const checklistItemMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/checklist\/([a-z0-9_-]+)$/);
      if (req.method === "PUT" && checklistItemMatch) {
        const slug = checklistItemMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const loaded = loadEpisode(workRoot, slug);
        const checklist = updateEpisodeChecklistItem(
          loaded.episode_checklist,
          checklistItemMatch[2],
          {
            status: body.status,
            notes: body.notes,
            owner: body.owner,
            title: body.title,
            description: body.description,
            archived: body.archived,
          },
        );
        saveEpisodeChecklist(dir, checklist);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const checklistMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/checklist$/);
      if (req.method === "POST" && checklistMatch) {
        const slug = checklistMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const loaded = loadEpisode(workRoot, slug);
        const checklist = addEpisodeChecklistItem(loaded.episode_checklist, {
          title: boundedText(body.title, "checklist item title", 240, { required: true }),
          phase: boundedText(body.phase, "checklist phase", 40, { required: true }),
          owner: boundedText(body.owner, "checklist owner", 100),
          description: boundedText(body.description, "checklist description", 2_000),
        });
        saveEpisodeChecklist(dir, checklist);
        return sendJson(res, 201, { episode: loadEpisode(workRoot, slug) });
      }
      const episodeProxyReviewMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/episode-proxy-review$/);
      if (req.method === "PUT" && episodeProxyReviewMatch) {
        const slug = episodeProxyReviewMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const loaded = loadEpisode(workRoot, slug);
        if (!loaded.episode_proxy || loaded.episode_proxy.stale) {
          throw new Error("render the current low-resolution proxy before reviewing it");
        }
        const review = buildEpisodeProxyReview({
          proxy: loaded.episode_proxy,
          audit: loaded.episode_proxy_audit?.stale ? null : loaded.episode_proxy_audit,
          status: boundedText(body.status, "episode proxy review", 20, { required: true }),
          reviewMode: boundedText(body.review_mode || "complete_watch", "episode proxy review mode", 30, { required: true }),
          checks: body.checks && typeof body.checks === "object" ? body.checks : {},
          notes: boundedText(body.notes, "episode proxy review notes", 2_000),
        });
        writeFileSync(join(dir, "episode_proxy_review.json"), `${JSON.stringify(review, null, 2)}\n`);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const episodeProxyAuditMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/episode-proxy-audit$/);
      if (req.method === "POST" && episodeProxyAuditMatch) {
        const slug = episodeProxyAuditMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const loaded = loadEpisode(workRoot, slug);
        if (!loaded.episode_proxy || loaded.episode_proxy.stale) {
          throw new Error("render the current low-resolution proxy before running its metadata audit");
        }
        const job = startJob({
          ...jobOptions([loaded.episode_proxy.output.path]),
          type: "episode_proxy_audit",
          slug,
          args: [join(root, "studio", "episode_proxy_audit.mjs"), "--run", dir],
        });
        return sendJson(res, 202, { job });
      }
      const audioSequenceReviewMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/audio-sequences\/(host_[12]_audio)\/review$/);
      if (req.method === "PUT" && audioSequenceReviewMatch) {
        const [, slug, role] = audioSequenceReviewMatch;
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const manifestPath = join(dir, "episode.json");
        const manifest = readJsonFile(manifestPath, null);
        if (!manifest) throw new Error("the episode source receipt was not found");
        const sequence = manifest.audio_sequences?.[role];
        if (!sequence) throw new Error("the split-audio sequence was not found");
        const priorReady = sequence.ready === true;
        reviewSequenceSeam(sequence, boundedText(body.seam_id, "seam id", 40, { required: true }), {
          status: boundedText(body.status, "seam review status", 20, { required: true }),
          decision: boundedText(body.decision || "keep_boundary", "seam decision", 80),
          notes: boundedText(body.notes, "seam review notes", 2_000),
        });
        if (sequence.ready && !sequence.derived_source) buildDerivedTrack(sequence, dir);
        const logical = logicalSourceFromSequence(sequence);
        manifest.sources = (manifest.sources || []).filter((source) => source.id !== role);
        if (logical) manifest.sources.push(logical);
        const compatibility = buildCompatibility(manifest.sources);
        const pending = Object.values(manifest.audio_sequences || {}).filter((item) => !item.ready);
        if (pending.length) {
          compatibility.status = compatibility.blocking.length ? "blocked" : "attention";
          compatibility.audio_sequence_status = "review_required";
          compatibility.warnings.push(...pending.map((item) => `${item.label} needs confirmed part order and seam review before it becomes a logical host track.`));
          compatibility.next_step = "Review every split-audio seam before waveform sync or host-track transcription.";
        } else {
          compatibility.audio_sequence_status = "approved";
        }
        manifest.compatibility = compatibility;
        manifest.analyzed_at = new Date().toISOString();
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        if (!priorReady && sequence.ready) {
          resetCandidateReviewContext({
            workDir: dir,
            reason: `${sequence.label} was approved as a new logical source. All downstream approvals must be rebuilt from the complete ordered part set.`,
          });
        }
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const episodeProxyMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/episode-proxy$/);
      if (req.method === "POST" && episodeProxyMatch) {
        const slug = episodeProxyMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const loaded = loadEpisode(workRoot, slug);
        if (!loaded.episode_assembly_state.proxy_eligible) {
          throw new Error(loaded.episode_assembly_state.camera_plan_review_required
            ? "approve the current recipe and every switched camera sample before rendering a proxy"
            : "approve the current recipe before rendering a proxy");
        }
        const assetPaths = [
          loaded.episode_assembly?.opening?.visual?.path,
          loaded.episode_assembly?.opening?.voiceover?.path,
          loaded.episode_assembly?.opening?.music?.path,
          loaded.episode_assembly?.closing?.visual?.path,
          loaded.episode_assembly?.closing?.voiceover?.path,
          loaded.episode_assembly?.closing?.music?.path,
          loaded.episode_assembly?.cta_graphic?.asset?.path,
          loaded.episode_assembly?.newsletter_cta?.asset?.path,
        ].filter(Boolean);
        const job = startJob({
          ...jobOptions([...episodeSourcePaths(dir), ...assetPaths]),
          type: "episode_proxy",
          slug,
          args: [join(root, "studio", "episode_renderer.mjs"), "--run", dir, "--proxy"],
        });
        return sendJson(res, 202, { job });
      }
      const syncMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/sync$/);
      if (req.method === "POST" && syncMatch) {
        const slug = syncMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const intake = readJsonFile(join(dir, "episode.json"), null);
        if (!intake || (intake.sources || []).length < 2) throw new Error("add at least one companion source before sync analysis");
        requireCurrentIntake(intake);
        const job = startJob({
          ...jobOptions(episodeSourcePaths(dir)),
          type: "sync",
          slug,
          args: [join(root, "studio", "sync.mjs"), "--run", dir],
        });
        return sendJson(res, 202, { job });
      }
      const syncReviewMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/sync-review$/);
      if (req.method === "PUT" && syncReviewMatch) {
        const slug = syncReviewMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        if (!REVIEW_STATUSES.has(body.status)) throw new Error("sync review must be pending, approved, or rejected");
        const receipt = readJsonFile(join(dir, "sync.json"), null);
        if (!receipt) throw new Error("run sync analysis before reviewing it");
        const intake = readJsonFile(join(dir, "episode.json"), null);
        if (body.status === "approved" && !syncReceiptMatchesSources(receipt, intake)) {
          throw new Error("source files changed after sync analysis; run source checks and sync again before approval");
        }
        if (body.status === "approved" && receipt.status !== "review_required") {
          throw new Error("low-confidence or blocked sync analysis cannot be approved");
        }
        const review = {
          schema: "eaol-sync-review-v1",
          status: body.status,
          notes: boundedText(body.notes, "sync review notes", 2_000),
          reviewed_at: new Date().toISOString(),
          input_signatures: receipt.input_signatures || [],
        };
        writeFileSync(join(dir, "sync_review.json"), `${JSON.stringify(review, null, 2)}\n`);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const timelineMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/timeline$/);
      if (req.method === "POST" && timelineMatch) {
        const slug = timelineMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const manifest = readJsonFile(join(dir, "episode.json"), null);
        const syncReceipt = readJsonFile(join(dir, "sync.json"), null);
        const syncReview = readJsonFile(join(dir, "sync_review.json"), null);
        if (!manifest || !syncReceipt || !syncReview) {
          throw new Error("complete source intake and confirm sync before building the timeline");
        }
        requireCurrentIntake(manifest);
        const timeline = buildTimeline({ manifest, syncReceipt, syncReview });
        writeFileSync(join(dir, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const timelineReviewMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/timeline-review$/);
      if (req.method === "PUT" && timelineReviewMatch) {
        const slug = timelineReviewMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const manifest = readJsonFile(join(dir, "episode.json"), null);
        const syncReceipt = readJsonFile(join(dir, "sync.json"), null);
        const syncReview = readJsonFile(join(dir, "sync_review.json"), null);
        const timeline = readJsonFile(join(dir, "timeline.json"), null);
        requireCurrentIntake(manifest);
        if (!timelineReceiptMatchesInputs(timeline, manifest, syncReceipt, syncReview)) {
          throw new Error("build the current confirmed timeline before reviewing aligned playback");
        }
        const review = buildTimelinePreviewReview({
          timeline,
          manifest,
          status: body.status,
          checkedStart: body.checked_start,
          checkedEnd: body.checked_end,
          notes: boundedText(body.notes, "playback review notes", 2_000),
        });
        writeFileSync(join(dir, "timeline_preview_review.json"), `${JSON.stringify(review, null, 2)}\n`);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const speakerTranscriptMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/speaker-transcript$/);
      const channelPreflightMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/channel-preflight$/);
      if (req.method === "POST" && channelPreflightMatch) {
        const slug = channelPreflightMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const manifest = readJsonFile(join(dir, "episode.json"), null);
        requireCurrentIntake(manifest);
        const sourceId = boundedText(body.source_id || "primary_camera", "channel preflight source", 80, { required: true });
        if (sourceId === "isolated_masters") {
          const isolated = (manifest.sources || []).filter((item) => ["host_1_audio", "host_2_audio"].includes(item.id));
          if (isolated.length !== 2) throw new Error("attach both assigned isolated transmitter masters first");
          const job = startJob({
            ...jobOptions(isolated.map((source) => source.path)),
            type: "channel_preflight",
            slug,
            args: [join(root, "studio", "channel_preflight.mjs"), "--run", dir, "--source", sourceId],
          });
          return sendJson(res, 202, { job });
        }
        const source = (manifest.sources || []).find((item) => item.id === sourceId);
        if (!source) throw new Error("choose a current episode source for microphone channel validation");
        if (Number(source.audio?.channels || 0) < 2) throw new Error(`${source.label} is not a stereo audio source`);
        const job = startJob({
          ...jobOptions([source.path]),
          type: "channel_preflight",
          slug,
          args: [join(root, "studio", "channel_preflight.mjs"), "--run", dir, "--source", sourceId],
        });
        return sendJson(res, 202, { job });
      }
      const speakerActivityMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/speaker-activity$/);
      if (req.method === "POST" && speakerActivityMatch) {
        const slug = speakerActivityMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const manifest = readJsonFile(join(dir, "episode.json"), null);
        const syncReceipt = readJsonFile(join(dir, "sync.json"), null);
        const syncReview = readJsonFile(join(dir, "sync_review.json"), null);
        const timeline = readJsonFile(join(dir, "timeline.json"), null);
        const channelPreflight = readJsonFile(join(dir, "channel_preflight.json"), null);
        requireCurrentIntake(manifest);
        if (!timelineReceiptMatchesInputs(timeline, manifest, syncReceipt, syncReview)) {
          throw new Error("build the current confirmed timeline before speaker activity");
        }
        if (!channelPreflightMatchesInputs(channelPreflight, manifest) || channelPreflight.status !== "passed") {
          throw new Error("pass the current microphone channel slate before speaker activity");
        }
        const job = startJob({
          ...jobOptions(episodeSourcePaths(dir)),
          type: "speaker_activity",
          slug,
          args: [join(root, "studio", "speaker_activity.mjs"), "--run", dir],
        });
        return sendJson(res, 202, { job });
      }
      const cameraPlanMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/camera-plan$/);
      if (req.method === "POST" && cameraPlanMatch) {
        const slug = cameraPlanMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const manifest = readJsonFile(join(dir, "episode.json"), null);
        const timeline = readJsonFile(join(dir, "timeline.json"), null);
        const channelPreflight = readJsonFile(join(dir, "channel_preflight.json"), null);
        const speakerActivity = readJsonFile(join(dir, "speaker_activity.json"), null);
        requireCurrentIntake(manifest);
        const plan = buildCameraPlan({ manifest, timeline, channelPreflight, speakerActivity });
        writeFileSync(join(dir, "camera_decision_manifest.json"), `${JSON.stringify(plan, null, 2)}\n`);
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      if (req.method === "POST" && speakerTranscriptMatch) {
        const slug = speakerTranscriptMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const manifest = readJsonFile(join(dir, "episode.json"), null);
        const syncReceipt = readJsonFile(join(dir, "sync.json"), null);
        const syncReview = readJsonFile(join(dir, "sync_review.json"), null);
        const timeline = readJsonFile(join(dir, "timeline.json"), null);
        requireCurrentIntake(manifest);
        if (!timelineReceiptMatchesInputs(timeline, manifest, syncReceipt, syncReview)) {
          throw new Error("build the current confirmed timeline before transcribing isolated host tracks");
        }
        const sourceIds = new Set((manifest?.sources || []).map((source) => source.id));
        if (!sourceIds.has("host_1_audio") || !sourceIds.has("host_2_audio")) {
          throw new Error("Host 1 and Host 2 isolated audio are required; speaker identity will not be inferred from camera audio");
        }
        const job = startJob({
          ...jobOptions(episodeSourcePaths(dir)),
          type: "speaker_transcript",
          slug,
          args: [join(root, "studio", "speaker_transcript.mjs"), "--run", dir],
        });
        return sendJson(res, 202, { job });
      }
      const speakerTranscriptReviewMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/speaker-transcript-review$/);
      if (req.method === "PUT" && speakerTranscriptReviewMatch) {
        const slug = speakerTranscriptReviewMatch[1];
        const dir = safeEpisodeDir(workRoot, slug);
        const body = await readJson(req);
        const context = speakerReviewContext(dir);
        requireCurrentIntake(context.manifest, { requireTranscript: true });
        if (!context.speakerCurrent) {
          throw new Error("build the current speaker transcript before reviewing it");
        }
        const review = buildSpeakerTranscriptReview({
          speakerTranscript: context.speakerTranscript,
          manifest: context.manifest,
          timeline: context.timeline,
          status: body.status,
          rolesSwapped: body.roles_swapped,
          edits: body.edits,
          speakerOverrides: body.speaker_overrides,
          dismissedSegmentIds: body.dismissed_segment_ids,
          confirmedOverlapPairIds: body.confirmed_overlap_pair_ids,
        });
        const effective = applySpeakerTranscriptReview(context.speakerTranscript, review);
        const assistant = buildBleedReviewAssistant(effective, review);
        if (review.status === "approved" && assistant.pending_count > 0) {
          throw new Error(`resolve ${assistant.pending_count} likely cross-mic duplicate${assistant.pending_count === 1 ? "" : "s"} with the Studio assistant before confirming the transcript`);
        }
        const priorKey = context.reviewCurrent ? speakerCorrectionKey(context.review) : speakerCorrectionKey(null);
        writeFileSync(join(dir, "speaker_transcript_review.json"), `${JSON.stringify(review, null, 2)}\n`);
        writeFileSync(join(dir, "speaker_transcript_review.srt"), speakerTranscriptReviewSrt(effective));
        if (speakerCorrectionKey(review) !== priorKey) {
          resetCandidateReviewContext({
            workDir: dir,
            updatedAt: review.updated_at,
            reason: "Speaker transcript wording or host-role corrections changed the candidate review context.",
          });
        }
        return sendJson(res, 200, { episode: loadEpisode(workRoot, slug) });
      }
      const openMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/open-output$/);
      if (req.method === "POST" && openMatch) {
        const dir = safeEpisodeDir(workRoot, openMatch[1]);
        const outputDir = join(dir, "clips");
        mkdirSync(outputDir, { recursive: true });
        const command = folderOpenCommand();
        const child = spawn(command, [outputDir], { detached: true, stdio: "ignore" });
        child.unref();
        return sendJson(res, 200, { opened: true, output_dir: outputDir });
      }
      const openEpisodeMatch = pathname.match(/^\/api\/episodes\/([a-z0-9_]+)\/open-episode-output$/);
      if (req.method === "POST" && openEpisodeMatch) {
        const dir = safeEpisodeDir(workRoot, openEpisodeMatch[1]);
        const outputDir = join(dir, "episode");
        mkdirSync(outputDir, { recursive: true });
        const command = folderOpenCommand();
        const child = spawn(command, [outputDir], { detached: true, stdio: "ignore" });
        child.unref();
        return sendJson(res, 200, { opened: true, output_dir: outputDir });
      }
      if (req.method === "POST" && pathname === "/api/pick-file") {
        const body = await readJson(req);
        const picker = filePickerCommand(body.kind);
        if (!picker) throw new Error("the file chooser is unavailable on this platform; paste the full path instead");
        const picked = spawnSync(picker.command, picker.args, { encoding: "utf8" });
        if (picked.status !== 0 || !picked.stdout.trim()) throw new Error("no file was selected");
        return sendJson(res, 200, { path: picked.stdout.trim() });
      }
      if (req.method === "POST" && pathname === "/api/jobs/ingest") {
        const body = await readJson(req);
        if (!String(body.sources?.primary_camera || "").trim()) throw new Error("Host 1 camera is required");
        const definitions = [
          { key: "primary_camera", flag: "--primary-camera", kind: "video", required: true },
          { key: "secondary_camera", flag: "--secondary-camera", kind: "video" },
        ];
        const resolved = [];
        for (const definition of definitions) {
          const raw = String(body.sources?.[definition.key] || "").trim();
          if (!raw && definition.required) throw new Error("Host 1 camera is required");
          if (!raw) continue;
          const input = normalizeUserPath(raw);
          if (!isReadableFile(input)) throw new Error(`${definition.key.replaceAll("_", " ")} was not found or is not readable`);
          const allowed = definition.kind === "video" ? ALLOWED_VIDEO : ALLOWED_AUDIO;
          if (!allowed.has(extname(input).toLowerCase())) {
            throw new Error(`choose a supported ${definition.kind} file for ${definition.key.replaceAll("_", " ")}`);
          }
          resolved.push({ ...definition, input });
        }
        const sequences = [
          { key: "host_1_audio_parts", role: "host_1_audio", flag: "--host-1-audio-part", confirmedFlag: "--host-1-order-confirmed" },
          { key: "host_2_audio_parts", role: "host_2_audio", flag: "--host-2-audio-part", confirmedFlag: "--host-2-order-confirmed" },
        ].map((definition) => {
          const legacy = String(body.sources?.[definition.role] || "").trim();
          const submitted = Array.isArray(body.sources?.[definition.key]) ? body.sources[definition.key] : legacy ? [legacy] : [];
          const inputs = submitted.map((raw) => normalizeUserPath(String(raw || "").trim())).filter(Boolean);
          return { ...definition, inputs, order_confirmed: legacy ? true : body.sources?.[`${definition.role}_order_confirmed`] === true };
        }).filter((sequence) => sequence.inputs.length);
        for (const sequence of sequences) {
          if (!sequence.order_confirmed) throw new Error(`${sequence.role.replaceAll("_", " ")} part order must be confirmed`);
          for (const input of sequence.inputs) {
            if (!isReadableFile(input)) throw new Error(`${sequence.role.replaceAll("_", " ")} part was not found or is not readable`);
            if (!ALLOWED_AUDIO.has(extname(input).toLowerCase())) throw new Error(`choose a supported audio file for ${sequence.role.replaceAll("_", " ")}`);
          }
        }
        const allInputs = [...resolved.map((item) => item.input), ...sequences.flatMap((sequence) => sequence.inputs)];
        if (new Set(allInputs).size !== allInputs.length) {
          throw new Error("each source role must point to a different file");
        }
        const primary = resolved.find((item) => item.key === "primary_camera").input;
        const slug = basename(primary)
          .replace(/\.[^.]+$/, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");
        if (!slug) throw new Error("could not derive an episode name from the Host 1 camera filename");
        const args = [join(root, "studio", "ingest.mjs"), "--work-root", workRoot];
        for (const source of resolved) args.push(source.flag, source.input);
        for (const sequence of sequences) {
          for (const input of sequence.inputs) args.push(sequence.flag, input);
          if (sequence.order_confirmed) args.push(sequence.confirmedFlag);
        }
        const job = startJob({
          ...jobOptions(allInputs),
          type: "ingest",
          slug,
          args,
        });
        return sendJson(res, 202, { job });
      }
      if (req.method === "POST" && pathname === "/api/jobs/transcribe") {
        const body = await readJson(req);
        const input = normalizeUserPath(body.input);
        if (!existsSync(input) || !statSync(input).isFile()) throw new Error("recording was not found at that path");
        if (!ALLOWED_VIDEO.has(extname(input).toLowerCase())) throw new Error("choose an MP4, MOV, M4V, or MKV recording");
        const slug = basename(input)
          .replace(/\.[^.]+$/, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");
        const job = startJob({
          ...jobOptions([input]),
          type: "transcribe",
          slug,
          args: [join(root, "transcribe.mjs"), "--input", input, "--work-root", workRoot],
        });
        return sendJson(res, 202, { job });
      }
      if (req.method === "GET" && pathname === "/api/jobs/active") {
        const activeJobs = [...jobs.values()]
          .map(refreshJob)
          .filter((job) => ["running", "interrupted"].includes(job.status))
          .sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
        return sendJson(res, 200, { jobs: activeJobs.map(publicJob) });
      }
      const jobMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/);
      if (req.method === "GET" && jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return sendError(res, 404, "job not found");
        return sendJson(res, 200, { job: publicJob(refreshJob(job)) });
      }
      if (req.method === "GET" && serveStatic(publicDir, pathname, res)) return;
      sendError(res, 404, "not found");
    } catch (error) {
      sendError(res, Number.isInteger(error.status) ? error.status : 400, error.message || "request failed");
    }
  });
  return server;
}

function main() {
  const host = "127.0.0.1";
  const port = Number(process.env.EAOL_STUDIO_PORT || 4173);
  const server = createStudioServer();
  server.listen(port, host, () => {
    console.log(`Explore AI Out Loud Studio is ready at http://${host}:${port}`);
    console.log("Local only: source media and processing stay on this computer.");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
