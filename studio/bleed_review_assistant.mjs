const COMMON_SINGLE_WORDS = new Set([
  "yeah", "yes", "no", "okay", "right", "sure", "well", "like", "so", "and", "but", "the", "you", "i",
]);

function segmentId(segment, index) {
  return String(segment?.segment_id || `segment_${String(index + 1).padStart(4, "0")}`);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^>+\s*/, "")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value) {
  return normalizeText(value).split(" ").filter(Boolean);
}

function multisetDice(left, right) {
  const counts = new Map();
  for (const word of left) counts.set(word, (counts.get(word) || 0) + 1);
  let shared = 0;
  for (const word of right) {
    const available = counts.get(word) || 0;
    if (!available) continue;
    shared += 1;
    counts.set(word, available - 1);
  }
  return left.length + right.length ? (2 * shared) / (left.length + right.length) : 0;
}

function textMatch(leftText, rightText) {
  const left = normalizeText(leftText);
  const right = normalizeText(rightText);
  const leftWords = words(leftText);
  const rightWords = words(rightText);
  if (!left || !right) return null;
  const shorter = left.length <= right.length ? left : right;
  const shorterWords = leftWords.length <= rightWords.length ? leftWords : rightWords;
  if (shorterWords.length === 1 && (shorter.length < 5 || COMMON_SINGLE_WORDS.has(shorter))) return null;
  if (left === right) return { score: 1, kind: "exact" };
  if (left.includes(right) || right.includes(left)) {
    return { score: shorterWords.length <= 2 ? 0.9 : 0.95, kind: "contained" };
  }
  const score = multisetDice(leftWords, rightWords);
  const sharedFloor = Math.min(leftWords.length, rightWords.length) >= 4 ? 0.68 : 0.78;
  return score >= sharedFloor ? { score, kind: "similar" } : null;
}

function intervalDistanceMs(left, right) {
  if (left.end_ms < right.start_ms) return right.start_ms - left.end_ms;
  if (right.end_ms < left.start_ms) return left.start_ms - right.end_ms;
  return 0;
}

function recommendation(left, right, match) {
  const leftUncertain = left.dominance_decision === "overlap_or_uncertain";
  const rightUncertain = right.dominance_decision === "overlap_or_uncertain";
  if (leftUncertain !== rightUncertain) return leftUncertain ? left.segment_id : right.segment_id;

  const leftWords = words(left.text).length;
  const rightWords = words(right.text).length;
  if (match.kind === "contained" && leftWords !== rightWords) {
    const shorter = leftWords < rightWords ? left : right;
    if (shorter.dominance_decision !== "assigned_track_dominant") return shorter.segment_id;
  }

  const leftStrength = Math.abs(Number(left.dominance_db || 0));
  const rightStrength = Math.abs(Number(right.dominance_db || 0));
  if (Math.abs(leftStrength - rightStrength) >= 4) return leftStrength < rightStrength ? left.segment_id : right.segment_id;
  return null;
}

function matchReason(match, separationMs) {
  const timing = separationMs === 0 ? "at overlapping times" : `${(separationMs / 1000).toFixed(1)} seconds apart`;
  if (match.kind === "exact") return `The same wording appears on both isolated microphones ${timing}.`;
  if (match.kind === "contained") return `One microphone repeats wording already captured by the other ${timing}.`;
  return `Closely matching wording appears on both isolated microphones ${timing}.`;
}

export function bleedPairId(leftId, rightId) {
  return `bleed_pair:${[leftId, rightId].sort().join(":")}`;
}

export function buildBleedReviewAssistant(segments = [], review = null, { maxSeparationMs = 7_000 } = {}) {
  const prepared = segments.map((segment, index) => ({ ...segment, segment_id: segmentId(segment, index) }));
  const confirmed = new Set(review?.confirmed_overlap_pair_ids || []);
  const candidates = [];

  for (let leftIndex = 0; leftIndex < prepared.length; leftIndex += 1) {
    const left = prepared[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < prepared.length; rightIndex += 1) {
      const right = prepared[rightIndex];
      if (right.start_ms - left.end_ms > maxSeparationMs) break;
      if (left.speaker_id === right.speaker_id) continue;
      const separationMs = intervalDistanceMs(left, right);
      if (separationMs > maxSeparationMs) continue;
      const match = textMatch(left.text, right.text);
      if (!match) continue;
      const timingScore = Math.max(0, 1 - separationMs / maxSeparationMs);
      const confidence = Math.round((match.score * 0.82 + timingScore * 0.18) * 100) / 100;
      if (confidence < 0.72) continue;
      candidates.push({
        id: bleedPairId(left.segment_id, right.segment_id),
        confidence,
        match,
        separation_ms: separationMs,
        segments: [left, right],
      });
    }
  }

  const used = new Set();
  const pairs = [];
  for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence || a.segments[0].start_ms - b.segments[0].start_ms)) {
    if (candidate.segments.some((segment) => used.has(segment.segment_id))) continue;
    candidate.segments.forEach((segment) => used.add(segment.segment_id));
    const dismissed = candidate.segments.filter((segment) => segment.dismissed_as_bleed).map((segment) => segment.segment_id);
    const status = dismissed.length ? "dismissed" : confirmed.has(candidate.id) ? "confirmed_overlap" : "pending";
    const recommendedDismiss = recommendation(candidate.segments[0], candidate.segments[1], candidate.match);
    pairs.push({
      id: candidate.id,
      status,
      confidence: candidate.confidence,
      confidence_label: candidate.confidence >= 0.9 ? "high" : "medium",
      reason: matchReason(candidate.match, candidate.separation_ms),
      recommended_dismiss_segment_id: recommendedDismiss,
      recommendation: recommendedDismiss
        ? "Dismiss the highlighted copy; its cross-mic evidence is weaker."
        : "Listen once and choose which copy is clean, or keep both if two people truly spoke.",
      segments: candidate.segments.map((segment) => ({
        segment_id: segment.segment_id,
        speaker_id: segment.speaker_id,
        speaker_label: segment.speaker_label,
        start: segment.start,
        end: segment.end,
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        text: segment.text,
        dominance_db: segment.dominance_db,
        dominance_decision: segment.dominance_decision,
        dismissed_as_bleed: Boolean(segment.dismissed_as_bleed),
      })),
    });
  }

  const pending = pairs.filter((pair) => pair.status === "pending");
  return {
    schema: "eaol-bleed-review-assistant-v1",
    method: "local_cross_mic_text_timing_and_dominance",
    provider_connected: false,
    automatic_dismissal: false,
    pair_count: pairs.length,
    pending_count: pending.length,
    recommended_count: pending.filter((pair) => pair.recommended_dismiss_segment_id).length,
    resolved_count: pairs.length - pending.length,
    pairs,
  };
}
