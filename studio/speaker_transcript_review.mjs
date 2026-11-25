import { manifestSourceSignature, sourceReceiptsAreCurrent } from "./sync.mjs";

function signaturesMatch(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function inputSignatures(manifest) {
  return (manifest?.sources || []).map(manifestSourceSignature);
}

export function segmentId(segment, index) {
  return String(segment?.segment_id || `segment_${String(index + 1).padStart(4, "0")}`);
}

function normalizedEdits(edits, segments) {
  const known = new Map(segments.map((segment, index) => [segmentId(segment, index), segment]));
  const result = {};
  for (const [id, rawText] of Object.entries(edits || {})) {
    const segment = known.get(id);
    if (!segment) throw new Error(`unknown transcript segment: ${id}`);
    const text = String(rawText || "").trim();
    if (!text) throw new Error(`${id} transcript text cannot be empty`);
    if (text.length > 2_000) throw new Error(`${id} transcript text is too long`);
    if (text !== String(segment.text || "").trim()) result[id] = text;
  }
  return result;
}

function knownSegments(segments) {
  return new Map(segments.map((segment, index) => [segmentId(segment, index), segment]));
}

function normalizedSpeakerOverrides(overrides, segments) {
  const known = knownSegments(segments);
  const result = {};
  for (const [id, speakerId] of Object.entries(overrides || {})) {
    if (!known.has(id)) throw new Error(`unknown transcript segment: ${id}`);
    if (!new Set(["host_1", "host_2"]).has(speakerId)) throw new Error(`${id} speaker must be host_1 or host_2`);
    result[id] = speakerId;
  }
  return result;
}

function normalizedDismissedIds(ids, segments) {
  const known = knownSegments(segments);
  const unique = [...new Set(Array.isArray(ids) ? ids.map(String) : [])];
  for (const id of unique) {
    if (!known.has(id)) throw new Error(`unknown transcript segment: ${id}`);
  }
  return unique.sort();
}

function normalizedConfirmedOverlapPairIds(ids, segments) {
  const known = new Set([...knownSegments(segments).keys()]);
  const unique = [...new Set(Array.isArray(ids) ? ids.map(String) : [])];
  for (const id of unique) {
    const match = id.match(/^bleed_pair:(segment_\d+):(segment_\d+)$/);
    if (!match || !known.has(match[1]) || !known.has(match[2]) || match[1] === match[2]) {
      throw new Error(`unknown bleed-review pair: ${id}`);
    }
  }
  return unique.sort();
}

export function applySpeakerTranscriptReview(speakerTranscript, review = null) {
  const swapped = Boolean(review?.roles_swapped);
  const edits = review?.edits || {};
  const speakerOverrides = review?.speaker_overrides || {};
  const dismissed = new Set(review?.dismissed_segment_ids || []);
  return (speakerTranscript?.segments || []).map((segment, index) => {
    const id = segmentId(segment, index);
    const assignedSpeakerId = swapped
      ? segment.speaker_id === "host_1" ? "host_2" : segment.speaker_id === "host_2" ? "host_1" : segment.speaker_id
      : segment.speaker_id;
    const speakerId = speakerOverrides[id] || assignedSpeakerId;
    const speakerLabel = speakerId === "host_1" ? "Host 1" : speakerId === "host_2" ? "Host 2" : segment.speaker_label;
    return {
      ...segment,
      segment_id: id,
      speaker_id: speakerId,
      speaker_label: speakerLabel,
      text: edits[id] || segment.text,
      corrected: Object.hasOwn(edits, id) || Object.hasOwn(speakerOverrides, id),
      speaker_corrected: Object.hasOwn(speakerOverrides, id),
      dismissed_as_bleed: dismissed.has(id),
    };
  });
}

export function buildSpeakerTranscriptReview({
  speakerTranscript,
  manifest,
  timeline,
  status,
  rolesSwapped = false,
  edits = {},
  speakerOverrides = {},
  dismissedSegmentIds = [],
  confirmedOverlapPairIds = [],
  updatedAt = new Date().toISOString(),
}) {
  if (!speakerTranscript || !manifest || !timeline) {
    throw new Error("build the current speaker transcript before reviewing it");
  }
  if (!new Set(["draft", "approved"]).has(status)) {
    throw new Error("speaker transcript review must be draft or approved");
  }
  const normalized = normalizedEdits(edits, speakerTranscript.segments || []);
  const normalizedOverrides = normalizedSpeakerOverrides(speakerOverrides, speakerTranscript.segments || []);
  const normalizedDismissed = normalizedDismissedIds(dismissedSegmentIds, speakerTranscript.segments || []);
  const normalizedConfirmedOverlaps = normalizedConfirmedOverlapPairIds(confirmedOverlapPairIds, speakerTranscript.segments || []);
  return {
    schema: "eaol-speaker-transcript-review-v3",
    status,
    base_transcript_generated_at: speakerTranscript.generated_at,
    timeline_generated_at: timeline.generated_at,
    input_signatures: inputSignatures(manifest),
    roles_swapped: Boolean(rolesSwapped),
    edits: normalized,
    speaker_overrides: normalizedOverrides,
    dismissed_segment_ids: normalizedDismissed,
    confirmed_overlap_pair_ids: normalizedConfirmedOverlaps,
    wording_correction_count: Object.keys(normalized).length,
    speaker_correction_count: Object.keys(normalizedOverrides).length,
    dismissed_bleed_count: normalizedDismissed.length,
    confirmed_overlap_pair_count: normalizedConfirmedOverlaps.length,
    correction_count: Object.keys(normalized).length + Object.keys(normalizedOverrides).length + normalizedDismissed.length,
    updated_at: updatedAt,
    reviewed_at: status === "approved" ? updatedAt : null,
    render_authorized: false,
  };
}

export function speakerTranscriptReviewMatchesInputs(review, speakerTranscript, manifest, timeline) {
  if (!review || !speakerTranscript || !manifest || !timeline || timeline.stale) return false;
  const signatures = inputSignatures(manifest);
  return sourceReceiptsAreCurrent(manifest.sources || [])
    && review.base_transcript_generated_at === speakerTranscript.generated_at
    && review.timeline_generated_at === timeline.generated_at
    && signaturesMatch(review.input_signatures, signatures);
}

function srtTimestamp(value) {
  const total = Math.max(0, Math.round(Number(value || 0)));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const milliseconds = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

export function speakerTranscriptReviewSrt(segments) {
  return `${segments.filter((segment) => !segment.dismissed_as_bleed).map((segment, index) => [
    index + 1,
    `${srtTimestamp(segment.start_ms)} --> ${srtTimestamp(segment.end_ms)}`,
    `[${segment.speaker_label}] ${segment.text}`,
  ].join("\n")).join("\n\n")}\n`;
}
