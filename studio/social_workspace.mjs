// Finished-master test drafts. A source pack is prepared evidence, not approval.
import {existsSync, readFileSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {inside, fingerprint, signature, writeRecoveryJson} from './recovery.mjs';
import {localDestination} from './release_workspace.mjs';
import {validatePack, makeRecipe, buildPortablePlan, renderPortable} from './social_portable.mjs';
import {validateShortTitle} from './release_policy.mjs';

function read(dir,name) {
  const p=localDestination(dir,name); if(!existsSync(p)) return null;
  inside(p,[dir]);return JSON.parse(readFileSync(p,'utf8'));
}
function requireSource(state) {
  if(!state.source || !state.pack || state.stale) throw Error('Import a source pack matching the current final master first');
}
export function loadSocialWorkspace(dir,source) {
  const saved=read(dir,'social_workspace.json');
  const stale=Boolean(saved && (!source || saved.source_key!==source.key));
  const drafts=(saved?.drafts || []).map(d=>{
    let render=null;
    try {
      const receipt=read(dir,`social_workspace/${d.id}/receipt.json`);
      const verified=read(dir,`social_workspace/${d.id}/studio_verification.json`);
      if(receipt && verified && verified.plan_fingerprint===d.plan_fingerprint && !stale && receipt.plan_fingerprint===d.plan_fingerprint && receipt.status==='technically_verified') {
        const folder=localDestination(dir,'social_workspace',d.id);
        for(const key of ['master','preview']) {
          const file=join(folder,receipt.outputs[key].file);inside(file,[folder]);
          if(fingerprint(signature(file))!==fingerprint(verified.outputs[key]) || signature(file).bytes!==receipt.outputs[key].bytes) throw Error('Changed rendered file');
        }
        render={status:receipt.status,editorial_approval:'pending'};
      }
    } catch {}
    return {...d,render};
  });
  return {source,pack:saved?.pack || null,stale,drafts,revision:fingerprint({saved,sourceKey:source?.key}),publication_authorized:false};
}
export function saveSocialWorkspace(dir,source,body) {
  const state=loadSocialWorkspace(dir,source);
  if(body.revision!==state.revision) throw Error('Social workspace changed; reload before saving');
  let pack=state.pack,drafts=state.drafts.map(({render,...d})=>d);
  if(body.pack) {
    if(!source) throw Error('A current final master is required');
    pack=validatePack(body.pack);
    if(pack.source.bytes!==source.signature.bytes || (source.sha256 && pack.source.sha256!==source.sha256)) throw Error('Source pack does not match the current final master');
    // Import is immutable once recipes exist. Keep provenance rather than rebind old work.
    if(drafts.length && (state.stale || pack.fingerprint!==state.pack?.fingerprint)) throw Error('Existing drafts belong to a different source pack; retain them and prepare a separate workspace');
  } else {
    requireSource(state);
    const recipe=body.recipe || makeRecipe(pack,{id:'draft',title:String(body.title || ''),start:Number(body.start_ms),end:Number(body.end_ms),layout:body.layout});
    validateShortTitle(recipe.title);
    const selection={...recipe,status:'test_draft',editorial_approval:'pending'};
    const plan=buildPortablePlan(pack,selection),id=randomUUID();
    if(drafts.length>=200) throw Error('This workspace has 200 draft versions; use the existing versions');
    drafts.push({id,selection,plan_fingerprint:plan.fingerprint,warnings:plan.layout.warnings,created_at:new Date().toISOString()});
  }
  writeRecoveryJson(localDestination(dir,'social_workspace.json'),{schema:'eaol-social-workspace-v1',source_key:source.key,pack,drafts});
  return loadSocialWorkspace(dir,source);
}
export function socialJobArgs(root,dir,state,body) {
  requireSource(state);
  if(body.revision!==state.revision || body.confirmLocalRender!==true) throw Error('Confirm a local test render of this saved draft');
  const draft=state.drafts.find(d=>d.id===body.id);if(!draft) throw Error('Choose a saved draft');
  const folder=localDestination(dir,'social_workspace',draft.id);
  if(existsSync(folder)) throw Error('This version already has render files. Save a new draft version before rendering again');
  return [join(root,'studio','social_workspace.mjs'),resolve(dir),draft.id,JSON.stringify(state.source),state.revision];
}
export function socialPreviewPath(dir,state,id) {
  const draft=state.drafts.find(d=>d.id===id);if(!draft?.render) throw Error('No current technically checked draft');
  const file=localDestination(dir,'social_workspace',id,'preview.mp4');inside(file,[dir]);return file;
}
function run(dir,id,source,revision) {
  if(fingerprint(signature(source.path))!==fingerprint(source.signature)) throw Error('Final master changed');
  inside(source.path,[dir]);const state=loadSocialWorkspace(dir,source);
  socialJobArgs('',dir,state,{id,revision,confirmLocalRender:true});
  const draft=state.drafts.find(d=>d.id===id);
  const parent=localDestination(dir,'social_workspace');mkdirSync(parent,{recursive:true});
  // Existing renderer hashes the complete source before and after rendering.
  const out=localDestination(dir,'social_workspace',id);
  const receipt=renderPortable(state.pack,draft.selection,source.path,out);
  if(fingerprint(signature(source.path))!==fingerprint(source.signature)) throw Error('Final master changed during render');
  writeRecoveryJson(localDestination(out,'studio_verification.json'),{plan_fingerprint:draft.plan_fingerprint,outputs:Object.fromEntries(['master','preview'].map(key=>[key,signature(join(out,receipt.outputs[key].file))]))});
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {run(resolve(process.argv[2]),process.argv[3],JSON.parse(process.argv[4]),process.argv[5]);}
  catch(e) {console.error(e.message);process.exitCode=1;}
}
