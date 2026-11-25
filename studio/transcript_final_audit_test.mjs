import assert from 'node:assert/strict';
import { auditFinalTranscript, digest, parseCaptions } from './transcript_final_audit.mjs';
const sha='a'.repeat(64), draftHash='b'.repeat(64);
const cue={id:'mix:0',chunk:'mix',source_cue:0,start:1,end:3,text:'Keep both were ready.',asr_text:'Keep both were ready.',speaker:'Host 1',speaker_status:'owner_confirmed'};
const page={id:'cc:1',start:1,end:3,text:cue.text,speaker:'Host 1',source_cue_ids:[cue.id]};
const draft={source_cut_sha256:sha,duration_sec:4,cues:[cue],raw_cues:[{...cue,speaker:'unattributed'}],caption_cues:[page],owner_wording_decisions:['W01.json']};
const fixture=()=>structuredClone({draft,draft_sha256:draftHash,media_sha256:sha,preparation:draft,
  source_asr:{transcription:[{text:' Keep both were ready.',offsets:{from:1000,to:3000}}]},
  transcript:'# Draft\n\n---\n\n[00:00:01.000–00:00:03.000] **Host 1:** Keep both were ready.\n',
  srt:'1\n00:00:01,000 --> 00:00:03,000\nKeep both were ready.\n',vtt:'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nKeep both were ready.\n',
  owner_decisions:[{_filename:'W01.json',id:'W01',recorded_at_utc:'2026-01-01',source_cut_sha256:sha,exact_reply:'Keep both were ready.',source_cue_ids:[cue.id],after:cue.text}],
  reviews:[{reviewer_id:'independent_reader',model:'test',method:'text_read',source_cut_sha256:sha,draft_sha256:draftHash,reviewed_cue_ids:[cue.id],findings:[]}],triage:[]});
