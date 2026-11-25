import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fingerprint,signature} from './recovery.mjs';
import {shaFile} from './social_portable.mjs';
import {validateFinishRecipe,buildFinishPlan,endingAss,runFinishCli} from './social_finishing.mjs';
import {finishJobArgs,finishArtifactPath,loadFinishes} from './social_finish_workspace.mjs';
const ep2={schema:'eaol-social-finishing-v1',episode_number:2,mode:'text_overlay',duration_ms:4000};
const ep3={schema:'eaol-social-finishing-v1',episode_number:3,mode:'spoken_line',spoken_text:'The full conversation is in Episode 3.',ending:{path:'/local/ending.mp4',sha256:'a'.repeat(64),bytes:10,start_ms:1000,end_ms:5000,crop:{x:0,y:0,width:540,height:960}}};
function fixture(dir) {
  writeFileSync(join(dir,'clip.mp4'),'synthetic checked bytes');
  const body={schema:'eaol-portable-social-draft-v1',source:{sha256:'b'.repeat(64)},selection:{title:'A useful idea'},duration_ms:15000};
  const plan={...body,fingerprint:fingerprint(body)};
  writeFileSync(join(dir,'plan.json'),JSON.stringify(plan));
  writeFileSync(join(dir,'receipt.json'),JSON.stringify({schema:'eaol-portable-social-render-v1',status:'technically_verified',plan_fingerprint:plan.fingerprint,source_sha256:body.source.sha256,outputs:{master:{file:'clip.mp4',bytes:23,sha256:shaFile(join(dir,'clip.mp4')),full_decode_passed:true}}}));
  return plan;
}
test('finishing validates the text-overlay and recorded-line modes',()=>{
  assert.equal(validateFinishRecipe(ep2,2).duration_ms,4000);assert.equal(validateFinishRecipe(ep3,3).duration_ms,4000);
  for(const bad of [{...ep2,episode_number:0},{...ep2,duration_ms:2000},{...ep3,spoken_text:'Like and subscribe'},{...ep3,ending:{...ep3.ending,sha256:'bad'}},{...ep3,ending:{...ep3.ending,crop:{x:0,y:0,width:1920,height:1080}}},{...ep2,publication_authorized:true}])assert.throws(()=>validateFinishRecipe(bad));
  assert.throws(()=>validateFinishRecipe(ep3,4),/differs/);
});
test('plans bind exact parent bytes, preserve duration for overlay and append only recorded range',()=>{
  const dir=mkdtempSync(join(tmpdir(),'eaol-finish-plan-'));
  try {
    fixture(dir);const p2=buildFinishPlan(dir,ep2,2),p3=buildFinishPlan(dir,ep3,3);
    assert.equal(p2.duration_ms,15000);assert.equal(p2.ending_start_ms,11000);assert.equal(p3.duration_ms,19000);assert.equal(p3.ending_start_ms,15000);
    assert.match(endingAss(p2),/0:00:11.00,0:00:15.00/);assert.match(endingAss(p3),/is in Episode 3/);
    assert.equal(p3.publication_authorized,false);assert.equal(p3.human_complete_watch,false);
    writeFileSync(join(dir,'ending.json'),JSON.stringify(ep2));assert.equal(runFinishCli(['plan','--draft',dir,'--recipe',join(dir,'ending.json')]).fingerprint,p2.fingerprint);
    writeFileSync(join(dir,'clip.mp4'),'changed');assert.throws(()=>buildFinishPlan(dir,ep2),/changed/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Studio finishing requires exact episode, current base render, revision and confined local ending',()=>{
  const dir=mkdtempSync(join(tmpdir(),'eaol-finish-guard-')),id='11111111-1111-1111-1111-111111111111';
  try {
    const state={source:{path:join(dir,'source.mp4')},stale:false,revision:'r1',drafts:[{id,render:{status:'technically_verified'},plan_fingerprint:'p1'}]};
    const body={id,revision:'r1',confirmLocalFinish:true,recipe:ep2};
    assert.equal(finishJobArgs('.',dir,state,body,2).length,8);
    assert.throws(()=>finishJobArgs('.',dir,state,{...body,confirmLocalFinish:false},2),/Confirm/);
    assert.throws(()=>finishJobArgs('.',dir,state,{...body,revision:'old'},2),/Confirm/);
    assert.throws(()=>finishJobArgs('.',dir,{...state,stale:true},body,2),/Confirm/);
    assert.throws(()=>finishJobArgs('.',dir,state,body,3),/differs/);
    assert.throws(()=>finishJobArgs('.',dir,state,{...body,recipe:ep3},3));
    assert.throws(()=>finishArtifactPath(dir,state,id,id,'preview'),/No current/);
    const parent=join(dir,'social_workspace',id);mkdirSync(parent,{recursive:true});symlinkSync(tmpdir(),join(parent,'finishes'));
    assert.throws(()=>loadFinishes(dir,state.drafts[0]),/inside|outside|escape|allowed|symlink/i);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
