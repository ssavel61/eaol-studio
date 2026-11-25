import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFinalMasterPlan, bindFinalDelivery, finalFramingFilter, mergeCaptionPhrases } from './social_final_master.mjs';

function fixture() {
  const output = { path:'/synthetic/master.mp4', bytes:123, modified_ms:456, width:3840, height:2160 };
  return {
    render:{ status:'complete', quality:'full', full_render_authorized:true, checks:{decode:true}, assembly_fingerprint:'recipe', output,
      segments:[{type:'opening',duration_sec:5}], program_graphics:{timeline:[]}, cta:{timeline:[]} },
    assembly:{plan_fingerprint:'recipe',program:{start_ms:20000,duration_ms:60000,shots:[{start_ms:20000,end_ms:80000}]}},
    approval:{status:'approved',local_social_test_authorized:true,assembly_fingerprint:'recipe',output:{...output,sha256:'exact'}},
    sourceSha:'exact',selection:{start_ms:10000,end_ms:30000,caption_segment_ids:['one','two'],framing:{mode:'crop',x:420,y:240,width:1080,height:1920}},
    cues:[{segment_id:'one',start_ms:10000,end_ms:20000,text:'One complete thought.'},{segment_id:'two',start_ms:20000,end_ms:30000,text:'And its conclusion.'}],
  };
}
test('valid master plan stays an unapproved draft and retains every caption word',()=>{
  const p=buildFinalMasterPlan(fixture());
  assert.equal(p.editorial_approval,'pending'); assert.equal(p.publication_authorized,false);
  assert.equal(p.layout.pages.flatMap(p=>p.lines).join(' '),'One complete thought. And its conclusion.');
});
for (const [name, change, message] of [
  ['changed source hash',f=>f.sourceSha='changed',/approval/],
  ['missing human approval',f=>f.approval.status='pending',/approval/],
  ['different approved file',f=>f.approval.output.path='/different.mp4',/mismatch/],
  ['changed recipe',f=>f.assembly.plan_fingerprint='new',/assembly/],
  ['invalid crop',f=>f.selection.framing.x=3000,/crop/],
  ['fractional crop',f=>f.selection.framing.y=1.5,/crop/],
  ['burned graphics',f=>f.render.program_graphics.timeline.push({start_sec:12,end_sec:15}),/graphic/],
  ['burned CTA',f=>f.render.cta.timeline.push({start_sec:12,end_sec:15}),/graphic/],
  ['camera switch',f=>f.assembly.program.shots=[{start_ms:20000,end_ms:35000},{start_ms:35000,end_ms:80000}],/camera/],
  ['cue cut',f=>f.selection.start_ms=10001,/boundary/],
  ['overlap',f=>f.cues[1].start_ms=19999,/overlap/],
  ['missing cue',f=>f.selection.caption_segment_ids=['one'],/ids/],
  ['subtitle command',f=>f.cues[0].text='{bad}',/control/],
]) test(`refuses ${name}`,()=>{ const f=fixture();change(f);assert.throws(()=>buildFinalMasterPlan(f),message); });

function deliveryFixture() {
  const file={path:'/synthetic/delivery.mp4',bytes:222,sha256:'delivery',duration_sec:65};
  return {lock:{status:'finalized_local',sha256_recomputed_match:true,file},sourceSha:'delivery',modifiedMs:789,
    review:{status:'approved',source_picture_approval_preserved:true,source_sha256:'exact',output:{...file},
      human_checks:{new_audio_level:'approved',sync_spot_check:'approved',closing_music:'approved'}},
    readiness:{status:'technically_verified',new_audio_listening_review:'approved_by_host_1',source_sha256:'exact',output:{...file},checks:{picture_payload_identical:true}},
    timing:{status:'pass',video_pts_constant_shift_sec:-0.0210286667,max_pts_shift_variation_sec:0.000001,
      audio_comparisons:Array.from({length:3},()=>({relative_av_change_ms:0.0287,correlation:0.997}))}};
}
test('finalized delivery keeps original provenance and relative caption timing while using approved audio',()=>{
  const original=buildFinalMasterPlan(fixture()), snapshot=JSON.stringify(original);
  const p=bindFinalDelivery(original,deliveryFixture());
  assert.equal(p.source.path,'/synthetic/delivery.mp4'); assert.equal(p.original_master.sha256,'exact');
  assert.equal(p.source.sha256,'delivery'); assert.equal(p.selection.start_ms,10000-21.0286667);
  assert.deepEqual(p.layout,original.layout); assert.equal(p.duration_ms,original.duration_ms);
  assert.equal(JSON.stringify(original),snapshot); assert.equal(p.editorial_approval,'pending');
  assert.equal(p.publication_authorized,false); assert.equal(p.upload_authorized,false);
});
for (const [name, change, message] of [
  ['changed delivery bytes',d=>d.sourceSha='changed',/lock/],
  ['unfinalized file',d=>d.lock.status='pending',/lock/],
  ['unapproved delivery sound',d=>d.review.human_checks.closing_music='pending',/listening/],
  ['different original picture',d=>d.review.source_sha256='other',/original/],
  ['different approved delivery',d=>d.review.output.path='/wrong.mp4',/output/],
  ['nonidentical picture',d=>d.readiness.checks.picture_payload_identical=false,/technical/],
  ['variable timeline shift',d=>d.timing.max_pts_shift_variation_sec=0.05,/timeline/],
  ['failed audio alignment',d=>d.timing.audio_comparisons[0].relative_av_change_ms=42,/timeline/],
  ['missing timing evidence',d=>d.timing.audio_comparisons=[],/timeline/],
]) test(`refuses ${name}`,()=>{const d=deliveryFixture();change(d);assert.throws(()=>bindFinalDelivery(buildFinalMasterPlan(fixture()),d),message);});

