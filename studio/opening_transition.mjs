// Short, source-bound opening-to-recovered-program review, not a full episode export.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveTool } from '../platform_tools.mjs';
import { loadRecovery, readRecoveryJson, writeRecoveryJson, fingerprint, signature, sha256, probe } from './recovery.mjs';
import { loadNumberedOpening } from './numbered_opening.mjs';
import { renderRecoveryPreview } from './recovery_render.mjs';
import { balanceOpeningToProgram } from './episode_renderer.mjs';
const HERE=dirname(fileURLToPath(import.meta.url));
const implementation=()=>fingerprint(['opening_transition.mjs','recovery_render.mjs','recovery_framing.mjs','recovery_color.mjs','episode_renderer.mjs'].map(f=>readFileSync(join(HERE,f),'utf8')));
export function transitionInputs(dir) {
  const p=loadRecovery(dir).recovery, opening=loadNumberedOpening(dir);
  const acceptance=existsSync(join(dir,'numbered_opening_acceptance.json')) ? readRecoveryJson(join(dir,'numbered_opening_acceptance.json')) : null;
  if(p.staleInputs.length) throw new Error('Recovery inputs changed; re-verify first');
  if(!opening.render || opening.render.stale || !acceptance?.approved || acceptance.output?.sha256!==opening.render.output.sha256 || acceptance.recipeFingerprint!==opening.recipe.fingerprint) throw new Error('Review and accept the current numbered opening before preparing its transition');
  return {p,opening:opening.render,acceptance,key:fingerprint({draft:p.draftFingerprint,opening:opening.render.output.sha256,acceptance,implementation:implementation()})};
}
export function loadOpeningTransition(dir) {
  let inputs,error;
  try {inputs=transitionInputs(dir);} catch(e) {error=e.message;}
  const receipt=existsSync(join(dir,'opening_transition.json')) ? readRecoveryJson(join(dir,'opening_transition.json')) : null;
  let current=false;
  try {current=Boolean(inputs && receipt && inputs.key===receipt.inputsKey && fingerprint(signature(receipt.output.path))===fingerprint(receipt.output.signature));} catch {}
  return {ready:Boolean(inputs),error: error || null,inputsKey:inputs?.key || null,receipt:receipt ? {...receipt,stale:!current}:null};
}
export function validateTransitionSettings(body,duration) {
  if(!Number.isFinite(body.trimEndSec)||body.trimEndSec<0||body.trimEndSec>10||duration-body.trimEndSec<8) throw new Error('Opening tail trim must leave at least eight seconds');
  if(!Number.isFinite(body.fadeInSec)||body.fadeInSec<0||body.fadeInSec>2) throw new Error('Program picture fade must be 0–2 seconds');
  return {trimEndSec:body.trimEndSec,fadeInSec:body.fadeInSec,openingContextSec:8,programContextSec:12};
}
function run(args) {
 const r=spawnSync(resolveTool('ffmpeg'),['-hide_banner','-v','error','-nostdin',...args],{encoding:'utf8',maxBuffer:8*1024*1024});if(r.status!==0)throw new Error(r.stderr||'Transition render failed');return r.stdout;
}
export function composeOpeningTransition({openingPath,programPath,folder,openingEndSec,settings}) {
 const head=settings.openingContextSec,body=settings.programContextSec;
 if(!Number.isFinite(openingEndSec)||openingEndSec<head)throw new Error('Invalid opening transition endpoint');
 const mix=join(folder,'transition_mix.wav');
 const normalize=`aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo`;
 run(['-i',openingPath,'-i',programPath,'-filter_complex_threads','1','-filter_complex',`[0:a:0]${normalize},atrim=start_sample=${Math.round((openingEndSec-head)*48000)}:end_sample=${Math.round(openingEndSec*48000)},asetpts=PTS-STARTPTS,apad=whole_len=${head*48000},atrim=end_sample=${head*48000}[ao];[1:a:0]${normalize},atrim=start_sample=0:end_sample=${body*48000},asetpts=PTS-STARTPTS[ap];[ao][ap]concat=n=2:v=0:a=1[a]`,'-map','[a]','-c:a','pcm_f32le',mix]);
 const output=join(folder,'preview.mp4');
 run(['-ss',String(openingEndSec-head),'-i',openingPath,'-i',programPath,'-i',mix,'-filter_complex_threads','1','-filter_complex',`[0:v:0]fps=30,scale=1280:720,setsar=1,trim=end_frame=${head*30},setpts=PTS-STARTPTS[vo];[1:v:0]fps=30,setsar=1,trim=end_frame=${body*30},setpts=PTS-STARTPTS${settings.fadeInSec ? `,fade=t=in:st=0:d=${settings.fadeInSec}` : ''}[vp];[vo][vp]concat=n=2:v=1:a=0[v]`,'-map','[v]','-map','2:a:0','-t',String(head+body),'-c:v','libx264','-threads','4','-preset','veryfast','-crf','18','-c:a','aac','-b:a','192k','-movflags','+faststart',output]);
 const metadata=probe(output),video=metadata.streams.find(s=>s.codec_type==='video');
 if(Number(video.nb_frames)!==(head+body)*30||Math.abs(Number(metadata.format.duration)-(head+body))>.05)throw new Error('Transition frame count or duration check failed');
 run(['-i',output,'-f','null','-']);
 // Audio before AAC encoding must preserve every program sample and its entry point.
 const hash=(file,filter)=>run(['-i',file,'-map','0:a:0','-af',filter,'-c:a','pcm_f32le','-f','hash','-hash','sha256','-']).trim();
 const programHash=hash(programPath,`${normalize},atrim=start_sample=0:end_sample=${body*48000},asetpts=PTS-STARTPTS`);
 const mixHash=hash(mix,`atrim=start_sample=${head*48000}:end_sample=${(head+body)*48000},asetpts=PTS-STARTPTS`);
 if(programHash!==mixHash)throw new Error('Program audio changed or shifted at the transition');
 return {output,mix,metadata,programPcmHash:programHash};
}
export async function renderOpeningTransition(dir,body) {
 const inputs=transitionInputs(dir);if(inputs.key!==body.inputsKey)throw new Error('Transition inputs changed; reload first');
 const opening=inputs.opening.output;
 if(await sha256(opening.path)!==opening.sha256)throw new Error('Opening checksum changed');
 const settings=validateTransitionSettings(body,Number(probe(opening.path).format.duration));
 const folder=join(dir,'opening_transitions',randomUUID());mkdirSync(folder,{recursive:true});
 console.log('Rendering the first twelve seconds from the current camera draft');
 const program=await renderRecoveryPreview(dir,0,settings.programContextSec*30,inputs.p.draftFingerprint);
 console.log('Matching opening loudness to the full accepted conversation; conversation mix is unchanged');
 const balanced=join(folder,'opening_balanced.mp4');
 const audioBalance=balanceOpeningToProgram({openingPath:opening.path,programPath:inputs.p.review.path,outputPath:balanced,encodingHeadroomDb:.5});
 const openingEndSec=Math.round((Number(probe(opening.path).format.duration)-settings.trimEndSec)*30)/30;
 const result=composeOpeningTransition({openingPath:balanced,programPath:join(dir,program.file),folder,openingEndSec,settings});
 if(transitionInputs(dir).key!==inputs.key)throw new Error('Transition inputs changed during render');
 const receipt={schema:'eaol-opening-transition-v1',createdAt:new Date().toISOString(),inputsKey:inputs.key,settings,openingEndSec,openingSha256:opening.sha256,draftFingerprint:inputs.p.draftFingerprint,audioBalance,programPreview:program,programPcmHash:result.programPcmHash,output:{path:result.output,sha256:await sha256(result.output),signature:signature(result.output)},checks:{fullDecode:true,frames:600,durationSec:20,programAudioSamplesUnchanged:true},humanApproved:false,finalMasterApproved:false};
 writeRecoveryJson(join(folder,'receipt.json'),receipt);writeRecoveryJson(join(dir,'opening_transition.json'),receipt);
 console.log(`Opening transition ready for human review: ${result.output}`);return receipt;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)renderOpeningTransition(resolve(process.argv[2]),JSON.parse(process.argv[3])).catch(e=>{console.error(e.message);process.exitCode=1;});
