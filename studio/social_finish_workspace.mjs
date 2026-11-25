import {existsSync,readdirSync,readFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {inside,fingerprint,signature,writeRecoveryJson} from './recovery.mjs';
import {localDestination} from './release_workspace.mjs';
import {loadSocialWorkspace} from './social_workspace.mjs';
import {validateFinishRecipe,renderFinishedClip,FINISH_VERSION} from './social_finishing.mjs';
const uuid=/^[a-f0-9-]{36}$/;
function folder(dir,id){if(!uuid.test(id))throw Error('Choose an existing clip version');return localDestination(dir,'social_workspace',id);}
export function loadFinishes(dir,draft,stale=false) {
  const base=localDestination(folder(dir,draft.id),'finishes');if(!existsSync(base))return [];
  return readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory()&&uuid.test(d.name)).slice(0,200).map(d=>{
    const out=localDestination(base,d.name),read=n=>{const p=join(out,n);inside(p,[out]);return JSON.parse(readFileSync(p,'utf8'));};
    try {
      const r=read('receipt.json'),v=read('studio_verification.json'),plan=read('plan.json');
      const {fingerprint:fp,...body}=plan;
      let current=!stale&&!!draft.render&&r.schema==='eaol-social-finished-v1'&&r.implementation===FINISH_VERSION&&r.status==='technically_verified'&&r.plan_fingerprint===fp&&fingerprint(body)===fp&&v.receipt_fingerprint===fingerprint(r)&&v.plan_fingerprint===fp&&r.parent.plan_fingerprint===draft.plan_fingerprint;
      const parent=join(folder(dir,draft.id),'clip.mp4');inside(parent,[dir]);
      current=current&&fingerprint(signature(parent))===fingerprint(v.parent_signature);
      for(const key of ['master','preview']){const file=localDestination(out,key==='master'?'clip.mp4':'preview.mp4');inside(file,[out]);current=current&&fingerprint(signature(file))===fingerprint(v.outputs[key]);}
      if(plan.recipe.mode==='spoken_line'){inside(plan.recipe.ending.path,[dir]);current=current&&fingerprint(signature(plan.recipe.ending.path))===fingerprint(v.ending_signature);}
      return {id:d.name,current,episode_number:r.episode_number,mode:r.mode,created_at:r.created_at,duration_ms:r.duration_ms,master_sha256:r.outputs.master.sha256,editorial_approval:'pending'};
    } catch {return {id:d.name,current:false,editorial_approval:'pending'};}
  });
}
export function finishJobArgs(root,dir,state,body,episodeNumber) {
  if(!state.source||state.stale||body.revision!==state.revision||body.confirmLocalFinish!==true)throw Error('Confirm finishing the current saved clip version');
  const draft=state.drafts.find(d=>d.id===body.id);if(!draft?.render)throw Error('Render and technically check the base clip first');
  const {recipe}=validateFinishRecipe(body.recipe,episodeNumber);
  if(!episodeNumber)throw Error('Set the episode identity before finishing in Studio');
  if(recipe.mode==='spoken_line')inside(recipe.ending.path,[dir]);
  if(loadFinishes(dir,draft).length>=200)throw Error('This draft already has 200 finished versions');
  return [join(root,'studio','social_finish_workspace.mjs'),resolve(dir),draft.id,JSON.stringify(state.source),state.revision,JSON.stringify(recipe),String(episodeNumber),randomUUID()];
}
export function finishArtifactPath(dir,state,draftId,finishId,kind) {
  const draft=state.drafts.find(d=>d.id===draftId);if(!draft)throw Error('Unknown draft');
  const finish=loadFinishes(dir,draft,state.stale).find(f=>f.id===finishId&&f.current);if(!finish)throw Error('No current finished clip');
  const names={preview:'preview.mp4',master:'clip.mp4',review:'REVIEW.md',receipt:'receipt.json'};
  if(!names[kind])throw Error('Unknown finishing artifact');
  const file=localDestination(folder(dir,draftId),'finishes',finishId,names[kind]);inside(file,[dir]);return file;
}
export function runFinishWorker(dir,id,source,revision,recipe,episodeNumber,finishId) {
  if(!uuid.test(finishId))throw Error('Invalid finished version');
  inside(source.path,[dir]);if(fingerprint(signature(source.path))!==fingerprint(source.signature))throw Error('Final source changed');
  const state=loadSocialWorkspace(dir,source);
  finishJobArgs('',dir,state,{id,revision,recipe,confirmLocalFinish:true},episodeNumber);
  const draft=folder(dir,id),base=localDestination(draft,'finishes');mkdirSync(base,{recursive:true});
  const out=localDestination(base,finishId),receipt=renderFinishedClip(draft,recipe,out,episodeNumber);
  if(fingerprint(signature(source.path))!==fingerprint(source.signature))throw Error('Final source changed during finishing');
  writeRecoveryJson(localDestination(out,'studio_verification.json'),{plan_fingerprint:receipt.plan_fingerprint,receipt_fingerprint:fingerprint(receipt),parent_signature:signature(join(draft,'clip.mp4')),ending_signature:recipe.ending?signature(recipe.ending.path):null,outputs:Object.fromEntries(['master','preview'].map(k=>[k,signature(join(out,k==='master'?'clip.mp4':'preview.mp4'))]))});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{runFinishWorker(resolve(process.argv[2]),process.argv[3],JSON.parse(process.argv[4]),process.argv[5],JSON.parse(process.argv[6]),Number(process.argv[7]),process.argv[8]);}catch(e){console.error(e.message);process.exitCode=1;}}