let tests=0;
function test(name,fn){fn();tests++;console.log(`PASS ${name}`);}
const failed=(x,id)=>auditFinalTranscript(x).checks.some(c=>c.id===id&&c.status==='FAIL');
test('clean source-bound audit never confers human approval',()=>{
  const x=fixture(),before=structuredClone(x),r=auditFinalTranscript(x);
  assert.equal(r.status,'PASS_WITH_LIMITS');assert.equal(r.human_approved,false);assert.equal(r.release_ready,false);assert.deepEqual(x,before);
});
test('wrong actual movie hash fails',()=>{const x=fixture();x.media_sha256='c'.repeat(64);assert(failed(x,'actual_movie_binding'));});
test('original recognition omissions are detected',()=>{const x=fixture();x.source_asr.transcription.push({text:' missing words',offsets:{from:3100,to:3500}});assert(failed(x,'original_recognition_retained'));});
test('stale correction ledger cannot silently restore a changed draft',()=>{
  const x=fixture();x.preparation.decisions={source_cut_sha256:sha,items:[]};x.draft.cues[0].text='Keep both are ready.';
  assert(failed(x,'source_and_caption_preparation'));assert(failed(x,'approved_wording_and_speakers_preserved'));
});
test('caption omissions, duplication and truncation fail',()=>{
  for(const mutate of [x=>x.draft.caption_cues=[],x=>x.draft.caption_cues.push({...page,id:'cc:2'}),x=>x.draft.caption_cues[0].end=2]) {
    const x=fixture();mutate(x);assert.notEqual(auditFinalTranscript(x).status,'PASS_WITH_LIMITS');
  }
});
test('malformed timestamps and missing SRT numbers rejected',()=>{
  assert.throws(()=>parseCaptions('1\n00:00:61,000 --> 00:01:03,000\nwords','srt'));
  assert.throws(()=>parseCaptions('00:00:01,000 --> 00:00:03,000\nwords','srt'));
});
test('SRT/VTT punctuation and line break divergence fails',()=>{const x=fixture();x.vtt=x.vtt.replace('ready.','ready?');assert(failed(x,'srt_vtt_agree'));});
test('wrong readable transcript speaker or time fails',()=>{
  for(const [before,after] of [['**Host 1:**','**Host 2:**'],['00:00:03.000','00:00:02.900']]) {
    const x=fixture();x.transcript=x.transcript.replace(before,after);assert(failed(x,'readable_transcript_words_speakers_times'));
  }
});
test('unparsed spoken text cannot be smuggled into Markdown body',()=>{const x=fixture();x.transcript+='Host 2: invented words\n';assert(failed(x,'transcript_body_has_no_unchecked_lines'));});
test('owner decision without valid cue scope/outcome fails',()=>{
  for(const field of ['source_cue_ids','after']) {const x=fixture();delete x.owner_decisions[0][field];assert(failed(x,'decision_binding:W01'));}
});
test('missing owner receipt fails even with unchanged text',()=>{const x=fixture();x.owner_decisions=[];assert(failed(x,'all_owner_decisions_loaded'));});
test('stale or incomplete reviewer coverage fails',()=>{
  for(const mutate of [r=>r.draft_sha256='c'.repeat(64),r=>r.reviewed_cue_ids=[],r=>r.reviewed_cue_ids.push('not-a-cue')]) {
    const x=fixture();mutate(x.reviews[0]);assert(failed(x,'full_text_independent_review_coverage'));
  }
});
test('model hypotheses require evidence-bound operator disposition',()=>{
  const x=fixture();x.reviews[0].findings=[{id:'F01',cue_ids:[cue.id],start:1,end:3,observation:'Hypothesis',evidence:'source excerpt'}];
  let r=auditFinalTranscript(x);assert.equal(r.status,'NEEDS_OPERATOR_REVIEW');
  x.triage=[{finding_id:r.findings[0].id,finding_sha256:digest(r.findings[0]),source_cut_sha256:sha,disposition:'retain_source_wording',evidence:'Scoped source corroboration',rationale:'No evidence for rewriting spoken grammar.'}];
  assert.equal(auditFinalTranscript(x).status,'PASS_WITH_LIMITS');
  x.triage[0].finding_sha256='c'.repeat(64);assert.notEqual(auditFinalTranscript(x).status,'PASS_WITH_LIMITS');
});
test('caption sample exception expires when its page times change',()=>{
  const x=fixture();x.caption_approval={id:'R01',source_cut_sha256:sha,exact_reply:'Keep timing.',approved_windows:[{displayed_captions:[{caption_id:page.id,caption_start:1,caption_end:3,text:page.text,source_cue_ids:[cue.id]}]}]};
  assert.equal(auditFinalTranscript(x).status,'PASS_WITH_LIMITS');x.draft.caption_cues[0].end=3.5;assert(failed(x,'accepted_caption_windows_unchanged'));
});
test('mixed speaker text ranges cannot disagree with source text',()=>{const x=fixture();x.draft.cues[0].speaker_parts=[{speaker:'Host 1',text:'Keep both were ready.',text_start:1,text_end:21}];assert(failed(x,'speaker_parts'));});
test('partial sample playback cannot waive a whole caption page signal',()=>{
  const x=fixture();x.draft.caption_cues[0].text='Keep both were ready.\n\n'; // Intentional three-line layout signal.
  x.srt=x.srt.replace('Keep both were ready.','Keep both were ready.\n\n');x.vtt=x.vtt.replace('Keep both were ready.','Keep both were ready.\n\n');
  x.caption_approval={id:'R01',source_cut_sha256:sha,exact_reply:'Keep sample.',approved_windows:[{displayed_captions:[{caption_id:page.id,caption_start:1,caption_end:3,displayed_start:2,displayed_end:3,text:x.draft.caption_cues[0].text,source_cue_ids:[cue.id]}]}]};
  assert(auditFinalTranscript(x).findings.some(f=>f.id==='caption:cc:1'));
});
test('empty outcome and wrong finding timestamp fail',()=>{
  const x=fixture();x.owner_decisions[0].after={id:cue.id};assert(failed(x,'decision_binding:W01'));
  const y=fixture();y.reviews[0].findings=[{id:'bad',cue_ids:[cue.id],start:3,end:4,evidence:'wrong window'}];assert(failed(y,'review_finding_identity:independent_reader:bad'));
});
console.log(`${tests} final transcript audit regression groups passed.`);
