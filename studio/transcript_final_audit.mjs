// Read-only final audit. No ASR calls, media edits, or inferred human approval.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { prepareTranscript } from './transcript_prepare.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const words = text => String(text || '').replaceAll('’', "'").match(/[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*|%/gu) || [];
const flat = text => String(text || '').replace(/\s+/g,' ').trim();
const close = (a,b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) < .0011;
const seconds = stamp => stamp.replace(',', '.').split(':').reduce((a,b) => 60*a + Number(b), 0);
const stamp = n => `${Math.floor(n/60)}:${(n%60).toFixed(3).padStart(6,'0')}`;

export function parseCaptions(text, format) {
  let value = text.replaceAll('\r','').trim();
  if (format === 'vtt') {
    if (!value.startsWith('WEBVTT\n')) throw new Error('Missing WEBVTT header');
    value = value.slice(7).trim();
  }
  return value.split(/\n\s*\n/).map((block,index) => {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0])) {
      if (Number(lines.shift()) !== index+1) throw new Error('Caption numbering is not sequential');
    } else if (format === 'srt') throw new Error('Missing SRT cue number');
    const match = /^(\d{2,}:\d{2}:\d{2}[.,]\d{3}) --> (\d{2,}:\d{2}:\d{2}[.,]\d{3})$/.exec(lines.shift());
    if (!match || !lines.length || !lines.join('').trim()) throw new Error(`Malformed ${format} caption ${index+1}`);
    for (const time of match.slice(1)) if (Number(time.slice(-6,-4)) >= 60 || Number(time.split(':')[1]) >= 60) throw new Error('Invalid clock component');
    return {start:seconds(match[1]),end:seconds(match[2]),text:lines.join('\n')};
  });
}

function speakerWords(cue) {
  const parts = cue.speaker_parts || [{speaker:cue.speaker,text:cue.text}];
  return parts.flatMap(p => words(p.text).map(w => [p.speaker,w]));
}

