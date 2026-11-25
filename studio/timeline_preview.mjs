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

export function timelineTimeToSourceMs(track, timelineMs) {
  const timelineStart = Number(track?.timeline_start_ms || 0);
  const timelineEnd = Number(track?.timeline_end_ms || 0);
  const time = Number(timelineMs);
  if (!Number.isFinite(time) || time < timelineStart || time > timelineEnd) return null;
  const rate = Number(track?.alignment?.playback_rate || 1);
  const sourceIn = Number(track?.source_in_ms || 0);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(sourceIn + (time - timelineStart) * rate);
}

export function timelinePreviewMatchesInputs(receipt, timeline, manifest) {
  if (!receipt || !timeline || !manifest || timeline.stale) return false;
  const signatures = inputSignatures(manifest);
  return sourceReceiptsAreCurrent(manifest.sources || [])
    && receipt.timeline_generated_at === timeline.generated_at
    && signaturesMatch(receipt.input_signatures, signatures);
}

export function buildTimelinePreviewReview({
  timeline,
  manifest,
  status,
  checkedStart = false,
  checkedEnd = false,
  notes = "",
  reviewedAt = new Date().toISOString(),
}) {
  if (!timeline || !manifest) throw new Error("build the current aligned timeline before reviewing playback");
  if ((timeline.tracks || []).filter((track) => track.media_kind === "video").length < 2) {
    throw new Error("two camera tracks are required for aligned camera preview review");
  }
  if (!new Set(["pending", "approved", "rejected"]).has(status)) {
    throw new Error("timeline preview review must be pending, approved, or rejected");
  }
  if (status === "approved" && (!checkedStart || !checkedEnd)) {
    throw new Error("check both the start and end of aligned playback before approval");
  }
  return {
    schema: "eaol-timeline-preview-review-v1",
    status,
    checked_start: Boolean(checkedStart),
    checked_end: Boolean(checkedEnd),
    notes: String(notes || ""),
    reviewed_at: reviewedAt,
    timeline_generated_at: timeline.generated_at,
    input_signatures: inputSignatures(manifest),
    render_authorized: false,
  };
}
