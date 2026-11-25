// Reversible transcript preparation for an agent or a person. No recognizer calls or media writes.
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditTranscriptPreflight } from './transcript_preflight.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tokens = text => String(text || '').toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) || [];
export const transcriptSourceKey = cue => hash([cue.chunk ?? null, cue.source_cue ?? null, cue.start, cue.end, cue.asr_text ?? cue.text]);
const validSpan = (cue, duration) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start && cue.end <= duration;

function timedWords(cue) {
  if (!Number.isFinite(cue.window_start_sec)) return [];
  const words = [];
  for (const token of cue.tokens || []) {
    if (token.id >= 50257 || !tokens(token.text).length || !token.offsets) continue;
    const start = cue.window_start_sec + token.offsets.from / 1000, end = cue.window_start_sec + token.offsets.to / 1000;
    if (end <= start) return []; // Invalid token timing cannot justify ownership.
    if (/^\s/.test(token.text) || !words.length) words.push({ text: token.text.trim(), start, end });
    else { words.at(-1).text += token.text; words.at(-1).end = end; }
  }
  return words.map(w => ({ ...w, text: tokens(w.text).join(' ') }));
}

function overlapAlignment(cue, retained) {
  const wanted = timedWords(cue);
  if (!wanted.length || wanted.map(w => w.text).join(' ') !== tokens(cue.text).join(' ')) return null;
  const candidates = retained.filter(r => r.chunk !== cue.chunk && r.end >= cue.start - .5 && r.start <= cue.end + .5);
  const available = candidates.flatMap(r => timedWords(r).map(w => ({ ...w, source_key: r.source_key }))).sort((a,b) => a.start-b.start);
  for (let index = 0; index <= available.length - wanted.length; index++) {
    const match = available.slice(index, index + wanted.length);
    if (wanted.every((w,i) => w.text === match[i].text && Math.abs(w.start-match[i].start) <= .25 && Math.abs(w.end-match[i].end) <= .25)) return { method: 'ordered_actual_token_times_250ms', retained_source_keys: [...new Set(match.map(w => w.source_key))], word_count: wanted.length };
  }
  return null;
}

export function auditCaptionCoverage(cues, pages, duration, exceptions = []) {
  const findings = [], byId = new Map(cues.map(c => [c.id, c])), covered = new Set();
  const exceptionById = new Map(exceptions.map(e => [e.caption_id, e]));
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index], ids = page.source_cue_ids || [page.id], sources = ids.map(id => byId.get(id));
    if (!validSpan(page, duration)) findings.push({ kind: 'invalid_caption_span', caption_id: page.id });
    if (index && pages[index - 1].end > page.start + .001) findings.push({ kind: 'caption_overlap', caption_id: page.id });
    if (sources.some(s => !s)) { findings.push({ kind: 'unknown_caption_source', caption_id: page.id, source_cue_ids: ids }); continue; }
    ids.forEach(id => covered.add(id));
    const expected = sources.map(s => s.text).join(' '), exception = exceptionById.get(page.id);
    const textMatches = tokens(expected).join(' ') === tokens(page.text).join(' ');
    const exceptionMatches = exception && exception.reason && exception.evidence && exception.authority && exception.before === expected && exception.after === page.text;
    if (!textMatches && !exceptionMatches) findings.push({ kind: 'caption_words_differ', caption_id: page.id, expected, actual: page.text });
    // Compare to every constituent's original speech span, not the clipped
    // previous page. These are operator signals, not asserted word onsets.
    const first = Math.min(...sources.map(s => s.start)), last = Math.max(...sources.map(s => s.end));
    if (page.start > first + .001 || page.end < last - .001) findings.push({ kind: 'caption_constituent_span_clipped', caption_id: page.id, expected_start: first, expected_end: last, actual_start: page.start, actual_end: page.end });
  }
  for (const cue of cues) if (!covered.has(cue.id)) findings.push({ kind: 'uncaptioned_source_words', source_key: cue.source_key || transcriptSourceKey(cue), cue_id: cue.id, text: cue.text });
  for (const exception of exceptions) if (!pages.some(p => p.id === exception.caption_id)) findings.push({ kind: 'stale_caption_exception', caption_id: exception.caption_id });
  return findings;
}

