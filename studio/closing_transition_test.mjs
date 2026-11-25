import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { resolveTool } from '../platform_tools.mjs';
import { importRecovery, writeRecoveryJson, sha256, probe } from './recovery.mjs';
import { loadClosingTransition, closingInputs, validateClosingSettings, renderClosingTransition } from './closing_transition.mjs';
import { createStudioServer } from './server.mjs';
const work=mkdtempSync(join(tmpdir(),'eaol-closing-transition-')),assets=join(work,'assets');mkdirSync(assets);let server;
function ff(args){const r=spawnSync(resolveTool('ffmpeg'),['-v','error','-nostdin',...args],{maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr.toString());return r.stdout;}
try {
 const source=join(assets,'close.mp4'),program=join(assets,'program.mp4');
 for(const [file,color,freq,duration] of [[source,'blue',701,14],[program,'green',330,20]])ff(['-f','lavfi','-i',`color=c=${color}:s=1280x720:r=30:d=${duration}`,'-f','lavfi','-i',`sine=frequency=${freq}:sample_rate=48000:duration=${duration}`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',file]);
 const hash=await sha256(program),evidencePath=join(assets,'acceptance.json');writeRecoveryJson(evidencePath,{approved:true,sha256:hash});
 const review={id:'review',path:program,sha256:hash};
 const pack={schema:'eaol-recovery-v1',slug:'demo',title:'Closing fixture',fps:30,frames:600,hosts:{host_1:'A',host_2:'B'},sources:['host_1','host_2'].map(host=>({id:host,role:`${host}_camera`,part:1,path:program,sha256:hash})),blocks:[{startFrame:0,endFrame:600,cameras:{host_1:{sourceId:'host_1',startSec:0},host_2:{sourceId:'host_2',startSec:0}}}],shots:[{startFrame:0,endFrame:600,view:'two'}],review,evidence:[review,{id:'acceptance',path:evidencePath,sha256:await sha256(evidencePath)}],approvals:[{evidenceId:'acceptance',targetId:'review',targetSha256:hash,scope:'fixture continuity',reviewer:'Test',kind:'accepted',checks:[{path:['approved'],equals:true}]}],finalMasterApproved:false,finalVisualTreatmentApproved:false};
 const file=join(assets,'package.json');writeRecoveryJson(file,pack);await importRecovery(work,file);const dir=join(work,'demo');
 const baseline=readFileSync(join(dir,'recovery.json'),'utf8');const state=loadClosingTransition(dir);assert.equal(state.ready,true);
 assert.throws(()=>validateClosingSettings({leadSec:15,gainDb:-4},probe(source)),/leave at least/);assert.throws(()=>validateClosingSettings({leadSec:8,gainDb:1},probe(source)),/gain/);
 await assert.rejects(renderClosingTransition(dir,{inputsKey:'stale',sourcePath:source,leadSec:8,gainDb:-4}),/inputs changed/);
 const r=await renderClosingTransition(dir,{inputsKey:state.inputsKey,sourcePath:source,leadSec:8,gainDb:-4});
 assert.equal(r.musicStartsSec,12);assert.equal(r.closingPictureStartsSec,20);assert.equal(r.checks.frames,780);assert.equal(r.checks.dialogueStemUnchanged,true);assert.equal(r.checks.beforeMusicPcmUnchanged,true);assert(r.checks.truePeakDbtp<=-1);assert.equal(r.humanApproved,false);
 assert.equal(readFileSync(join(dir,'recovery.json'),'utf8'),baseline);assert.equal(await sha256(program),hash);
 const pixel=t=>ff(['-ss',String(t),'-i',r.output.path,'-vf','crop=2:2:640:360','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-']);
 assert(pixel(19)[1]>70);assert(pixel(21)[2]>150);
 const pcm=file=>{const b=ff(['-i',file,'-map','0:a:0','-af','aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo','-c:a','pcm_f32le','-f','f32le','-']);return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));};
 const original=pcm(source),music=pcm(join(r.output.path,'..','closing_music.wav'));
 assert(music.subarray(0,12*48000*2).every(x=>x===0),'Music must not enter early');
 for(const t of [.5,7.5,8.5,12.5]){
   const i=Math.round(t*48000)*2,offset=12*48000*2,expectedGain=10**(-4/20)*(t<8?.22+.78*t/8:1);
   for(let j=0;j<200;j++)assert(Math.abs(music[offset+i+j]-original[i+j]*expectedGain)<.001,'Continuous source offset and gain across picture cut');
 }
 assert.throws(()=>validateClosingSettings({leadSec:8,gainDb:-4,trimProgramEndSec:6},probe(source)),/tail trim/);
 const revised=await renderClosingTransition(dir,{inputsKey:state.inputsKey,sourcePath:source,leadSec:8,gainDb:-4,trimProgramEndSec:1.8});
 assert.equal(revised.settings.trimProgramEndFrames,54);assert.equal(revised.programPreview.startFrame,0);assert.equal(revised.programPreview.endFrame,546);
 assert.equal(revised.closingPictureStartsSec,18.2);assert.equal(revised.musicStartsSec,10.2);assert.equal(revised.checks.frames,726);assert.equal(revised.checks.dialogueStemUnchanged,true);
 const revisedPixel=t=>ff(['-ss',String(t),'-i',revised.output.path,'-vf','crop=2:2:640:360','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-']);
 assert(revisedPixel(18.1)[1]>70);assert(revisedPixel(18.2)[2]>150,'Picture must switch at exactly 18.2 seconds');
 server=createStudioServer({root:resolve('.'),workRoot:work});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/api/episodes/demo/recovery/closing-transition`;
 assert.equal((await fetch(url)).status,200);const media=await fetch(`${url}/media`,{headers:{Range:'bytes=0-31'}});assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,32);
 writeRecoveryJson(join(dir,'recovery_draft.json'),{shots:pack.shots,notes:'changed',revision:1});assert.notEqual(closingInputs(dir).key,state.inputsKey);assert.equal(loadClosingTransition(dir).receipt.stale,true);assert.equal((await fetch(`${url}/media`)).status,409);
 appendFileSync(source,'changed');assert.equal(loadClosingTransition(dir).receipt.stale,true);
 console.log('PASS: closing timing, continuous music ramp, unchanged dialogue, source preservation, peak checks, settings, API media and stale refusal');
}finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}rmSync(work,{recursive:true,force:true});}