function conversationFixture() {
  const f=fixture(); f.cues[0].speaker_id='host_1';f.cues[1].speaker_id='host_2';
  f.selection.framing={mode:'speaker_cuts',shots:[
    {start_ms:10000,end_ms:20000,speaker_id:'host_1',x:420,y:240,width:1080,height:1920},
    {start_ms:20000,end_ms:30000,speaker_id:'host_2',x:2340,y:240,width:1080,height:1920}]};
  return f;
}
test('speaker framing changes at the source-bound handoff and survives delivery shift',()=>{
  const p=buildFinalMasterPlan(conversationFixture()),d=bindFinalDelivery(p,deliveryFixture());
  assert.equal(d.selection.framing.shots[1].start_ms,20000-21.0286667);
  assert.match(finalFramingFilter(d.selection.framing,d.selection.start_ms),/if\(lt\(t,10.000000\),420,2340\)/);
});
for(const [name,change,message] of [
  ['gap',f=>f.selection.framing.shots[1].start_ms+=1,/discontinuous/],
  ['wrong speaker',f=>f.selection.framing.shots[1].speaker_id='host_1',/speaker/],
  ['out of frame',f=>f.selection.framing.shots[1].x=3000,/crop/],
  ['truncated coverage',f=>f.selection.framing.shots[1].end_ms=29000,/cover/],
])test(`conversation rejects ${name}`,()=>{const f=conversationFixture();change(f);assert.throws(()=>buildFinalMasterPlan(f),message);});
test('stacked layout preserves both reviewed panels',()=>{
  const f=fixture();f.selection.framing={mode:'stacked',panels:[{speaker_id:'host_1',x:14,y:240,width:1890,height:1680},{speaker_id:'host_2',x:1934,y:240,width:1890,height:1680}]};
  const p=buildFinalMasterPlan(f);assert.match(finalFramingFilter(p.selection.framing,p.selection.start_ms),/vstack/);
  f.selection.framing.panels[1].width=1920;assert.throws(()=>buildFinalMasterPlan(f),/stacked/);
});
test('declared brief handoff adjusts display end only, retaining words and original timing',()=>{
  const f=conversationFixture();f.cues[0].end_ms=20369;
  f.selection.caption_display_adjustments=[{segment_id:'one',original_end_ms:20369,end_ms:20000}];
  const p=buildFinalMasterPlan(f);assert.equal(p.captions[0].end_ms,20000);assert.equal(p.original_captions[0].end_ms,20369);
  assert.equal(p.layout.pages.flatMap(p=>p.lines).join(' '),'One complete thought. And its conclusion.');
  assert.equal(p.caption_display_edits.length,1);
});
for(const [name,change] of [
  ['same speaker',f=>f.cues[1].speaker_id='host_1'],
  ['long overlap',f=>{f.cues[0].end_ms=21000;f.selection.caption_display_adjustments[0].original_end_ms=21000;}],
  ['wrong prior bound',f=>f.selection.caption_display_adjustments[0].original_end_ms=20370],
  ['arbitrary timing',f=>f.selection.caption_display_adjustments[0].end_ms=19900],
])test(`caption handoff rejects ${name}`,()=>{const f=conversationFixture();f.cues[0].end_ms=20369;f.selection.caption_display_adjustments=[{segment_id:'one',original_end_ms:20369,end_ms:20000}];change(f);assert.throws(()=>buildFinalMasterPlan(f),/handoff/);});

test('explicit phrase grouping retains every word and both source cue identities',()=>{
  const cues=[{segment_id:'a',speaker_id:'host_1',start_ms:0,end_ms:2000,text:'solve'},{segment_id:'b',speaker_id:'host_1',start_ms:2000,end_ms:2300,text:'problems.'}];
  const merged=mergeCaptionPhrases(cues,[['a','b']]);assert.equal(merged[0].text,'solve problems.');assert.equal(merged[0].end_ms,2300);
  assert.deepEqual(merged[0].source_segment_ids,['a','b']);assert.equal(cues.length,2);
});
for(const [name,patch] of [['different speakers',c=>c[1].speaker_id='host_2'],['overlap',c=>c[1].start_ms=1999],['long gap',c=>c[1].start_ms=2300]])
  test(`phrase merge rejects ${name}`,()=>{const c=[{segment_id:'a',speaker_id:'host_1',start_ms:0,end_ms:2000,text:'first'},{segment_id:'b',speaker_id:'host_1',start_ms:2000,end_ms:2500,text:'second'}];patch(c);assert.throws(()=>mergeCaptionPhrases(c,[['a','b']]),/adjacent/);});
test('phrase merge rejects nonexistent or reordered cues',()=>{
  const c=[{segment_id:'a',speaker_id:'host_1',start_ms:0,end_ms:1000,text:'first'},{segment_id:'b',speaker_id:'host_1',start_ms:1000,end_ms:2000,text:'second'}];
  assert.throws(()=>mergeCaptionPhrases(c,[['b','a']]),/adjacent/);assert.throws(()=>mergeCaptionPhrases(c,[['a','missing']]),/adjacent/);
});