export function prepareTranscript(input) {
  if (!Array.isArray(input.cues) || !Number.isFinite(input.duration_sec) || input.duration_sec <= 0 || !/^[a-f0-9]{64}$/.test(input.source_cut_sha256 || '')) throw new Error('Supply cues, duration_sec and exact source_cut_sha256');
  const original = structuredClone(input.cues), raw = structuredClone(input.raw_cues || input.cues);
  const output = original.map(c => ({ ...c, source_key: transcriptSourceKey(c) })), ledger = [], blockers = [];
  if (!Array.isArray(input.raw_cues)) blockers.push({ kind: 'raw_coverage_not_supplied' });
  const byKey = new Map(output.map(c => [c.source_key, c]));
  if (byKey.size !== output.length) throw new Error('Source identities must be unique');
  if (new Set(output.map(c => c.id)).size !== output.length) throw new Error('Display cue IDs must be unique within this draft');
  const rawByKey = new Map(raw.map(c => [transcriptSourceKey(c), c]));
  for (const cue of output) if (!rawByKey.has(cue.source_key)) blockers.push({ kind: 'untraced_draft_cue', source_key: cue.source_key });
  const envelope = input.decisions || { source_cut_sha256: input.source_cut_sha256, items: [] };
  if (envelope.source_cut_sha256 !== input.source_cut_sha256) throw new Error('Stale decision master binding');
  const disposed = new Set();
  for (const decision of envelope.items || []) {
    if (!decision.reason || !decision.evidence || !decision.authority) throw new Error('Every correction needs reason, evidence and authority');
    const rawCue = rawByKey.get(decision.source_key), current = byKey.get(decision.source_key);
    if (!rawCue || decision.expected_text !== rawCue.text) throw new Error('Stale decision source/text identity');
    if (disposed.has(decision.source_key)) throw new Error('Conflicting decisions for one source cue');
    disposed.add(decision.source_key);
    if (decision.action === 'exclude_overlap_copy' || decision.action === 'exclude_non_speech') {
      if (decision.action === 'exclude_overlap_copy') {
        const retained = byKey.get(decision.retained_source_key);
        if (!retained || retained.source_key === decision.source_key || retained.chunk === rawCue.chunk || Math.abs(retained.start - rawCue.start) > 2 || tokens(retained.text).join(' ') !== tokens(rawCue.text).join(' ')) throw new Error('Overlap exclusion must identify a matching retained source at this seam');
      }
      if (current) output.splice(output.indexOf(current), 1);
      byKey.delete(decision.source_key);
      ledger.push({ ...decision, original: rawCue, after: null });
    } else if (decision.action === 'replace' || decision.action === 'restore') {
      if (decision.action === 'replace' && !current) throw new Error('Cannot replace an absent cue; restore it explicitly');
      if (decision.action === 'restore' && current) throw new Error('Cannot restore an existing cue');
      const updated = { ...rawCue, ...decision.after, source_key: decision.source_key };
      if (updated.chunk !== rawCue.chunk || updated.source_cue !== rawCue.source_cue || updated.asr_text !== rawCue.asr_text || updated.id !== rawCue.id) throw new Error('A correction cannot rewrite source identity');
      if (!updated.text?.trim() || !validSpan(updated, input.duration_sec)) throw new Error('Resolved speech needs words and a valid measured span');
      if (current) output[output.indexOf(current)] = updated; else output.push(updated);
      byKey.set(decision.source_key, updated);
      ledger.push({ ...decision, original: rawCue, after: updated });
    } else throw new Error('Unknown source disposition');
  }
  output.sort((a, b) => a.start - b.start);
  // Supplied spelling rules are bounded to source identities and exact words.
  // Never globally convert ordinary cloud/code language or invent versions.
  for (const rule of input.name_rules || []) {
    if (!rule.evidence || !rule.source_keys?.length || tokens(rule.before).length !== tokens(rule.after).length || /\d/.test(rule.before + rule.after)) throw new Error('Name rules require source context, evidence and spelling-only words');
    const selected = rule.source_keys.map(key => byKey.get(key));
    if (selected.some(c => !c)) throw new Error('Stale name rule source identity');
    const positions = selected.map(c => output.indexOf(c));
    if (positions.some((p, i) => i && p !== positions[i - 1] + 1) || selected.some((c, i) => i && (c.start - selected[i - 1].end > .5 || c.speaker !== selected[i - 1].speaker))) throw new Error('Split name rule must use adjacent same-speaker context');
    const beforeWords = rule.before.split(/\s+/), afterWords = rule.after.split(/\s+/);
    const combined = selected.map(c => c.text).join(' '), escaped = rule.before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`\\b${escaped}\\b`, 'i').exec(combined);
    if (!match) throw new Error('Name spelling no longer matches source context');
    // Map the single matched phrase back onto original cue boundaries.
    let offset = 0, wordIndex = 0;
    for (const cue of selected) {
      const old = cue.text, lo = Math.max(0, match.index - offset), hi = Math.min(old.length, match.index + match[0].length - offset);
      if (hi > lo) {
        const piece = old.slice(lo, hi), count = piece.trim().split(/\s+/).length;
        const replacement = afterWords.slice(wordIndex, wordIndex + count).join(' ');
        wordIndex += count; cue.text = old.slice(0, lo) + replacement + old.slice(hi);
      }
      offset += old.length + 1;
    }
    if (wordIndex !== beforeWords.length) throw new Error('Name rule would change token coverage');
    ledger.push({ action: 'context_spelling', source_keys: rule.source_keys, before: combined, after: selected.map(c => c.text).join(' '), evidence: rule.evidence });
  }
  const coverage = raw.map(c => {
    const key = transcriptSourceKey(c), kept = byKey.has(key), decision = ledger.find(d => d.source_key === key);
    const alignment = !kept && !decision && validSpan(c, input.duration_sec) ? overlapAlignment(c, output) : null;
    return { source_key: key, original: c, status: kept ? 'retained' : decision ? 'explicit_disposition' : alignment ? 'overlap_alignment_supported' : 'unresolved_missing_source', decision: decision?.action || null, alignment };
  });
  for (const cue of output) {
    const source = rawByKey.get(cue.source_key);
    const recordedChange = ledger.some(d => d.source_key === cue.source_key || d.source_keys?.includes(cue.source_key));
    if (source && source.text !== cue.text && !recordedChange) blockers.push({kind:'unlogged_source_text_change',source_key:cue.source_key,before:source.text,after:cue.text});
  }
  for (const row of coverage) if (row.status === 'unresolved_missing_source') blockers.push({ kind: row.status, source_key: row.source_key, text: row.original.text });
  const preflight = auditTranscriptPreflight(output);
  blockers.push(...preflight.findings);
  blockers.push(...output.filter(c => c.start < 0 || c.end > input.duration_sec).map(c => ({kind:'source_outside_master_bounds',source_key:c.source_key,start:c.start,end:c.end})));
  const captionFindings = input.caption_cues ? auditCaptionCoverage(output, input.caption_cues, input.duration_sec, input.caption_exceptions) : [{ kind: 'captions_not_supplied' }];
  blockers.push(...captionFindings);
  return { schema: 'eaol-transcript-preparation-v1', source_cut_sha256: input.source_cut_sha256, input_sha256: hash(input), duration_sec: input.duration_sec,
    cues: output, caption_cues: structuredClone(input.caption_cues || []), quarantine: output.filter(c => !validSpan(c, input.duration_sec)), raw_coverage: coverage, correction_ledger: ledger, findings: blockers,
    operator_status: blockers.length ? 'operator_resolution_required' : 'structural_checks_pass', human_approved: false, release_ready: false,
    review_route: 'Operator resolves source/caption mechanics and existing decisions first; hosts receive genuine unresolved wording, attribution or editorial choices only.',
    limits: ['Source ASR spans and lexical agreement do not prove audible words, mouth sync or word onset.', 'No source file, accepted episode, approval or media is rewritten.', 'Structural success is not final transcript or release acceptance.'] };
}

