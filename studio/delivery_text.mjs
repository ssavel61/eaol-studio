import { validateReleaseChapters, episodeNumber } from './release_policy.mjs';
import { loadShowConfig } from './show_config.mjs';
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { applySpeakerTranscriptReview, speakerTranscriptReviewMatchesInputs } from "./speaker_transcript_review.mjs";

const MIN_CHAPTER_MS = 10_000;

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function fileSha256(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function fileReceipt(path) {
  const stat = statSync(path);
  return {
    path,
    file: basename(path),
    bytes: stat.size,
    modified_ms: Math.round(stat.mtimeMs),
    sha256: fileSha256(path),
  };
}

function renderSignature(render) {
  return {
    assembly_fingerprint: render.assembly_fingerprint,
    path: render.output.path,
    bytes: Number(render.output.bytes),
    modified_ms: Number(render.output.modified_ms),
  };
}

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

export function timestamp(ms, separator = ".") {
  const total = Math.max(0, Math.round(Number(ms || 0)));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const milliseconds = total % 1_000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(milliseconds, 3)}`;
}

function chapterTimestamp(ms) {
  const totalSeconds = Math.floor(Math.max(0, Number(ms || 0)) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function chapterTimestampMs(value) {
  const parts = String(value || "").trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  const seconds = numbers.length === 3
    ? numbers[0] * 3_600 + numbers[1] * 60 + numbers[2]
    : numbers[0] * 60 + numbers[1];
  if ((numbers.at(-1) || 0) >= 60 || (numbers.length === 3 && numbers[1] >= 60)) return null;
  return seconds * 1_000;
}

export function parseChapterLines(lines) {
  if (!Array.isArray(lines)) throw new Error("chapters must be a list of timestamp and title lines");
  return lines.filter((line) => String(line || "").trim()).map((line, index) => {
    const match = /^(\d{1,3}:\d{2}(?::\d{2})?)\s+(.+)$/.exec(String(line).trim());
    if (!match) throw new Error(`chapter ${index + 1} must look like 00:00 Title`);
    const startMs = chapterTimestampMs(match[1]);
    const title = match[2].trim();
    if (startMs === null) throw new Error(`chapter ${index + 1} has an invalid timestamp`);
    if (!title || title.length > 100) throw new Error(`chapter ${index + 1} title must be 1-100 characters`);
    return { index: index + 1, start_ms: startMs, start: chapterTimestamp(startMs), title };
  });
}

export function validateChapters(chapters, durationMs, number = null) {
  if (!Array.isArray(chapters) || chapters.length < 3) throw new Error("add at least three chapters");
  if (chapters.length > 100) throw new Error("chapters are limited to 100 entries");
  if (chapters[0].start_ms !== 0) throw new Error("the first chapter must start at 00:00");
  for (let index = 0; index < chapters.length; index += 1) {
    const current = chapters[index];
    const endMs = chapters[index + 1]?.start_ms ?? durationMs;
    if (current.start_ms >= durationMs) throw new Error(`chapter ${index + 1} starts after the episode ends`);
    if (endMs <= current.start_ms) throw new Error("chapter timestamps must increase");
    if (endMs - current.start_ms < MIN_CHAPTER_MS) {
      throw new Error(`chapter ${index + 1} must last at least 10 seconds`);
    }
  }
  validateReleaseChapters(chapters, durationMs, number);
  return chapters;
}

export function suggestChapterLines(durationMs, openingDurationMs = 0, number = null) {
  // Segment boundaries require transcript/editorial evidence, never arbitrary thirds.
  const rules = loadShowConfig().release.chapters;
  if (rules.enforce_from_episode && number >= rules.enforce_from_episode) return [];
  const duration = Math.floor(Number(durationMs || 0));
  if (duration < MIN_CHAPTER_MS * 3) return [];
  const second = Math.max(MIN_CHAPTER_MS, Math.floor(Math.max(openingDurationMs, duration / 3) / 1_000) * 1_000);
  const third = Math.min(duration - MIN_CHAPTER_MS, Math.max(second + MIN_CHAPTER_MS, Math.floor(duration * 2 / 3 / 1_000) * 1_000));
  if (third - second < MIN_CHAPTER_MS) return [];
  return [
    `00:00 Opening and welcome`,
    `${chapterTimestamp(second)} Main conversation`,
    `${chapterTimestamp(third)} Closing thoughts`,
  ];
}

export function mapTranscriptToFinalTimeline(segments, assembly, render) {
  const openingDurationMs = Math.round(Number((render.segments || []).find((segment) => segment.type === "opening")?.duration_sec || 0) * 1_000);
  const programStartMs = Number(assembly.program.start_ms);
  const programEndMs = Number(assembly.program.end_ms);
  return (segments || []).flatMap((segment) => {
    // Review preserves dismissed cues for reversibility; delivery must omit them.
    if (segment.dismissed_as_bleed === true) return [];
    const sourceStart = Math.max(programStartMs, Number(segment.start_ms));
    const sourceEnd = Math.min(programEndMs, Number(segment.end_ms));
    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart) return [];
    return [{
      ...segment,
      source_start_ms: sourceStart,
      source_end_ms: sourceEnd,
      start_ms: openingDurationMs + sourceStart - programStartMs,
      end_ms: openingDurationMs + sourceEnd - programStartMs,
    }];
  });
}

function srt(segments) {
  return `${segments.map((segment, index) => [
    index + 1,
    `${timestamp(segment.start_ms, ",")} --> ${timestamp(segment.end_ms, ",")}`,
    `[${String(segment.speaker_label || "Speaker").replace(/\s+/g, " ").trim()}] ${String(segment.text || "").replace(/\s+/g, " ").trim()}`,
  ].join("\n")).join("\n\n")}\n`;
}

function vttText(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\s+/g, " ").trim();
}

function vtt(segments) {
  return `WEBVTT\n\n${segments.map((segment) => [
    `${timestamp(segment.start_ms)} --> ${timestamp(segment.end_ms)}`,
    `<v ${vttText(segment.speaker_label || "Speaker")}>${vttText(segment.text)}`,
  ].join("\n")).join("\n\n")}\n`;
}

function readableTranscript({ title, segments, render, assembly }) {
  const openingDurationMs = Math.round(Number((render.segments || []).find((segment) => segment.type === "opening")?.duration_sec || 0) * 1_000);
  const closingStartMs = openingDurationMs + Number(assembly.program.duration_ms);
  const lines = [
    `# ${title}`,
    "",
    `## Opening — ${timestamp(0).slice(0, 8)}`,
    "",
    openingDurationMs ? "Opening package. Narration is not included unless it appears in the approved program transcript." : "No separate opening package.",
    "",
    `## Program — ${timestamp(openingDurationMs).slice(0, 8)}`,
    "",
  ];
  for (const segment of segments) {
    lines.push(`**${timestamp(segment.start_ms).slice(0, 8)} — ${segment.speaker_label}:** ${segment.text}`, "");
  }
  lines.push(
    `## Closing — ${timestamp(closingStartMs).slice(0, 8)}`,
    "",
    (render.segments || []).some((segment) => segment.type === "closing")
      ? "Closing package. Narration is not included unless it appears in the approved program transcript."
      : "No separate closing package.",
    "",
  );
  return lines.join("\n");
}

