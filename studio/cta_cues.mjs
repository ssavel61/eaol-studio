import { createHash } from "node:crypto";
import { loadShowConfig } from "./show_config.mjs";

const REVIEW_STATUSES = new Set(["pending", "confirmed", "dismissed"]);
const ACTION_ORDER = ["like", "comment", "subscribe"];
const CTA_TYPES = new Set(["podcast_growth", "newsletter"]);

// A spoken mention of "newsletter", or of the newsletter name set in
// show.config.json, classifies the cue as a newsletter call to action.
function ctaTypeInText(text) {
  const value = String(text || "").toLowerCase();
  const name = loadShowConfig().links.newsletter_name.toLowerCase();
  return /\bnewsletter\b/.test(value) || (name && value.includes(name)) ? "newsletter" : "podcast_growth";
}

function timestampToMs(value) {
  if (Number.isFinite(value)) return Math.max(0, Math.round(value));
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(String(value || ""));
  if (!match) return null;
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1_000 + Number(match[4]);
}

export function formatCtaTimestamp(value) {
  const total = Math.max(0, Math.round(Number(value || 0)));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const milliseconds = total % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function normalizedSegments(segments) {
  return (segments || []).flatMap((segment, index) => {
    const startMs = timestampToMs(segment.start_ms ?? segment.start);
    const endMs = timestampToMs(segment.end_ms ?? segment.end);
    const text = String(segment.text || "").trim();
    if (startMs === null || endMs === null || endMs <= startMs || !text) return [];
    return [{
      index: index + 1,
      segment_id: String(segment.segment_id || `segment_${String(index + 1).padStart(4, "0")}`),
      start_ms: startMs,
      end_ms: endMs,
      start: formatCtaTimestamp(startMs),
      end: formatCtaTimestamp(endMs),
      speaker_label: segment.speaker_label || null,
      text,
    }];
  });
}

export function ctaTranscriptFingerprint(segments) {
  const stable = normalizedSegments(segments).map((segment) => ({
    segment_id: segment.segment_id,
    start_ms: segment.start_ms,
    end_ms: segment.end_ms,
    speaker_label: segment.speaker_label,
    text: segment.text,
  }));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function actionsInText(text) {
  const normalized = String(text || "").toLowerCase().replace(/[’']/g, "'");
  const bare = new Set(ACTION_ORDER.filter((action) => new RegExp(`\\b${action}(?:s|d|ing)?\\b`, "i").test(normalized)));
  const actions = new Set();
  if (/\bsubscribe(?:d|s|r|rs|ing)?\b/.test(normalized)) actions.add("subscribe");
  if (/\b(?:leave|drop|post|write)\s+(?:us\s+)?(?:a\s+)?comment\b|\bcomments?\s+(?:below|down below)\b|\btell us\s+(?:in\s+)?the comments\b/.test(normalized)) actions.add("comment");
  if (/\b(?:hit|tap|click|smash)\s+(?:the\s+)?like(?:\s+button)?\b|\blike\s+(?:this|the|our)\s+(?:video|episode|show|podcast)\b/.test(normalized)) actions.add("like");
  if (bare.size >= 2) for (const action of bare) actions.add(action);
  return ACTION_ORDER.filter((action) => actions.has(action));
}

function cueFromSegments(segments, actions, source = "detected", ctaType = null) {
  const first = segments[0];
  const last = segments[segments.length - 1];
  const prefix = source === "manual" ? "cta_manual" : "cta_detected";
  return {
    id: `${prefix}_${String(first.index).padStart(4, "0")}_${String(last.index).padStart(4, "0")}`,
    source,
    cta_type: CTA_TYPES.has(ctaType) ? ctaType : ctaTypeInText(segments.map((segment) => segment.text).join(" ")),
    actions: ACTION_ORDER.filter((action) => actions.includes(action)),
    segment_indices: segments.map((segment) => segment.index),
    segment_ids: segments.map((segment) => segment.segment_id),
    start_ms: first.start_ms,
    end_ms: last.end_ms,
    start: first.start,
    end: last.end,
    scrub_from_ms: Math.max(0, first.start_ms - 2_000),
    scrub_to_ms: last.end_ms + 2_000,
    speaker_labels: [...new Set(segments.map((segment) => segment.speaker_label).filter(Boolean))],
    matched_text: segments.map((segment) => segment.text).join(" "),
  };
}

export function detectCtaCues(segments) {
  const normalized = normalizedSegments(segments);
  const matches = normalized.flatMap((segment) => {
    const actions = actionsInText(segment.text);
    return actions.length ? [{ segment, actions, ctaType: ctaTypeInText(segment.text) }] : [];
  });
  const groups = [];
  for (const match of matches) {
    const previous = groups.at(-1);
    if (previous && previous.ctaType === match.ctaType && match.segment.start_ms - previous.segments.at(-1).end_ms <= 3_000) {
      previous.segments.push(match.segment);
      previous.actions = [...new Set([...previous.actions, ...match.actions])];
    } else {
      groups.push({ segments: [match.segment], actions: [...match.actions], ctaType: match.ctaType });
    }
  }
  return groups.map((group) => cueFromSegments(group.segments, group.actions, "detected", group.ctaType));
}

function freshReview(segments, updatedAt) {
  return {
    schema: "eaol-cta-cue-review-v1",
    transcript_fingerprint: ctaTranscriptFingerprint(segments),
    decisions: {},
    manual_cues: [],
    updated_at: updatedAt,
  };
}

export function buildCtaCueState(segments, review = null) {
  const transcriptFingerprint = ctaTranscriptFingerprint(segments);
  const detected = detectCtaCues(segments);
  const reviewCurrent = Boolean(review && review.transcript_fingerprint === transcriptFingerprint);
  const decisions = reviewCurrent ? review.decisions || {} : {};
  const manual = reviewCurrent ? review.manual_cues || [] : [];
  const cues = [...detected, ...manual].map((cue) => ({
    ...cue,
    status: REVIEW_STATUSES.has(decisions[cue.id]?.status) ? decisions[cue.id].status : "pending",
    cta_type: CTA_TYPES.has(decisions[cue.id]?.cta_type) ? decisions[cue.id].cta_type : cue.cta_type,
    notes: String(decisions[cue.id]?.notes || ""),
    reviewed_at: decisions[cue.id]?.reviewed_at || null,
  })).sort((left, right) => left.start_ms - right.start_ms || left.id.localeCompare(right.id));
  return {
    schema: "eaol-cta-cue-state-v1",
    transcript_fingerprint: transcriptFingerprint,
    review_current: reviewCurrent,
    review_stale: Boolean(review && !reviewCurrent),
    review_updated_at: reviewCurrent ? review.updated_at || null : null,
    detected_count: detected.length,
    confirmed_count: cues.filter((cue) => cue.status === "confirmed").length,
    dismissed_count: cues.filter((cue) => cue.status === "dismissed").length,
    cues,
    cue_sheet_file: "cta_graphic_cue_sheet.md",
    manifest_file: "cta_graphic_manifest.json",
    timing_precision: "transcript_segment",
    render_authorized: false,
  };
}

export function updateCtaCueReview({
  segments,
  currentReview = null,
  cueId = null,
  segmentIndex = null,
  status,
  ctaType = null,
  notes = "",
  updatedAt = new Date().toISOString(),
}) {
  if (!REVIEW_STATUSES.has(status)) throw new Error("CTA cue status must be pending, confirmed, or dismissed");
  if (ctaType !== null && !CTA_TYPES.has(ctaType)) throw new Error("CTA cue type must be podcast_growth or newsletter");
  const fingerprint = ctaTranscriptFingerprint(segments);
  const review = currentReview?.transcript_fingerprint === fingerprint
    ? structuredClone(currentReview)
    : freshReview(segments, updatedAt);
  let state = buildCtaCueState(segments, review);
  let targetId = String(cueId || "");

  if (segmentIndex !== null && segmentIndex !== undefined) {
    const index = Number(segmentIndex);
    const normalized = normalizedSegments(segments);
    const segment = normalized.find((item) => item.index === index);
    if (!segment) throw new Error("the selected transcript line is not current");
    const detected = state.cues.find((cue) => cue.source === "detected" && cue.segment_indices.includes(index));
    if (detected) {
      targetId = detected.id;
    } else {
      const manualCue = cueFromSegments([segment], actionsInText(segment.text).length ? actionsInText(segment.text) : ACTION_ORDER, "manual");
      review.manual_cues = (review.manual_cues || []).filter((cue) => cue.id !== manualCue.id);
      review.manual_cues.push(manualCue);
      targetId = manualCue.id;
      state = buildCtaCueState(segments, review);
    }
  }

  if (!state.cues.some((cue) => cue.id === targetId)) throw new Error("CTA cue not found in the current transcript");
  review.decisions ||= {};
  review.decisions[targetId] = {
    status,
    cta_type: CTA_TYPES.has(ctaType) ? ctaType : state.cues.find((cue) => cue.id === targetId)?.cta_type || "podcast_growth",
    notes: String(notes || "").trim().slice(0, 2_000),
    reviewed_at: updatedAt,
  };
  review.updated_at = updatedAt;
  return { review, state: buildCtaCueState(segments, review) };
}

export function buildCtaGraphicManifest({ slug, state, generatedAt = new Date().toISOString() }) {
  const cues = (state?.cues || []).filter((cue) => cue.status === "confirmed").map((cue) => ({
    id: cue.id,
    cta_type: cue.cta_type,
    actions: cue.actions,
    transcript_segment_start: cue.start,
    transcript_segment_end: cue.end,
    scrub_from: formatCtaTimestamp(cue.scrub_from_ms),
    scrub_to: formatCtaTimestamp(cue.scrub_to_ms),
    speaker_labels: cue.speaker_labels,
    matched_text: cue.matched_text,
    editor_action: cue.cta_type === "newsletter"
      ? "Scrub this window, align the separate newsletter-subscription graphic to the spoken newsletter CTA, then play through and confirm timing and obstruction."
      : "Scrub this window, align the podcast like/comment/subscribe graphic to the spoken show-growth CTA, then play through and confirm timing and obstruction.",
    notes: cue.notes || "",
  }));
  return {
    schema: "eaol-cta-graphic-manifest-v2",
    source_slug: slug,
    status: cues.length ? "reviewed_cues_ready" : "no_confirmed_cues",
    transcript_fingerprint: state.transcript_fingerprint,
    cue_review_updated_at: state.review_updated_at,
    generated_at: generatedAt,
    timing_precision: "transcript_segment; scrub and align to the spoken words in the editor",
    graphic_asset: {
      label: "Separate podcast-growth and newsletter-subscription graphics",
      included_in_studio: false,
    },
    render_authorized: false,
    cues,
  };
}

export function ctaGraphicCueSheet(manifest) {
  const lines = [
    "# CTA graphic cue sheet",
    "",
    `**Episode:** ${manifest.source_slug}`,
    `**Generated:** ${manifest.generated_at}`,
    "**Graphics:** Podcast-growth and newsletter-subscription treatments remain separate.",
    "**Timing:** Transcript-segment precision. Scrub the listed window and align the animation to the spoken CTA before approving the edit.",
    "",
  ];
  if (!manifest.cues.length) {
    lines.push("No CTA graphic cues have been confirmed.", "");
    return lines.join("\n");
  }
  for (const [index, cue] of manifest.cues.entries()) {
    lines.push(
      `## ${index + 1}. ${cue.transcript_segment_start} — ${cue.cta_type === "newsletter" ? "newsletter" : "podcast growth"} — ${cue.actions.join(" / ")}`,
      "",
      `- **Scrub window:** ${cue.scrub_from} to ${cue.scrub_to}`,
      `- **Heard:** “${cue.matched_text.replace(/[“”]/g, '"')}”`,
      `- **Editor action:** ${cue.editor_action}`,
      ...(cue.notes ? [`- **Review note:** ${cue.notes}`] : []),
      "",
    );
  }
  return lines.join("\n");
}
