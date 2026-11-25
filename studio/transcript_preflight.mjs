import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const words = (text) => String(text || '').toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) || [];

// Discovery for operator QA, never an instruction to remove speech or ask a
// host a question. Chunk-window repetition can also be a real spoken repeat.
export function auditTranscriptPreflight(cues = []) {
  const findings = [];
  const flag = (kind, selected, detail) => findings.push({
    finding_key: `${kind}:${selected.map(c => `${c.chunk ?? 'none'}/${c.source_cue ?? c.id}/${c.start}/${c.end}`).join('|')}`,
    kind, cue_ids: selected.map(c => c.id), source_identity: selected.map(c => ({ id: c.id, chunk: c.chunk, source_cue: c.source_cue, start: c.start, end: c.end })),
    detail, route: 'operator evidence review', automatic_word_deletion: false, human_approval_required: false,
  });
  for (let index = 0; index < cues.length; index++) {
    const current = cues[index];
    if (!Number.isFinite(current.start) || !Number.isFinite(current.end) || current.end <= current.start) {
      flag('invalid_source_span', [current], 'Inspect source words before excluding a zero-duration recognition fragment.');
    }
    if (!index) continue;
    const previous = cues[index - 1];
    const priorWords = words(previous.text), nextWords = words(current.text);
    if (priorWords.at(-1) === 'cloud' && nextWords[0] === 'code') {
      flag('split_product_spelling', [previous, current], 'A product name may be split across the cue boundary ("cloud" then "code"); cue-local replacement misses this case.');
    }
    if (previous.chunk == null || current.chunk == null || previous.chunk === current.chunk || current.start - previous.end > 2) continue;
    const context = [];
    for (let before = index - 1; before >= Math.max(0, index - 3); before--) {
      if (cues[before].chunk !== previous.chunk) break;
      context.unshift(cues[before]);
    }
    const prior = words(context.map(c => c.text).join(' '));
    let repeated = [];
    for (let count = Math.min(6, prior.length, nextWords.length); count >= 2; count--) {
      if (prior.slice(-count).join(' ') === nextWords.slice(0, count).join(' ')) {
        repeated = nextWords.slice(0, count); break;
      }
    }
    if (repeated.length) flag('chunk_boundary_repetition', [...context, current], `Possible overlapping-window duplicate: ${repeated.join(' ')}. Compare source before any repair; preserve a genuine repeat.`);
  }
  return { schema: 'eaol-transcript-preflight-v1', cue_count: cues.length, findings, ready_for_host_questions: false,
    limits: ['Lexical/timing discovery does not prove audible repetition, correctness or a missing word.', 'No media, cue text or acceptance state is changed.', 'Operator triages findings against original sound and existing decisions before escalating a genuine uncertainty.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node studio/transcript_preflight.mjs <finished_cues_DRAFT.json>');
  const draft = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (!Array.isArray(draft.cues)) throw new Error('Expected the preserved source cue array');
  console.log(JSON.stringify(auditTranscriptPreflight(draft.cues), null, 2));
}
