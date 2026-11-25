// A layout policy, not word alignment or editorial approval.
export const SOCIAL_QUALITY_VERSION = "social-quality-2026-09-10";
const MAX_LINE_CHARS = 30;

export function captionText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function validateCaptionSpans(captions, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("social caption range must have a finite start and later end");
  }
  if (!Array.isArray(captions) || !captions.length) throw new Error("the clip has no reviewed transcript captions");
  const sorted = captions.map((cue) => ({ ...cue, text: captionText(cue.text) }))
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  let prior = null;
  for (const cue of sorted) {
    const label = cue.segment_id || "unnamed cue";
    if (!Number.isFinite(cue.start_ms) || !Number.isFinite(cue.end_ms) || cue.end_ms <= cue.start_ms || !cue.text) {
      throw new Error(`caption ${label} has invalid text or timing; review the transcript`);
    }
    if (cue.start_ms < startMs || cue.end_ms > endMs) {
      throw new Error(`clip boundary cuts caption ${label}; move the boundary to include the whole cue or review its text and timing`);
    }
    if (/[{}\\]/.test(cue.text)) throw new Error(`caption ${label} contains subtitle control characters; review the literal text before rendering`);
    if (prior && cue.start_ms < prior.end_ms) {
      throw new Error(`captions ${prior.segment_id || "unnamed cue"} and ${label} overlap; review bleed versus real simultaneous speech and timing before rendering`);
    }
    prior = cue;
  }
  return sorted;
}

export function captionLines(value) {
  const words = captionText(value).split(" ").filter(Boolean);
  const lines = [];
  for (const word of words) {
    if (word.length > MAX_LINE_CHARS) throw new Error("a caption word exceeds the line width; review its spelling or caption layout");
    if (!lines.length || `${lines.at(-1)} ${word}`.length > MAX_LINE_CHARS) lines.push(word);
    else lines[lines.length - 1] += ` ${word}`;
  }
  // Avoid a lone final word where a lossless rebalance fits the same width.
  if (lines.length > 1 && !lines.at(-1).includes(" ")) {
    const previous = lines.at(-2).split(" ");
    const balanced = `${previous.at(-1)} ${lines.at(-1)}`;
    if (previous.length > 2 && balanced.length <= MAX_LINE_CHARS) {
      lines[lines.length - 2] = previous.slice(0, -1).join(" ");
      lines[lines.length - 1] = balanced;
    }
  }
  return lines;
}

export function buildCaptionLayout(captions, startMs, endMs) {
  const cues = validateCaptionSpans(captions, startMs, endMs);
  const pages = [];
  const warnings = [];
  for (const cue of cues) {
    const lines = captionLines(cue.text);
    const groups = [];
    for (let i = 0; i < lines.length; i += 2) groups.push(lines.slice(i, i + 2));
    // Rebalance a short final page instead of flashing an orphan phrase. Move
    // only whole words, in order, and retain the two-line width constraint.
    for (let index = groups.length - 1; index > 0; index -= 1) {
      const priorWords = groups[index - 1].join(" ").split(" ");
      const currentWords = groups[index].join(" ").split(" ");
      while (priorWords.length > 2
        && priorWords.join(" ").length > currentWords.join(" ").length + 2 * priorWords.at(-1).length + 1) {
        const proposed = [priorWords.at(-1), ...currentWords];
        if (captionLines(proposed.join(" ")).length > 2) break;
        currentWords.unshift(priorWords.pop());
      }
      groups[index - 1] = captionLines(priorWords.join(" "));
      groups[index] = captionLines(currentWords.join(" "));
    }
    // ASS timing uses centiseconds. Quantize once, so adjacent pages meet
    // without overlaps, and never extend outside the accepted cue.
    const startTick = Math.ceil((cue.start_ms - startMs) / 10);
    const endTick = Math.floor((cue.end_ms - startMs) / 10);
    const totalWeight = groups.reduce((sum, group) => sum + group.join(" ").length, 0);
    let weight = 0;
    let cursor = startTick;
    for (const group of groups) {
      weight += group.join(" ").length;
      const next = startTick + Math.floor((endTick - startTick) * weight / totalWeight);
      if (next <= cursor) throw new Error(`caption ${cue.segment_id} is too short to paginate; review its timing`);
      pages.push({ segment_id: cue.segment_id, speaker_id: cue.speaker_id, start_ms: cursor * 10, end_ms: next * 10, lines: group });
      if (next - cursor < 84) warnings.push(`Caption ${cue.segment_id}: a page lasts less than 0.84s; check readability.`);
      if (next - cursor > 700) warnings.push(`Caption ${cue.segment_id}: a page lasts over 7s; check speech timing.`);
      cursor = next;
    }
    if (groups.length > 1) warnings.push(`Caption ${cue.segment_id}: page timing is estimated within its transcript cue; listen for synchronization.`);
  }
  return {
    policy_version: SOCIAL_QUALITY_VERSION,
    timing_basis: "reviewed_segment_bounds_with_proportional_page_timing",
    pages,
    warnings,
    checks: {
      at_most_two_lines: pages.every((page) => page.lines.length <= 2),
      complete_caption_text: pages.flatMap((page) => page.lines).join(" ") === cues.map((cue) => cue.text).join(" "),
      no_overlapping_pages: pages.every((page, index) => !index || page.start_ms >= pages[index - 1].end_ms),
    },
  };
}

export function isDuplicateOpeningHook(hook, captions, startMs) {
  const normalize = (value) => captionText(value).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  const opening = normalize(captions.filter((cue) => cue.start_ms < startMs + 3_000).map((cue) => cue.text).join(" "));
  const text = normalize(hook);
  return Boolean(text && (` ${opening} `).includes(` ${text} `));
}
