// Generated color/tone fixtures test media mechanics, never editorial acceptance.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {resolveTool} from '../platform_tools.mjs';
import {fingerprint,signature} from './recovery.mjs';
import {shaFile} from './social_portable.mjs';
import {loadSocialWorkspace,saveSocialWorkspace,socialJobArgs} from './social_workspace.mjs';
import {loadFinishes,runFinishWorker,finishArtifactPath} from './social_finish_workspace.mjs';
import {renderFinishedClip} from './social_finishing.mjs';
const dir=mkdtempSync(join(tmpdir(),'studio finishing test ')),id='11111111-1111-1111-1111-111111111111';
const root=resolve('.');const run=(bin,args)=>{const r=spawnSync(bin,args,{encoding:'utf8',maxBuffer:10*1024*1024});assert.equal(r.status,0,r.stderr+'\n'+r.stdout);return r;};
try {
 const sourcePath=join(dir,'source.mp4');
 run(resolveTool('ffmpeg'),['-v','error','-f','lavfi','-i','testsrc2=size=960x540:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','16','-c:v','libx264','-preset','ultrafast','-crf','30','-c:a','aac','-ac','2',sourcePath]);
 const source={path:sourcePath,signature:signature(sourcePath),sha256:shaFile(sourcePath),duration_ms:16000,key:'synthetic-source'};
 const body={schema:'eaol-portable-social-source-v1',source:{sha256:source.sha256,bytes:source.signature.bytes,width:960,height:540},timeline_shift_ms:0,program:{start_ms:0,end_ms:16000},shots:[{start_ms:0,end_ms:16000}],graphics:[],framing_presets:{host_1:{mode:'crop',x:0,y:0,width:270,height:480}},cues:[{segment_id:'a',start_ms:0,end_ms:7500,speaker_id:'host_1',text:'Synthetic fixture only.'},{segment_id:'b',start_ms:7500,end_ms:15000,speaker_id:'host_1',text:'No human speech or approval.'}]};
 let state=loadSocialWorkspace(dir,source);state=saveSocialWorkspace(dir,source,{revision:state.revision,pack:{...body,fingerprint:fingerprint(body)}});state=saveSocialWorkspace(dir,source,{revision:state.revision,title:'Synthetic finishing proof',start_ms:0,end_ms:15000,layout:'host_1'});
 const draftId=state.drafts[0].id;run(process.execPath,socialJobArgs(root,dir,state,{revision:state.revision,id:draftId,confirmLocalRender:true}));state=loadSocialWorkspace(dir,source);
 const draftDir=join(dir,'social_workspace',draftId),parentHash=shaFile(join(draftDir,'clip.mp4'));
 const ep2={schema:'eaol-social-finishing-v1',episode_number:2,mode:'text_overlay',duration_ms:4000};
 runFinishWorker(dir,draftId,source,state.revision,ep2,2,id);
 let finishes=loadFinishes(dir,state.drafts[0]);assert.equal(finishes[0].current,true);assert.equal(finishes[0].duration_ms,15000);
 const out2=join(draftDir,'finishes',id);assert.equal(finishArtifactPath(dir,state,draftId,id,'master'),join(out2,'clip.mp4'));
 assert.throws(()=>renderFinishedClip(draftDir,ep2,out2),/exists/);
 const ending=join(dir,'ending.mp4');run(resolveTool('ffmpeg'),['-v','error','-f','lavfi','-i','testsrc2=size=540x960:rate=30','-f','lavfi','-i','sine=frequency=660:sample_rate=48000','-t','4','-c:v','libx264','-preset','ultrafast','-crf','30','-c:a','aac','-ac','2',ending]);
 const ep3={schema:'eaol-social-finishing-v1',episode_number:3,mode:'spoken_line',spoken_text:'The full conversation is in Episode 3.',ending:{path:ending,bytes:statSync(ending).size,sha256:shaFile(ending),start_ms:0,end_ms:4000,crop:{x:0,y:0,width:540,height:960}}};
 const second='22222222-2222-2222-2222-222222222222';runFinishWorker(dir,draftId,source,state.revision,ep3,3,second);
 finishes=loadFinishes(dir,state.drafts[0]);assert.equal(finishes.length,2);assert.ok(finishes.every(f=>f.current));assert.equal(finishes.find(f=>f.id===second).duration_ms,19000);
 const out3=join(draftDir,'finishes',second),r=JSON.parse(readFileSync(join(out3,'receipt.json'),'utf8'));
 assert.equal(r.human_complete_watch,false);assert.equal(r.publication_authorized,false);assert.match(readFileSync(join(out3,'REVIEW.md'),'utf8'),/Framing\/camera changes/);
 assert.equal(shaFile(join(draftDir,'clip.mp4')),parentHash);assert.equal(shaFile(sourcePath),source.sha256);
 for(const [name,folder,t] of [['ep2',out2,'13'],['ep3',out3,'17']])run(resolveTool('ffmpeg'),['-v','error','-i',join(folder,'clip.mp4'),'-ss',t,'-frames:v','1',join(dir,name+'-ending.png')]);
 const manifest={fixture:dir,source,draftId,ep2:out2,ep3:out3,notes:'Generated tones and test patterns only. Does not verify spoken content or editorial quality.'};writeFileSync(join(dir,'SYNTHETIC.json'),JSON.stringify(manifest,null,2));
 if(!process.env.EAOL_KEEP_FINISH_FIXTURE){writeFileSync(ending,'changed');assert.equal(loadFinishes(dir,state.drafts[0]).find(f=>f.id===second).current,false);assert.throws(()=>finishArtifactPath(dir,state,draftId,second,'preview'),/No current/);}
 console.log('PASS both finishing modes: full decode, expected dimensions and duration, immutable parent, output versioning and pending human review');console.log(JSON.stringify(manifest));
} finally {if(!process.env.EAOL_KEEP_FINISH_FIXTURE)rmSync(dir,{recursive:true,force:true});}