export function deliveryTextMatchesInputs(receipt, render, speakerTranscript, review) {
  if (!receipt || !render || !speakerTranscript || !review || receipt.status !== "complete") return false;
  if (JSON.stringify(receipt.source_render) !== JSON.stringify(renderSignature(render))) return false;
  if (receipt.transcript_generated_at !== speakerTranscript.generated_at || receipt.transcript_reviewed_at !== review.reviewed_at) return false;
  try {
    return Object.values(receipt.files || {}).every((file) => {
      const stat = statSync(file.path);
      return stat.isFile() && stat.size === Number(file.bytes) && Math.round(stat.mtimeMs) === Number(file.modified_ms);
    }) && Object.values(receipt.checks || {}).every(Boolean);
  } catch {
    return false;
  }
}

export function writeDeliveryText(workDir, { chapterLines, generatedAt = new Date().toISOString() } = {}) {
  const dir = String(workDir || "");
  const render = readJson(join(dir, "episode_render.json"));
  const assembly = readJson(join(dir, "episode_assembly.json"));
  const manifest = readJson(join(dir, "episode.json"));
  const timeline = readJson(join(dir, "timeline.json"));
  const speakerTranscript = readJson(join(dir, "speaker_transcript.json"));
  const review = readJson(join(dir, "speaker_transcript_review.json"));
  if (!render || render.status !== "complete" || render.quality !== "full" || render.full_render_authorized !== true) {
    throw new Error("a current approved full-episode render is required before building final text");
  }
  const renderStat = statSync(render.output.path);
  if (!renderStat.isFile() || renderStat.size !== Number(render.output.bytes) || Math.round(renderStat.mtimeMs) !== Number(render.output.modified_ms)) {
    throw new Error("the full-episode render changed after its receipt was written");
  }
  if (!assembly || assembly.plan_fingerprint !== render.assembly_fingerprint) {
    throw new Error("the approved episode recipe no longer matches the full render");
  }
  if (!speakerTranscript || !review || review.status !== "approved"
    || !speakerTranscriptReviewMatchesInputs(review, speakerTranscript, manifest, timeline)) {
    throw new Error("approve the current speaker transcript before building final captions");
  }
  const effectiveSegments = applySpeakerTranscriptReview(speakerTranscript, review);
  const finalSegments = mapTranscriptToFinalTimeline(effectiveSegments, assembly, render);
  if (!finalSegments.length) throw new Error("the approved transcript has no cues inside the final program range");
  const durationMs = Math.round(Number(render.output.duration_sec || 0) * 1_000);
  if (durationMs <= 0) throw new Error("the full-render receipt has no usable duration");
  const chapters = validateChapters(parseChapterLines(chapterLines), durationMs, episodeNumber(assembly));
  const outputDir = join(dir, "episode");
  mkdirSync(outputDir, { recursive: true });
  const paths = {
    srt: join(outputDir, "episode_captions.srt"),
    vtt: join(outputDir, "episode_captions.vtt"),
    transcript: join(outputDir, "episode_transcript.md"),
    chapters: join(outputDir, "episode_chapters.txt"),
  };
  writeFileSync(paths.srt, srt(finalSegments));
  writeFileSync(paths.vtt, vtt(finalSegments));
  writeFileSync(paths.transcript, readableTranscript({ title: assembly.title, segments: finalSegments, render, assembly }));
  writeFileSync(paths.chapters, `${chapters.map((chapter) => `${chapter.start} ${chapter.title}`).join("\n")}\n`);
  const files = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, fileReceipt(path)]));
  const openingDurationMs = Math.round(Number((render.segments || []).find((segment) => segment.type === "opening")?.duration_sec || 0) * 1_000);
  const receipt = {
    schema: "eaol-delivery-text-v1",
    status: "complete",
    generated_at: generatedAt,
    source_slug: render.source_slug,
    source_render: renderSignature(render),
    transcript_generated_at: speakerTranscript.generated_at,
    transcript_reviewed_at: review.reviewed_at,
    assembly_fingerprint: assembly.plan_fingerprint,
    timeline_map: {
      opening_duration_ms: openingDurationMs,
      program_source_start_ms: assembly.program.start_ms,
      program_source_end_ms: assembly.program.end_ms,
      closing_start_ms: openingDurationMs + assembly.program.duration_ms,
      final_duration_ms: durationMs,
    },
    caption_count: finalSegments.length,
    chapters,
    files,
    checks: {
      captions_present: finalSegments.length > 0,
      caption_bounds: finalSegments.every((segment) => segment.start_ms >= 0 && segment.end_ms <= durationMs && segment.end_ms > segment.start_ms),
      first_chapter_zero: chapters[0].start_ms === 0,
      chapter_count: chapters.length >= 3,
      chapter_minimum_duration: chapters.every((chapter, index) => (chapters[index + 1]?.start_ms ?? durationMs) - chapter.start_ms >= MIN_CHAPTER_MS),
    },
    external_copy_authorized: false,
    upload_authorized: false,
    publication_authorized: false,
  };
  writeFileSync(join(dir, "delivery_text.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