// Read all windows before ownership filtering, including zero-duration speech.
export function readRecognitionWindows(plan, baseDir) {
  if (!Array.isArray(plan.chunks) || !Number.isFinite(plan.duration_sec)) throw new Error('Chunk plan needs chunks and duration_sec');
  const cues = [], raw_cues = [], markers = [];
  for (const chunk of plan.chunks) {
    if (!Number.isFinite(chunk.start_sec) || !Number.isFinite(chunk.owner_start_sec) || !Number.isFinite(chunk.owner_end_sec) || chunk.owner_end_sec <= chunk.owner_start_sec) throw new Error('Each chunk needs explicit ownership interval');
    const path = resolve(baseDir, chunk.path || `${chunk.output_prefix}.json`), data = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(data.transcription)) throw new Error('Expected original whisper.cpp transcription');
    data.transcription.forEach((row, index) => {
      const text = String(row.text || '').trim().replace(/^>\s*/, '').replace(/\s+/g, ' ');
      if (!text) return;
      const cue = { id: `${chunk.id}:${index}`, chunk: chunk.id, source_cue: index, window_start_sec: chunk.start_sec, start: row.offsets.from / 1000 + chunk.start_sec, end: row.offsets.to / 1000 + chunk.start_sec, text, asr_text: text, tokens: row.tokens || [] };
      if (/^(\[[^\]]+\]|\([^)]+\))$/.test(text)) { markers.push(cue); return; }
      raw_cues.push(cue);
      const mid = (cue.start + cue.end) / 2;
      if (mid >= chunk.owner_start_sec && mid < chunk.owner_end_sec) cues.push(cue);
    });
  }
  cues.sort((a,b) => a.start-b.start); raw_cues.sort((a,b) => a.start-b.start);
  return { source_cut_sha256: plan.source_cut_sha256, duration_sec: plan.duration_sec, cues, raw_cues, non_speech_markers: markers };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inputPath, outputDir] = process.argv.slice(2);
  if (!inputPath || !outputDir) throw new Error('Usage: npm run transcript:prepare -- <input.json> <NEW-output-directory>');
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  const report = prepareTranscript(input.chunk_plan ? { ...readRecognitionWindows(input.chunk_plan, dirname(resolve(inputPath))), ...input } : input);
  mkdirSync(outputDir, { recursive: false });
  writeFileSync(resolve(outputDir, 'transcript_preparation.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(resolve(outputDir, 'OPERATOR_REVIEW.md'), `# Transcript preparation\n\n${report.operator_status}. ${report.findings.length} operator findings.\n\n${report.review_route}\n\nPreserved raw coverage and source-bound changes are in transcript_preparation.json. No host queue or approval was created.\n`, { flag: 'wx' });
  console.log(JSON.stringify({ status: report.operator_status, findings: report.findings.length, quarantined: report.quarantine.length, output: resolve(outputDir) }));
  if (report.findings.length) process.exitCode = 2;
}
