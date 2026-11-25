import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { resolveTool } from '../platform_tools.mjs';
import { importRecovery, writeRecoveryJson, sha256 } from './recovery.mjs';
import { saveNumberedOpening, renderNumberedOpening } from './numbered_opening.mjs';
import { loadOpeningTransition, transitionInputs, validateTransitionSettings, renderOpeningTransition } from './opening_transition.mjs';
import { createStudioServer } from './server.mjs';
const work=mkdtempSync(join(tmpdir(),'eaol-opening-transition-')),assets=join(work,'assets');mkdirSync(assets);
let server;
function ff(args){const r=spawnSync(resolveTool('ffmpeg'),['-v','error','-nostdin',...args],{maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr.toString());return r.stdout;}
try {
 const source=join(assets,'clean.mp4'),program=join(assets,'program.mp4');
 for(const [file,color,vol,duration] of [[source,'blue',1,14],[program,'green',.3,12]])ff(['-f','lavfi','-i',`color=c=${color}:s=1280x720:r=30:d=${duration}`,'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${duration}`,'-af',`volume=${vol}${file===source ? ',asetpts=PTS+gte(T\\,5)*0.08/TB' : ''}`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',file]);
 const hash=await sha256(program),evidencePath=join(assets,'acceptance.json');writeRecoveryJson(evidencePath,{approved:true,sha256:hash});
 const review={id:'review',path:program,sha256:hash};
 const pack={schema:'eaol-recovery-v1',slug:'demo',title:'Transition fixture',fps:30,frames:360,hosts:{host_1:'A',host_2:'B'},sources:['host_1','host_2'].map(host=>({id:host,role:`${host}_camera`,part:1,path:program,sha256:hash})),blocks:[{startFrame:0,endFrame:360,cameras:{host_1:{sourceId:'host_1',startSec:0},host_2:{sourceId:'host_2',startSec:0}}}],shots:[{startFrame:0,endFrame:360,view:'two'}],review,evidence:[review,{id:'acceptance',path:evidencePath,sha256:await sha256(evidencePath)}],approvals:[{evidenceId:'acceptance',targetId:'review',targetSha256:hash,scope:'fixture continuity',reviewer:'Test',kind:'accepted',checks:[{path:['approved'],equals:true}]}],finalMasterApproved:false,finalVisualTreatmentApproved:false};
 const file=join(assets,'package.json');writeRecoveryJson(file,pack);await importRecovery(work,file);const dir=join(work,'demo');
 const baseline=readFileSync(join(dir,'recovery.json'),'utf8');assert.equal(loadOpeningTransition(dir).ready,false);
 const saved=await saveNumberedOpening(dir,{sourcePath:source,episodeNumber:2,cleanBaseConfirmed:true,startSec:1,endSec:12},[work]);
 const numbered=await renderNumberedOpening(dir,saved.recipe.fingerprint);assert.equal(loadOpeningTransition(dir).ready,false,'Exact opening acceptance required');
 writeRecoveryJson(join(dir,'numbered_opening_acceptance.json'),{approved:true,output:{sha256:'0'.repeat(64)},recipeFingerprint:saved.recipe.fingerprint});assert.equal(loadOpeningTransition(dir).ready,false);
 writeRecoveryJson(join(dir,'numbered_opening_acceptance.json'),{approved:true,output:numbered.output,recipeFingerprint:saved.recipe.fingerprint});
 let state=loadOpeningTransition(dir);assert.equal(state.ready,true);
 assert.throws(()=>validateTransitionSettings({trimEndSec:9,fadeInSec:.45},14),/eight seconds/);assert.throws(()=>validateTransitionSettings({trimEndSec:2,fadeInSec:3},14),/0–2/);
 await assert.rejects(renderOpeningTransition(dir,{inputsKey:'stale',trimEndSec:2,fadeInSec:.45}),/inputs changed/);
 const receipt=await renderOpeningTransition(dir,{inputsKey:state.inputsKey,trimEndSec:2,fadeInSec:.45});
 assert.equal(receipt.checks.frames,600);assert.equal(receipt.checks.programAudioSamplesUnchanged,true);assert.equal(receipt.humanApproved,false);assert.equal(receipt.audioBalance.checks.opening_matches_program,true);assert.equal(receipt.audioBalance.encoding_headroom_db,.5);assert(receipt.audioBalance.opening_output.true_peak_dbtp<=-1);assert.equal(readFileSync(join(dir,'recovery.json'),'utf8'),baseline);assert.equal(await sha256(program),hash);
 const pixel=t=>ff(['-ss',String(t),'-i',receipt.output.path,'-vf','crop=2:2:640:360','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-']);
 assert(pixel(7)[2]>150,'Opening picture before boundary');assert(Math.max(...pixel(8))<15,'Program picture starts with fade');assert(pixel(9)[1]>70,'Program visible after fade');
 server=createStudioServer({root:resolve('.'),workRoot:work});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/api/episodes/demo/recovery/opening-transition`;
 assert.equal((await fetch(url)).status,200);const media=await fetch(`${url}/media`,{headers:{Range:'bytes=0-31'}});assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,32);
 const oldKey=state.inputsKey;writeRecoveryJson(join(dir,'recovery_draft.json'),{shots:pack.shots,notes:'new draft',revision:1});assert.notEqual(transitionInputs(dir).key,oldKey);assert.equal(loadOpeningTransition(dir).receipt.stale,true);assert.equal((await fetch(`${url}/media`)).status,409);
 appendFileSync(numbered.output.path,'changed');assert.equal(loadOpeningTransition(dir).ready,false);
 console.log('PASS: exact opening acceptance, changed inputs, 20-second picture transition, unchanged program PCM/timing, loudness match, preserved inputs, API media and stale refusal');
} finally {if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}rmSync(work,{recursive:true,force:true});}