export function auditFinalTranscript(input) {
  const {draft:d, preparation, source_asr, transcript, srt, vtt, owner_decisions = [], caption_approval,
    reviews = [], triage = [], draft_sha256, media_sha256} = input;
  const checks = [], findings = [], accepted = [];
  const check = (id, ok, detail) => checks.push({id,status:ok?'PASS':'FAIL',detail});
  check('actual_movie_binding', media_sha256 === d.source_cut_sha256, 'Full local source movie SHA256 equals transcript binding.');
  check('preparation_binding', preparation.source_cut_sha256 === d.source_cut_sha256 && close(preparation.duration_sec,d.duration_sec), 'Preparation ledger names this cut and duration.');
  const prepared = prepareTranscript({...preparation,cues:d.cues,raw_cues:d.raw_cues,caption_cues:d.caption_cues});
  check('source_and_caption_preparation', !prepared.findings.length, prepared.findings);
  // A stale correction ledger must never silently substitute its old text.
  check('ledger_reproduces_current_text', equal(prepared.cues.map(c=>[c.id,c.text,c.speaker,c.speaker_parts||null]),d.cues.map(c=>[c.id,c.text,c.speaker,c.speaker_parts||null])), 'Replay source-bound corrections and compare every current cue.');
  const raw = [...d.raw_cues,...(d.non_speech_markers||[])].sort((a,b)=>a.source_cue-b.source_cue);
  check('original_recognition_retained', raw.length === source_asr.transcription.length && raw.every((c,i) => {
    const s = source_asr.transcription[i];
    return c.source_cue === i && c.text === s.text.trim() && c.asr_text === c.text && close(c.start,s.offsets.from/1000) && close(c.end,s.offsets.to/1000);
  }), 'Every original finished-mix recognition row, including non-speech markers, is retained verbatim with original times. This cannot detect speech missed by every recognizer.');
  check('source_order', d.cues.every((c,i)=>!i || c.start >= d.cues[i-1].start), 'Speech remains in source order.');
  const byId = new Map(d.cues.map(c=>[c.id,c]));
  check('speaker_parts', d.cues.every(c=>c.speaker && !/unresolved|unattributed/i.test(c.speaker) && (!c.speaker_parts || (
    equal(words(c.text),c.speaker_parts.flatMap(p=>words(p.text))) && c.speaker_parts.every(p=>c.text.slice(p.text_start,p.text_end) === p.text) &&
    c.speaker === c.speaker_parts.map(p=>p.speaker).join(' / ')
  ))), 'Mixed-turn phrase text, character ranges and labels agree. Provisional labels are not thereby acoustically verified.');
  const expected = new Map(), phraseChecks = [], seenDecisions = new Set();
  for (const r of [...owner_decisions].sort((a,b)=>a.recorded_at_utc.localeCompare(b.recorded_at_utc))) {
    seenDecisions.add(r._filename);
    const scope = r.source_cue_ids;
    const afterIds = r.after && typeof r.after === 'object' ? (Array.isArray(r.after)?r.after:[r.after]).map(c=>c.id) : null;
    const validScope = Array.isArray(scope) && scope.length > 0 && new Set(scope).size===scope.length && scope.every(id=>byId.has(id));
    const validOutcome = afterIds ? equal(afterIds,scope) && (Array.isArray(r.after)?r.after:[r.after]).every(c=>typeof c.text==='string' && !!c.text.trim()) : typeof r.after === 'string' ? scope?.length===1 && !!r.after.trim() : typeof r.wording === 'string' && !!r.wording.trim();
    check(`decision_binding:${r.id || r.ids?.join('+')}`, r.source_cut_sha256 === d.source_cut_sha256 && !!r.exact_reply && validScope && validOutcome, 'Exact scoped owner response retained with valid cue IDs and a testable outcome.');
    if (!validScope || !validOutcome) continue;
    if (r.after && typeof r.after === 'object') for (const c of Array.isArray(r.after)?r.after:[r.after]) expected.set(c.id,c);
    else if (typeof r.after === 'string' && r.source_cue_ids.length === 1) expected.set(r.source_cue_ids[0],{id:r.source_cue_ids[0],text:r.after});
    else if (r.wording && validScope) phraseChecks.push({r,ids:scope});
  }
  check('all_owner_decisions_loaded', [...(d.owner_wording_decisions||[]),...(d.owner_speaker_decisions||[])].every(f=>seenDecisions.has(f)), 'Includes historical partial responses and their later resolutions in chronological order.');
  check('approved_wording_and_speakers_preserved', [...expected].every(([id,c]) => {
    const now = byId.get(id); return now && ['text','speaker','start','end','speaker_parts'].every(k=>c[k]===undefined || equal(now[k],c[k]));
  }) && phraseChecks.every(({r,ids})=>words(ids.map(id=>byId.get(id)?.text).join(' ')).join(' ').includes(words(r.wording).join(' '))), 'Latest scoped decision wins; grammar and colloquial wording are preserved.');
  check('no_open_uncertainty_markers', !d.cues.some(c=>/\[[^\]]*\?[^\]]*\]|\b(?:inaudible|unintelligible|TODO)\b/i.test(c.text) || c.wording_uncertainties?.some(u=>u.status?.startsWith('unresolved'))), 'Checks explicit unresolved markers only.');
  const ids = d.caption_cues.flatMap(c=>c.source_cue_ids || [c.id]);
  check('caption_constituents_exactly_once', ids.length === d.cues.length && new Set(ids).size === ids.length && equal(ids,d.cues.map(c=>c.id)), 'No skipped, repeated or reordered source constituent in caption pages.');
  let parsed;
  try {
    parsed = parseCaptions(srt,'srt'); const other = parseCaptions(vtt,'vtt');
    check('srt_vtt_agree',equal(parsed,other),'All exported page text and timestamps match.');
    check('captions_match_draft',parsed.length === d.caption_cues.length && parsed.every((c,i)=>c.text===d.caption_cues[i].text && close(c.start,d.caption_cues[i].start) && close(c.end,d.caption_cues[i].end)), 'Exported text, line breaks and millisecond times equal current JSON.');
  } catch(e) {check('caption_export_parse',false,e.message);}
  const mdLines=transcript.replaceAll('\r','').split('\n'), firstRow=mdLines.findIndex(l=>/^\[\d/.test(l));
  const mdRows = mdLines.filter(l=>/^\[\d/.test(l));
  check('transcript_body_has_no_unchecked_lines', firstRow>=0 && mdLines.slice(firstRow).every(l=>!l.trim() || /^\[\d/.test(l)), 'After the first speech paragraph, every nonblank line must be a checked timecoded paragraph. Header metadata is outside spoken-text scope.');
  const mdWords = [], mdIds = [];
  let mdValid = mdRows.length > 0;
  for (const line of mdRows) {
    const match = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})[–-](\d{2}:\d{2}:\d{2}\.\d{3})\]\s+(.*)$/.exec(line);
    if (!match) {mdValid=false;continue;}
    const start=seconds(match[1]),end=seconds(match[2]),body=match[3];
    const selected=d.cues.filter(c=>c.start >= start-.001 && c.end <= end+.001);
    const parts=[...body.matchAll(/\*\*([^*]+):\*\*\s*([\s\S]*?)(?=\s*\*\*[^*]+:\*\*|$)/g)];
    const rowWords=parts.flatMap(p=>words(p[2]).map(w=>[p[1],w]));
    mdWords.push(...rowWords);mdIds.push(...selected.map(c=>c.id));
    mdValid &&= selected.length > 0 && close(start,selected[0].start) && close(end,selected.at(-1).end) && equal(rowWords,selected.flatMap(speakerWords));
  }
  check('readable_transcript_words_speakers_times',mdValid && equal(mdWords,d.cues.flatMap(speakerWords)) && equal(mdIds,d.cues.map(c=>c.id)), 'Every exported spoken token, speaker label and paragraph time span matches current cues.');
  const approvedPages = new Map();
  if (caption_approval) {
    check('caption_approval_binding',caption_approval.source_cut_sha256===d.source_cut_sha256 && !!caption_approval.exact_reply,'Scoped sample receipt names current movie.');
    for (const w of caption_approval.approved_windows || []) for (const p of w.displayed_captions) approvedPages.set(p.caption_id,p);
    check('accepted_caption_windows_unchanged',[...approvedPages.values()].every(p=> {
      const c=d.caption_cues.find(c=>c.id===p.caption_id); return c && p.text===c.text && close(p.caption_start,c.start) && close(p.caption_end,c.end) && equal(p.source_cue_ids,c.source_cue_ids);
    }), 'Exact page text, constituents and time bounds match approved samples.');
  }
  for (const c of d.caption_cues) {
    const lines=c.text.split('\n'),cps=flat(c.text).length/(c.end-c.start);
    const signals=[];
    if (lines.length>2) signals.push('more_than_two_lines');
    if (Math.max(...lines.map(l=>l.length))>42) signals.push('line_over_42_characters');
    if (cps>30) signals.push('over_30_characters_per_second');
    if(c.end-c.start<.6) signals.push('under_600ms');
    if (!signals.length) continue;
    const finding={id:`caption:${c.id}`,category:'caption_screen',cue_ids:c.source_cue_ids,start:c.start,end:c.end,signals,cps,observation:c.text};
    const a=approvedPages.get(c.id);
    if(a && a.text===c.text && close(a.caption_start,c.start) && close(a.caption_end,c.end) && a.displayed_start <= c.start+.001 && a.displayed_end >= c.end-.001) accepted.push({...finding,disposition:'owner_approved_exact_sample',receipt:caption_approval.id});
    else findings.push(finding);
  }
  const covered=new Set(),reviewIds=new Set();
  for (const r of reviews) {
    const valid=r.source_cut_sha256===d.source_cut_sha256 && r.draft_sha256===draft_sha256 && !!r.reviewer_id && !!r.model && !!r.method && !reviewIds.has(r.reviewer_id) && Array.isArray(r.findings) && Array.isArray(r.reviewed_cue_ids) && new Set(r.reviewed_cue_ids).size===r.reviewed_cue_ids.length && r.reviewed_cue_ids.every(id=>byId.has(id));
    check(`review_binding:${r.reviewer_id}`,valid, 'Source-bound reviewer, explicit cue coverage; coverage is self-reported text reading, not audio verification.');
    reviewIds.add(r.reviewer_id);
    if(valid) {
      r.reviewed_cue_ids.forEach(id=>covered.add(id));
      for(const f of r.findings) {
        check(`review_finding_identity:${r.reviewer_id}:${f.id}`,!!f.cue_ids?.length && f.cue_ids.every(id=>r.reviewed_cue_ids.includes(id) && f.start <= byId.get(id).start+.001 && f.end >= byId.get(id).end-.001) && Number.isFinite(f.start) && Number.isFinite(f.end) && f.start>=0 && f.end<=d.duration_sec && !!f.evidence, 'Finding cites assigned cues, enclosing finished timestamps and concrete evidence.');
        findings.push({...f,id:`${r.reviewer_id}:${f.id}`});
      }
    }
  }
  check('full_text_independent_review_coverage',covered.size===d.cues.length,'All current speech cues covered by separate reviewer receipt(s). Missing or stale review is not a pass.');
  const triageIds=new Set();
  for (const t of triage) {
    const f=findings.find(f=>f.id===t.finding_id);
    const valid=f && !triageIds.has(t.finding_id) && t.finding_sha256===digest(f) && t.source_cut_sha256===d.source_cut_sha256 && !!t.evidence && !!t.rationale && ['retain_source_wording','already_owner_resolved','operator_verified'].includes(t.disposition);
    check(`triage_binding:${t.finding_id}`,!!valid,'Operator disposition binds exact finding and source; unsupported/stale dismissal fails.');
    triageIds.add(t.finding_id);
    if(valid) {accepted.push({...f,disposition:t.disposition,evidence:t.evidence,rationale:t.rationale});findings.splice(findings.indexOf(f),1);}
  }
  return {schema:'eaol-final-transcript-audit-v1',source_cut_sha256:d.source_cut_sha256,draft_sha256,
    status:checks.some(c=>c.status==='FAIL')?'FAIL':findings.length?'NEEDS_OPERATOR_REVIEW':'PASS_WITH_LIMITS',
    counts:{speech_cues:d.cues.length,lexical_tokens:d.cues.flatMap(c=>words(c.text)).length,caption_pages:d.caption_cues.length,original_recognition_rows:raw.length,reviewed_cues:covered.size,reviewers:reviews.length,protected_decision_files:owner_decisions.length,checks:checks.length,failed_checks:checks.filter(c=>c.status==='FAIL').length,open_findings:findings.length,disposed_findings:accepted.length},
    speech_extent_sec:[d.cues[0].start,d.cues.at(-1).end],duration_sec:d.duration_sec,
    speaker_status_counts:d.cues.reduce((a,c)=>(a[c.speaker_status||'unspecified']=(a[c.speaker_status||'unspecified']||0)+1,a),{}),
    checks,findings,dispositions:accepted,human_approved:false,release_ready:false,
    limits:['Original ASR coverage cannot prove that recognition captured every audible word.','Independent model reads are text reviews, not a full listen or independent audio recognition.','Provisional speaker proposals remain unverified outside explicit source/owner checks.','Reading-speed and line-length thresholds are operator screening rules, not perceptual verdicts.','Sample caption approval does not establish full-episode word-onset alignment or final platform placement.','This audit does not approve final text, the final master, delivery or publication. Re-run after source/text/caption edits.']};
}

