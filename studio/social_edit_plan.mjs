import { createHash } from "node:crypto";
import { SOCIAL_QUALITY_VERSION, validateCaptionSpans } from "./social_captions.mjs";

export const SOCIAL_EDIT_PLAN_SCHEMA = "eaol-social-edit-plan-v1";

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function timestampMs(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(String(value || ""));
  if (!match) throw new Error("clip timestamps must use HH:MM:SS.mmm");
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1_000 + Number(match[4]);
}

function timelineTrack(timeline, sourceId, kind) {
  const track = (timeline?.tracks || []).find((item) => item.source_id === sourceId && item.media_kind === kind);
  if (!track) throw new Error(`${sourceId} is missing from the approved timeline`);
  return track;
}

function sourceRange(track, startMs, endMs) {
  const rate = Number(track.alignment?.playback_rate || 1);
  return {
    source_start_ms: Number(track.source_in_ms || 0) + (startMs - Number(track.timeline_start_ms || 0)) * rate,
    source_end_ms: Number(track.source_in_ms || 0) + (endMs - Number(track.timeline_start_ms || 0)) * rate,
    playback_rate: rate,
  };
}

function transcriptSpans(segments, startMs, endMs) {
  return segments
    .filter((segment) => !segment.dismissed_as_bleed && Number(segment.end_ms) > startMs && Number(segment.start_ms) < endMs)
    .map((segment) => ({
      segment_id: segment.segment_id,
      speaker_id: segment.speaker_id,
      start_ms: Number(segment.start_ms),
      end_ms: Number(segment.end_ms),
      text: String(segment.text || "").trim(),
    }))
    .filter((segment) => segment.end_ms > segment.start_ms && segment.text && segment.text !== "[BLANK_AUDIO]");
}

function speakerBlocks(spans) {
  const blocks = [];
  for (const span of spans) {
    const prior = blocks.at(-1);
    if (prior && prior.speaker_id === span.speaker_id && span.start_ms - prior.end_ms <= 1_200) {
      prior.end_ms = span.end_ms;
      prior.segment_ids.push(span.segment_id);
      prior.text_ms += span.end_ms - span.start_ms;
    } else {
      blocks.push({
        speaker_id: span.speaker_id,
        start_ms: span.start_ms,
        end_ms: span.end_ms,
        text_ms: span.end_ms - span.start_ms,
        segment_ids: [span.segment_id],
      });
    }
  }
  return blocks;
}

function cameraForSpeaker(speakerId) {
  return speakerId === "host_2" ? "secondary_camera" : "primary_camera";
}

export function buildSocialEditPlan({
  slug,
  clip,
  timeline,
  transcriptSegments,
  speakerActivitySegments = [],
  transcriptFingerprint,
  speakerActivityFingerprint,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!clip || !/^clip_\d{3}$/.test(clip.id || "")) throw new Error("a valid approved clip is required");
  if (!timeline?.generated_at) throw new Error("a current approved timeline is required");
  if (!transcriptFingerprint) throw new Error("a current reviewed transcript fingerprint is required");
  const startMs = timestampMs(clip.start);
  const endMs = timestampMs(clip.end);
  const spans = validateCaptionSpans(transcriptSpans(transcriptSegments || [], startMs, endMs), startMs, endMs);
  const blocks = speakerBlocks(spans);
  for (const block of blocks) {
    const measured = (speakerActivitySegments || [])
      .filter((item) => item.state === block.speaker_id && Number(item.end_ms) > block.start_ms && Number(item.start_ms) < block.end_ms)
      .reduce((total, item) => total + Math.max(0, Math.min(block.end_ms, Number(item.end_ms)) - Math.max(block.start_ms, Number(item.start_ms))), 0);
    block.substantive_ms = measured || block.text_ms;
  }
  const shots = [];
  let activeSpeaker = blocks[0].speaker_id === "host_2" ? "host_2" : "host_1";
  let shotStart = startMs;
  let switchCount = 0;
  for (const block of blocks.slice(1)) {
    if (switchCount >= 4 || block.speaker_id === activeSpeaker || !["host_1", "host_2"].includes(block.speaker_id)) continue;
    if (block.substantive_ms < 4_000 || block.start_ms - shotStart < 5_000) continue;
    shots.push({ start_ms: shotStart, end_ms: block.start_ms, speaker_id: activeSpeaker });
    shotStart = block.start_ms;
    activeSpeaker = block.speaker_id;
    switchCount += 1;
  }
  shots.push({ start_ms: shotStart, end_ms: endMs, speaker_id: activeSpeaker });
  if (shots.length > 1 && shots.at(-1).end_ms - shots.at(-1).start_ms < 5_000) {
    shots.at(-2).end_ms = shots.at(-1).end_ms;
    shots.pop();
  }
  const videoShots = shots.map((shot, index) => {
    const sourceId = cameraForSpeaker(shot.speaker_id);
    const track = timelineTrack(timeline, sourceId, "video");
    return {
      id: `shot_${String(index + 1).padStart(3, "0")}`,
      timeline_start_ms: shot.start_ms,
      timeline_end_ms: shot.end_ms,
      speaker_id: shot.speaker_id,
      source_id: sourceId,
      source_path: track.source_path,
      ...sourceRange(track, shot.start_ms, shot.end_ms),
    };
  });
  const audioTracks = ["host_1_audio", "host_2_audio"].map((sourceId) => {
    const track = timelineTrack(timeline, sourceId, "audio");
    return {
      source_id: sourceId,
      source_path: track.source_path,
      timeline_start_ms: startMs,
      timeline_end_ms: endMs,
      ...sourceRange(track, startMs, endMs),
    };
  });
  const core = {
    schema: SOCIAL_EDIT_PLAN_SCHEMA,
    quality_policy_version: SOCIAL_QUALITY_VERSION,
    status: "render_ready",
    generated_at: generatedAt,
    source_slug: slug,
    clip_id: clip.id,
    clip_fingerprint: hash(clip),
    timeline_generated_at: timeline.generated_at,
    transcript_fingerprint: transcriptFingerprint,
    speaker_activity_fingerprint: speakerActivityFingerprint,
    duration_ms: endMs - startMs,
    video: {
      width: 1080,
      height: 1920,
      frame_rate: 30,
      shots: videoShots,
      policy: {
        first_substantive_speaker: true,
        minimum_substantive_turn_ms: 4_000,
        minimum_shot_ms: 5_000,
        maximum_automatic_switches: 4,
        backchannels_and_uncertain_overlap_ignored: true,
      },
    },
    audio: { sample_rate: 48_000, tracks: audioTracks, isolated_mix: true },
    captions: spans,
    hook_overlay: String(clip.hook_overlay || "").trim() || null,
    crop_offset_px: Number(clip.crop_offset_px || 0),
    review_required: true,
    external_copy_authorized: false,
    publication_authorized: false,
  };
  return { ...core, fingerprint: hash(core) };
}
