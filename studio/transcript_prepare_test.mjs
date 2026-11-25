import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTranscript, transcriptSourceKey, auditCaptionCoverage, readRecognitionWindows } from './transcript_prepare.mjs';
const sha = 'a'.repeat(64);
const cue = (id, chunk, start, end, text) => ({ id, chunk, source_cue: id, start, end, text, asr_text: text, speaker: 'Host 1' });
const base = cues => ({ cues, raw_cues: cues, source_cut_sha256: sha, duration_sec: 3000, caption_cues: cues.map(c => ({ ...c, source_cue_ids: [c.id] })) });
const pairs = [
 [cue('a',1,100,101.96,'every new update'),cue('b',2,101.51,102.64,'new update arrives')],
 [cue('a',6,200,202.91,'I think'),cue('b',7,203.4,206.29,'I think the next step')],
 [cue('a',4,300,301,'just'),cue('b',4,301,303.44,'a small'),cue('c',5,302.8,305.86,'just a small detail')],
];
for (const rows of pairs) {
 const input=base(rows), frozen=structuredClone(input), report=prepareTranscript(input);
 assert.ok(report.findings.some(f => f.kind==='chunk_boundary_repetition'));
 assert.deepEqual(input,frozen); assert.equal(report.cues.length, rows.length);
 const target=rows.at(-1), replacement=target.text.replace(/^(new update |I think |just a small )/, '');
 const decisions={source_cut_sha256:sha,items:[{action:'replace',source_key:transcriptSourceKey(target),expected_text:target.text,after:{text:replacement},reason:'Recorded once',evidence:'Exact scoped host once decision; test fixture',authority:'Host 1'}]};
 const fixed=prepareTranscript({...input,caption_cues:[...rows.slice(0,-1),{...target,text:replacement}],decisions});
 assert.ok(!fixed.findings.some(f => f.kind==='chunk_boundary_repetition'));
 assert.equal(fixed.correction_ledger[0].original.text,target.text);
 assert.equal(fixed.human_approved,false);
 assert.throws(()=>prepareTranscript({...input,decisions:{...decisions,source_cut_sha256:'b'.repeat(64)}}),/Stale/);
}
const genuine=[cue('a',1,0,1,'I think'),cue('b',1,1,2,'I think it works')];
assert.equal(prepareTranscript(base(genuine)).findings.length,0);
assert.throws(()=>prepareTranscript(base([genuine[0],{...genuine[1],id:genuine[0].id}])),/Display cue IDs/);
assert.ok(prepareTranscript({...base([cue('bounds',1,1,3,'words')]),duration_sec:2}).findings.some(f=>f.kind==='source_outside_master_bounds'));
assert.equal(transcriptSourceKey({...genuine[0],id:'reindexed'}),transcriptSourceKey(genuine[0]));
assert.ok(prepareTranscript({...base(genuine),cues:[{...genuine[0],text:'invented words'},genuine[1]]}).findings.some(f=>f.kind==='unlogged_source_text_change'));
const missing=cue('zero',2,800,800,'sample files');
const quarantined=prepareTranscript(base([missing]));
assert.equal(quarantined.quarantine[0].text,'sample files');
assert.ok(quarantined.findings.some(f=>f.kind==='invalid_source_span'));
assert.ok(prepareTranscript({...base(genuine),raw_cues:[...genuine,missing]}).findings.some(f=>f.kind==='unresolved_missing_source'));
const restored=prepareTranscript({...base(genuine),raw_cues:[...genuine,missing],decisions:{source_cut_sha256:sha,items:[{action:'restore',source_key:transcriptSourceKey(missing),expected_text:missing.text,after:{start:800,end:801},reason:'Measured original sound',evidence:'Fixture original-mic timing',authority:'operator'}]}});
assert.equal(restored.cues.at(-1).text,'sample files');
const split=[cue('a',1,0,1,'we use cloud'),cue('b',1,1,2,'code today')];
const normalized=prepareTranscript({...base(split),name_rules:[{source_keys:split.map(transcriptSourceKey),before:'cloud code',after:'Claude Code',evidence:'Verified tool context'}]});
assert.deepEqual(normalized.cues.map(c=>c.text),['we use Claude','Code today']);
assert.equal(normalized.cues[0].start,0); assert.equal(normalized.cues[1].end,2);
assert.equal(prepareTranscript(base(split)).cues[0].text,'we use cloud','ordinary cloud/code is never globally rewritten');
assert.throws(()=>prepareTranscript({...base(split),name_rules:[{source_keys:split.map(transcriptSourceKey),before:'cloud code',after:'Opus 5.5',evidence:'guess'}]}),/Name rules/);
const sources=[cue('a',1,8,9,'the first line'),cue('b',1,9,11,'the bottom line')];
const clipped=[{id:'p',start:8,end:10,text:'the first line the bottom line',source_cue_ids:['a','b']}];
assert.ok(auditCaptionCoverage(sources,clipped,12).some(f=>f.kind==='caption_constituent_span_clipped'));
assert.equal(auditCaptionCoverage(sources,[{...clipped[0],end:11}],12).length,0);
assert.ok(auditCaptionCoverage(sources,[{...clipped[0],end:11,text:'the first line'}],12).some(f=>f.kind==='caption_words_differ'));
// Same text at a later real repetition cannot justify discarding earlier words.
const timed=(id,chunk,start)=>({...cue(id,chunk,start,start+1,'I think'),window_start_sec:0,tokens:[{id:1,text:' I',offsets:{from:start*1000,to:start*1000+400}},{id:2,text:' think',offsets:{from:start*1000+400,to:start*1000+1000}}]});
const original=timed('x',1,5),copy=timed('y',2,5.1),repeat=timed('z',2,7);
assert.equal(prepareTranscript({...base([copy]),raw_cues:[original,copy]}).raw_coverage[0].status,'overlap_alignment_supported');
assert.equal(prepareTranscript({...base([repeat]),raw_cues:[original,repeat]}).raw_coverage[0].status,'unresolved_missing_source');
const dir=mkdtempSync(join(tmpdir(),'eaol-raw-windows-'));
try {
 writeFileSync(join(dir,'raw.json'),JSON.stringify({transcription:[{text:'one small step at a',offsets:{from:1000,to:1000}},{text:' time',offsets:{from:1100,to:1400}}]}));
 const loaded=readRecognitionWindows({source_cut_sha256:sha,duration_sec:5,chunks:[{id:0,path:'raw.json',start_sec:0,owner_start_sec:0,owner_end_sec:5}]},dir);
 assert.equal(loaded.raw_cues.length,2);assert.equal(loaded.cues[0].text,'one small step at a');
 assert.equal(prepareTranscript(loaded).quarantine.length,1);
} finally {rmSync(dir,{recursive:true,force:true});}
console.log('PASS: seam repair ledger, genuine repeats, raw fragment quarantine/restoration, bounded split names, constituent speech coverage and stale decisions.');