async function hashFile(path) { const h=createHash('sha256');for await(const chunk of createReadStream(path)) h.update(chunk);return h.digest('hex'); }
export async function runAudit(configPath, outDir) {
  const config=JSON.parse(readFileSync(configPath,'utf8')),base=dirname(resolve(configPath)),manifest=[];
  const read=(path,json=true)=>{const absolute=resolve(base,path),bytes=readFileSync(absolute);manifest.push({path:absolute,sha256:digest(bytes),bytes:bytes.length});return json?JSON.parse(bytes):bytes.toString('utf8');};
  const draft=read(config.draft),draft_sha256=manifest.at(-1).sha256;
  const owner_decisions=(config.owner_decisions||[]).map(p=>({...read(p),_filename:p.split('/').at(-1)}));
  const mediaPath=resolve(base,config.media),media_sha256=await hashFile(mediaPath);
  const report=auditFinalTranscript({draft,draft_sha256,media_sha256,owner_decisions,preparation:read(config.preparation),source_asr:read(config.source_asr),transcript:read(config.transcript,false),srt:read(config.srt,false),vtt:read(config.vtt,false),caption_approval:config.caption_approval?read(config.caption_approval):null,reviews:(config.reviews||[]).map(p=>read(p)),triage:config.triage?read(config.triage):[]});
  report.generated_at_utc=new Date().toISOString();
  report.implementation=[fileURLToPath(import.meta.url),fileURLToPath(new URL('./transcript_prepare.mjs',import.meta.url)),fileURLToPath(new URL('./transcript_preflight.mjs',import.meta.url))].map(path=>({path,sha256:digest(readFileSync(path))}));
  for(const f of config.evidence_files||[]) read(f,false);
  // Evidence files are hashed, not interpreted as instructions or approval.
  report.inputs=[{path:resolve(configPath),sha256:digest(readFileSync(configPath))},{path:mediaPath,sha256:media_sha256},...manifest];
  const out=resolve(outDir);if(existsSync(out))throw new Error('Use a new output directory to preserve prior audit receipts');mkdirSync(out,{recursive:true});
  writeFileSync(resolve(out,'audit.json'),JSON.stringify(report,null,2)+'\n');
  const lines=['# Final transcript audit', '', `Status: **${report.status}**. Full human transcript approval remains separate.`, '', `Checked ${report.counts.speech_cues} speech cues, ${report.counts.caption_pages} caption pages and ${report.counts.reviewed_cues} reviewer-covered cues.`, '', `Failed checks: ${report.counts.failed_checks}. Open findings: ${report.counts.open_findings}. Scoped dispositions: ${report.counts.disposed_findings}.`, '', '## Checks', '', ...report.checks.map(c=>`- ${c.status}: ${c.id}${c.status==='FAIL'?` — ${JSON.stringify(c.detail)}`:''}`),'','## Findings','',...(report.findings.length?report.findings.map(f=>`- ${f.id} (${stamp(f.start)}–${stamp(f.end)}): ${f.observation}`):['No unresolved findings within the checks performed.']),'','## Limits','',...report.limits.map(l=>`- ${l}`),'','The JSON receipt contains source hashes, detailed coverage and dispositions.'];
  writeFileSync(resolve(out,'AUDIT.md'),lines.join('\n')+'\n');return report;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.length!==4)throw new Error('Usage: node studio/transcript_final_audit.mjs config.json NEW_OUTPUT_DIRECTORY');
  const report=await runAudit(process.argv[2],process.argv[3]);console.log(JSON.stringify({status:report.status,...report.counts}));if(report.status!=='PASS_WITH_LIMITS')process.exitCode=2;
}
