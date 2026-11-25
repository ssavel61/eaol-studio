import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createStudioServer } from './server.mjs';
import { spawnSync } from 'node:child_process';
import { resolveTool } from '../platform_tools.mjs';
import { loadNumberedOpening, saveNumberedOpening, renderNumberedOpening, openingLabel } from './numbered_opening.mjs';
import { sha256 } from './recovery.mjs';
const root = mkdtempSync(join(tmpdir(),'eaol-numbered-opening-')), dir=join(root,'ep2'); mkdirSync(dir);
const run = args => { const r=spawnSync(resolveTool('ffmpeg'),['-v','error','-nostdin',...args],{maxBuffer:16*1024*1024}); assert.equal(r.status,0,r.stderr?.toString()); return r.stdout; };
try {
 const source=join(root,'clean.mp4');
 run(['-f','lavfi','-i','color=c=black:s=640x360:r=30000/1001:d=3','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
 const sourceHash=await sha256(source);writeFileSync(join(dir,'recovery_draft.json'),'preserve this accepted draft');
 const input={sourcePath:source,episodeNumber:2,startSec:.5,endSec:2.5,cleanBaseConfirmed:true,saveAsDefault:true};
 assert.equal(openingLabel(2),'Episode 02');assert.equal(openingLabel(123),'Episode 123');
 for(const body of [{...input,episodeNumber:0},{...input,episodeNumber:1.5},{...input,cleanBaseConfirmed:false},{...input,startSec:2.8},{...input,endSec:4}]) await assert.rejects(saveNumberedOpening(dir,body,[root]));
 const link=join(root,'escape');symlinkSync('/etc/hosts',link);await assert.rejects(saveNumberedOpening(dir,{...input,sourcePath:link},[root]),/inside the local work/);
 let state=await saveNumberedOpening(dir,input,[root]);assert.equal(state.defaults.episodeNumber,undefined);
 await assert.rejects(saveNumberedOpening(dir,input,[root]),/draft changed/);
 const recipe2=state.recipe;
 const first=await renderNumberedOpening(dir,recipe2.fingerprint);assert.equal(loadNumberedOpening(dir).render.stale,false);assert.equal(first.checks.originalAudioPackets,true);
 assert.equal(first.humanApproved,false);assert.equal(await sha256(source),sourceHash);assert.equal(readFileSync(join(dir,'recovery_draft.json'),'utf8'),'preserve this accepted draft');
 const frame = (file,second) => run(['-ss',String(second),'-i',file,'-vf','crop=160:45:240:300','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-']);
 const before=frame(first.output.path,.1), visible=frame(first.output.path,1.3), after=frame(first.output.path,2.8);
 const lit = bytes => [...bytes].filter(v=>v>40).length;
 assert.equal(lit(before),0,'No badge before its window');assert(lit(visible)>500,'Badge visible inside window');assert.equal(lit(after),0,'No badge after its window');
 state=await saveNumberedOpening(dir,{...input,episodeNumber:3,expectedFingerprint:recipe2.fingerprint},[root]);assert.equal(state.render.stale,true);
 await assert.rejects(renderNumberedOpening(dir,recipe2.fingerprint),/recipe changed/);
 const second=await renderNumberedOpening(dir,state.recipe.fingerprint);assert.notEqual(second.output.path,first.output.path);assert.notDeepEqual(frame(second.output.path,1.3),visible,'New episode number changes actual picture');
 assert.equal(await sha256(first.output.path),first.output.sha256,'Previous render preserved');
 // Shared endpoint serves both recovered and regular episode workspaces.
 writeFileSync(join(dir,'episode.json'),'{}');
 const server=createStudioServer({root:resolve('.'),workRoot:root});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}/api/episodes/ep2/numbered-opening`;
 try {
  assert.equal((await fetch(url)).status,200);
  const media=await fetch(`${url}/media`,{headers:{Range:'bytes=0-31'}});assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,32);
  writeFileSync(join(dir,'recovery.json'),'{}'); // Numbered-opening route must precede the normal-pipeline guard.
  assert.equal((await fetch(url)).status,200);
  const stale=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(stale.status,400);
  appendFileSync(second.preview.path,'modified');assert.equal((await fetch(`${url}/media`)).status,409);
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 appendFileSync(second.preview.path,'modified');assert.equal(loadNumberedOpening(dir).render.stale,true);
 appendFileSync(source,'modified');assert.equal(loadNumberedOpening(dir).current,false);await assert.rejects(renderNumberedOpening(dir,state.recipe.fingerprint),/changed/);
 console.log('PASS: numbering, explicit clean-base gate, paths, stale source/recipe/output, visible label timing, original audio packets, preserved drafts and prior outputs');
} finally {rmSync(root,{recursive:true,force:true});}
