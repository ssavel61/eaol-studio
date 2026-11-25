import { createHash } from "node:crypto";
import { loadShowConfig } from "./show_config.mjs";

export const SOCIAL_SUGGESTIONS_SCHEMA = "eaol-social-suggestions-v1";
export const SOCIAL_SUGGESTION_ENGINE = "deterministic_local_v2";

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "because", "before", "being", "could", "from", "have", "into",
  "just", "like", "more", "really", "that", "their", "there", "these", "they", "this", "those", "what",
  "when", "where", "which", "with", "would", "your", "youre", "we're", "were", "then", "than", "them",
]);

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function words(value) {
  return String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

function keywords(value) {
  return new Set(words(value).filter((word) => word.length > 3 && !STOP_WORDS.has(word)));
}

function jaccard(left, right) {
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / union.size;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function titleFrom(text) {
  const source = cleanText(text).replace(/^["'“”]+|["'“”.,!?]+$/g, "");
  const picked = source.split(/\s+/).slice(0, 9).join(" ");
  return picked.length > 72 ? `${picked.slice(0, 69).trim()}…` : picked;
}

function classify(text) {
  const lower = text.toLowerCase();
  if (/\b(most people|myth|not .* but|instead of|the mistake)\b/.test(lower)) return "myth_correction";
  if (/\b(i remember|i tried|we tried|when i|when we|happened|failed|started)\b/.test(lower)) return "story";
  if (/\b(how to|you can|you should|the way to|step|workflow|use this|do this)\b/.test(lower)) return "takeaway";
  if (/\b(i disagree|don't agree|push back|on the other hand|but i think)\b/.test(lower)) return "disagreement";
  if (/\b\d+(?:\.\d+)?%?\b/.test(lower)) return "surprising_fact";
  if (/\?$/.test(text.trim())) return "question";
  if (/\b(the point is|what matters|the reason|i think|we believe)\b/.test(lower)) return "thesis";
  return "explainer";
}

// Words that name the show's subject come from social.topic_keywords in
// show.config.json; a clip that says its topic early is easier to find.
let cachedTopicPattern;
function topicPattern() {
  if (cachedTopicPattern === undefined) {
    const words = loadShowConfig().social.topic_keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    cachedTopicPattern = words.length ? new RegExp(`\\b(${words.join("|")})\\b`) : null;
  }
  return cachedTopicPattern;
}

function signalsFor(text) {
  const lower = text.toLowerCase();
  const result = [];
  if (/\b(most people|not .* but|instead of|the mistake)\b/.test(lower)) result.push("counterintuitive or corrective claim");
  if (/\b(how to|you can|you should|step|workflow|use this|do this)\b/.test(lower)) result.push("practical takeaway");
  if (/\b(i remember|i tried|we tried|when i|when we|happened|failed|started)\b/.test(lower)) result.push("concrete first-person story");
  if (/\b\d+(?:\.\d+)?%?\b/.test(lower)) result.push("specific number or detail");
  if (/\b(but|however|actually|instead|surprised|unexpected)\b/.test(lower)) result.push("contrast or turn");
  if (/\?$/.test(text.trim())) result.push("discussion question");
  if (topicPattern() && topicPattern().test(lower)) result.push("topic stated aloud");
  if (!result.length && words(text).length >= 35) result.push("extended explanatory passage; completeness needs review");
  return result;
}

function flagsFor(text, durationMs) {
  const flags = [];
  const lower = text.toLowerCase();
  if (/^(and|but|so|because|it|this|that|they|he|she|we)\b/.test(lower)) flags.push("opening may depend on earlier context");
  if (/\b(as i said|like i said|earlier|this chart|as you can see|on the screen)\b/.test(lower)) flags.push("check missing prior or visual context");
  if (/\b(and|but|because|so|or|that|which|we|they|the|a|an|to|of)\s*[.!?]?$/.test(lower)) flags.push("ending may stop before the payoff");
  if (/\b(clip tool|studio|closing music|camera angle|recording setup|edit this|cut this|our intro|the intro)\b/.test(lower)) flags.push("production-planning language; verify value to a viewer outside the recording");
  if (durationMs > 60_000) flags.push("over 60 seconds; verify the extra duration earns its place and contains no unverified music");
  return flags;
}

function segmentStart(segment) {
  return Number.isFinite(Number(segment.start_ms)) ? Number(segment.start_ms) : 0;
}

function segmentEnd(segment) {
  return Number.isFinite(Number(segment.end_ms)) ? Number(segment.end_ms) : segmentStart(segment);
}

function timestamp(ms) {
  const safe = Math.max(0, Math.round(ms));
  const h = Math.floor(safe / 3_600_000);
  const m = Math.floor((safe % 3_600_000) / 60_000);
  const s = Math.floor((safe % 60_000) / 1_000);
  const milli = safe % 1_000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

function candidateWindows(segments, { programStartMs, programEndMs }) {
  const usable = segments.filter((segment) => {
    const text = cleanText(segment.text);
    return text && text !== "[BLANK_AUDIO]" && !segment.dismissed_as_bleed
      && Number.isFinite(Number(segment.start_ms)) && Number.isFinite(Number(segment.end_ms))
      && segmentEnd(segment) > segmentStart(segment)
      && segmentStart(segment) >= programStartMs && segmentEnd(segment) <= programEndMs;
  }).sort((a, b) => segmentStart(a) - segmentStart(b) || segmentEnd(a) - segmentEnd(b));
  const windows = [];
  for (let startIndex = 0; startIndex < usable.length; startIndex += 1) {
    const first = usable[startIndex];
    const firstSignals = signalsFor(cleanText(first.text));
    if (!firstSignals.length) continue;
    let endIndex = -1;
    let shorterEnd = -1;
    for (let index = startIndex; index < usable.length; index += 1) {
      const current = usable[index];
      const duration = segmentEnd(current) - segmentStart(first);
      if (duration > 90_000 || (index > startIndex && segmentStart(current) - segmentEnd(usable[index - 1]) > 2_500)) break;
      const text = cleanText(current.text);
      const endsSentence = /[.!?]["'”’)]?$/.test(text) && !/(?:\.\.\.|…)\s*["'”’)]?$/.test(text);
      const unfinished = /\b(and|but|because|so|or|that|which|we|they|the|a|an|to|of)\s*[.!?]?["'”’)]?$/i.test(text);
      if (duration < 15_000 || !endsSentence || unfinished) continue;
      shorterEnd = index;
      if (duration >= 25_000) { endIndex = index; break; }
    }
    if (endIndex < 0) endIndex = shorterEnd;
    if (endIndex < 0) continue;
    const selected = usable.slice(startIndex, endIndex + 1);
    const startMs = segmentStart(selected[0]);
    const endMs = segmentEnd(selected.at(-1));
    const durationMs = endMs - startMs;
    if (durationMs < 15_000 || durationMs > 90_000) continue;
    const text = cleanText(selected.map((segment) => segment.text).join(" "));
    const signals = signalsFor(text);
    const flags = flagsFor(text, durationMs);
    if (selected.some((cue, index) => index && segmentStart(cue) < segmentEnd(selected[index - 1]))) flags.push("overlapping transcript cues need review before rendering");
    const speakers = [...new Set(selected.map((segment) => segment.speaker_id).filter(Boolean))];
    windows.push({
      startMs, endMs, durationMs, text, signals, flags, speakers,
      category: classify(text),
      segmentIds: selected.map((segment) => segment.segment_id).filter(Boolean),
      contextBefore: cleanText(usable[startIndex - 1]?.text).slice(-500),
      contextAfter: cleanText(usable[endIndex + 1]?.text).slice(0, 500),
      keywordSet: keywords(text),
      merit: signals.length * 4 + Math.min(3, Math.floor(words(text).length / 25)) - flags.length * 3
        + (durationMs >= 25_000 && durationMs <= 60_000 ? 2 : 0),
    });
  }
  return windows.sort((left, right) => right.merit - left.merit || left.startMs - right.startMs);
}

function clusterWindows(windows) {
  const clusters = [];
  for (const window of windows) {
    let index = clusters.findIndex((cluster) => jaccard(cluster.keywords, window.keywordSet) >= 0.62
      || Math.max(cluster.startMs, window.startMs) < Math.min(cluster.endMs, window.endMs));
    if (index < 0) {
      index = clusters.length;
      clusters.push({ keywords: window.keywordSet, startMs: window.startMs, endMs: window.endMs });
    }
    window.clusterId = `cluster_${String(index + 1).padStart(3, "0")}`;
  }
  return windows;
}

function nextClipNumber(existingClips) {
  return Math.max(0, ...existingClips.map((clip) => Number(/^clip_(\d+)$/.exec(clip.id || "")?.[1] || 0))) + 1;
}

export function buildSocialSuggestions({
  slug,
  segments,
  transcriptFingerprint,
  speakerActivityFingerprint = null,
  assemblyFingerprint = null,
  programStartMs = 0,
  programEndMs = Number.MAX_SAFE_INTEGER,
  existingClips = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!/^[a-z0-9_]+$/.test(String(slug || ""))) throw new Error("a valid source slug is required");
  if (!Array.isArray(segments) || !segments.length) throw new Error("a current reviewed transcript is required");
  if (!transcriptFingerprint) throw new Error("the reviewed transcript fingerprint is required");
  const clustered = clusterWindows(candidateWindows(segments, { programStartMs, programEndMs }));
  const chosen = [];
  const clusters = new Set();
  const categoryCounts = new Map();
  const episodeSpan = Math.max(1, programEndMs - programStartMs);
  for (const window of clustered) {
    if (chosen.length >= 6) break;
    if (clusters.has(window.clusterId)) continue;
    if ((categoryCounts.get(window.category) || 0) >= 2) continue;
    const position = (window.startMs - programStartMs) / episodeSpan;
    if (chosen.some((item) => Math.abs(item.position - position) < 0.08) && clustered.length > 12) continue;
    chosen.push({ ...window, position });
    clusters.add(window.clusterId);
    categoryCounts.set(window.category, (categoryCounts.get(window.category) || 0) + 1);
  }
  // Diversity is a preference, not a quota that should hide otherwise distinct
  // ideas. If the transcript has fewer supported category shapes, fill the
  // alternate slots from different clusters and disclose the resulting mix.
  for (const window of clustered) {
    if (chosen.length >= 6) break;
    if (clusters.has(window.clusterId)) continue;
    chosen.push({ ...window, position: (window.startMs - programStartMs) / episodeSpan });
    clusters.add(window.clusterId);
  }
  if (!chosen.length) throw new Error("the reviewed transcript did not contain a complete 15–90 second suggestion window");
  const firstNumber = nextClipNumber(existingClips);
  const suggestions = chosen.map((window, index) => ({
    id: `clip_${String(firstNumber + index).padStart(3, "0")}`,
    start: timestamp(window.startMs),
    end: timestamp(window.endMs),
    title: titleFrom(window.text),
    hook: window.text.split(/(?<=[.!?])\s+/)[0].slice(0, 500),
    rationale: `${window.signals.join("; ")}. Review the quoted transcript boundaries and the listed weaknesses before approval.`,
    crop_offset_px: 0,
    segment_ids: window.segmentIds,
    proposed_by: "studio",
    proposed_at: generatedAt,
    origin: "suggestion",
    category: window.category,
    cluster_id: window.clusterId,
    signals: window.signals,
    flags: window.flags,
    boundary_notes: [
      `Starts on transcript segment ${window.segmentIds[0] || "without a segment ID"}.`,
      `Ends on transcript segment ${window.segmentIds.at(-1) || "without a segment ID"}.`,
      "Sentence punctuation is a proposal boundary, not proof the thought is complete; listen to the surrounding context.",
      ...(window.contextBefore ? [`Before: ${window.contextBefore}`] : []),
      ...(window.contextAfter ? [`After: ${window.contextAfter}`] : []),
    ],
    recommendation: index < 3 ? "recommended" : "alternate",
    speaker_balance: window.speakers,
  }));
  const receiptCore = {
    schema: SOCIAL_SUGGESTIONS_SCHEMA,
    status: "review_required",
    generated_at: generatedAt,
    source_slug: slug,
    transcript_fingerprint: transcriptFingerprint,
    speaker_activity_fingerprint: speakerActivityFingerprint,
    assembly_fingerprint: assemblyFingerprint,
    policy: {
      engine: SOCIAL_SUGGESTION_ENGINE,
      complete_segment_boundaries: true,
      automatic_headline_overlay: false,
      provider_calls: false,
      preferred_duration_sec: [25, 60],
      allowed_duration_sec: [15, 90],
      recommended_count: 3,
      alternate_count: 3,
      unexplained_virality_score: false,
      one_candidate_per_idea_cluster: true,
    },
    suggestions,
  };
  return { ...receiptCore, fingerprint: hash(receiptCore), render_authorized: false, publication_authorized: false };
}
