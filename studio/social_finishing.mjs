#!/usr/bin/env node
// Additive finishing over a checked portable draft. Never supplies human approval.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolveTool} from '../platform_tools.mjs';
import {shaFile} from './social_portable.mjs';
import {fingerprint,inside} from './recovery.mjs';
import {validateShortTitle} from './release_policy.mjs';
const must=(v,message)=>{if(!v)throw Error(message);};
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const ownKeys=(o,allowed)=>{for(const k of Object.keys(o||{}))must(allowed.includes(k),`Unknown finishing field: ${k}`);};
const run=(tool,args,cwd)=>{const r=spawnSync(resolveTool(tool),['-protocol_whitelist','file,pipe',...args],{cwd,encoding:'utf8',maxBuffer:32*1024*1024});must(r.status===0,`${tool}: ${r.error?.message||r.stderr||'failed'}`);return r;};
const probe=p=>JSON.parse(run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',p]).stdout);
const safeFile=p=>{must(typeof p==='string'&&path.isAbsolute(p)&&fs.statSync(p).isFile(),'Use an absolute local media file path');return p;};
export const FINISH_VERSION='generic-v1';
export function validateFinishRecipe(recipe,knownEpisode=null) {
  ownKeys(recipe,['schema','episode_number','mode','duration_ms','spoken_text','ending','overlay_y']);
  if(recipe.overlay_y!==undefined)must(Number.isInteger(recipe.overlay_y)&&recipe.overlay_y>=180&&recipe.overlay_y<=1200,'Keep the episode cue between 180 and 1,200 pixels from the top');
  must(recipe.schema==='eaol-social-finishing-v1','Wrong finishing recipe schema');
  const n=recipe.episode_number;
  must(Number.isInteger(n)&&n>=1&&n<=9999,'Enter the real episode number');
  if(knownEpisode)must(n===knownEpisode,'Finishing episode differs from this workspace');
  const overlay=`The full conversation is in Episode ${n}`;
  if(recipe.mode==='text_overlay') {
    must(!recipe.ending&&!recipe.spoken_text,'Text-only mode cannot add spoken media');
    must(Number.isInteger(recipe.duration_ms)&&recipe.duration_ms>=3000&&recipe.duration_ms<=5000,'Episode cue must last 3–5 seconds');
  } else {
    must(recipe.mode==='spoken_line','Choose spoken_line or text_overlay');
    must(!recipe.duration_ms,'Spoken duration comes from the recorded range');
    must(typeof recipe.spoken_text==='string'&&recipe.spoken_text.trim().replace(/[.!?]$/,'').toLowerCase()===overlay.toLowerCase(),'Transcribe the recorded line exactly: '+overlay+'. Do not synthesize or invent speech');
    const e=recipe.ending;must(e&&typeof e==='object','Choose a real recorded closing line');
    ownKeys(e,['path','sha256','bytes','start_ms','end_ms','crop','gain_db']);
    if(e.gain_db!==undefined)must(Number.isFinite(e.gain_db)&&e.gain_db>=-12&&e.gain_db<=12,'Ending gain must be between -12 and +12 dB');
    must(typeof e.path==='string'&&path.isAbsolute(e.path),'Use an absolute local ending path');
    must(/^[a-f0-9]{64}$/.test(e.sha256)&&Number.isInteger(e.bytes)&&e.bytes>0,'Bind the recorded ending with its bytes and SHA-256');
    must(Number.isInteger(e.start_ms)&&Number.isInteger(e.end_ms)&&e.start_ms>=0&&e.end_ms-e.start_ms>=3000&&e.end_ms-e.start_ms<=5000,'Recorded ending must be a complete 3–5 second line');
    ownKeys(e.crop,['x','y','width','height']);
    must(e.crop&&['x','y','width','height'].every(k=>Number.isInteger(e.crop[k])&&e.crop[k]%2===0)&&e.crop.x>=0&&e.crop.y>=0&&e.crop.width>=180&&e.crop.height>=320&&Math.abs(e.crop.width/e.crop.height-9/16)<.002,'Choose an even-pixel 9:16 crop within the recorded picture');
  }
  return {recipe:structuredClone(recipe),overlay,duration_ms:recipe.mode==='text_overlay'?recipe.duration_ms:recipe.ending.end_ms-recipe.ending.start_ms};
}
export function inspectFinishSource(draftDir) {
  const dir=path.resolve(draftDir),receipt=read(path.join(dir,'receipt.json')),plan=read(path.join(dir,'plan.json'));
  const {fingerprint:fp,...body}=plan;
  must(plan.schema==='eaol-portable-social-draft-v1'&&fingerprint(body)===fp,'Portable draft plan changed');
  must(receipt.schema==='eaol-portable-social-render-v1'&&receipt.status==='technically_verified'&&receipt.plan_fingerprint===fp&&receipt.source_sha256===plan.source.sha256,'Use a technically checked portable draft with its matching plan and receipt');
  must(receipt.outputs.master.file==='clip.mp4'&&receipt.outputs.master.full_decode_passed===true,'Missing checked portable master');
  validateShortTitle(plan.selection.title);
  const file=path.join(dir,'clip.mp4');inside(file,[dir]);
  must(fs.statSync(file).size===receipt.outputs.master.bytes&&shaFile(file)===receipt.outputs.master.sha256,'Draft clip changed after its receipt');
  return {dir,file,receipt,plan};
}
export function buildFinishPlan(draftDir,recipe,knownEpisode=null) {
  const validated=validateFinishRecipe(recipe,knownEpisode),parent=inspectFinishSource(draftDir);
  const duration=parent.plan.duration_ms;
  must(Number.isInteger(duration)&&duration>=15000&&duration<=90000,'Parent duration is outside the portable draft contract');
  const p={schema:'eaol-social-finish-plan-v1',implementation:FINISH_VERSION,recipe:validated.recipe,overlay:validated.overlay,
    parent:{sha256:parent.receipt.outputs.master.sha256,bytes:parent.receipt.outputs.master.bytes,plan_fingerprint:parent.plan.fingerprint,source_sha256:parent.receipt.source_sha256},
    title:parent.plan.selection.title,body_duration_ms:duration,ending_duration_ms:validated.duration_ms,
    duration_ms:duration+(recipe.mode==='spoken_line'?validated.duration_ms:0),
    ending_start_ms:recipe.mode==='spoken_line'?duration:duration-validated.duration_ms,
    caption_warnings:parent.receipt.caption_warnings||[],editorial_approval:'pending',human_complete_watch:false,publication_authorized:false};
  return {...p,fingerprint:fingerprint(p)};
}
function verifyEnding(recipe) {
  if(recipe.mode!=='spoken_line')return;
  const e=recipe.ending;safeFile(e.path);
  must(fs.statSync(e.path).size===e.bytes&&shaFile(e.path)===e.sha256,'Recorded ending changed');
  const m=probe(e.path),v=m.streams.find(s=>s.codec_type==='video'),a=m.streams.find(s=>s.codec_type==='audio');
  must(v&&a&&Number(m.format.duration)*1000+30>=e.end_ms,'Recorded ending is missing video/audio or is shorter than the selected range');
  must(!(v.side_data_list||[]).some(s=>s.rotation),'Normalize and review rotated ending footage first');
  must(e.crop.x+e.crop.width<=v.width&&e.crop.y+e.crop.height<=v.height,'Ending crop is outside the recorded picture');
}
function timestamp(ms){const cs=Math.round(ms/10);return `${Math.floor(cs/360000)}:${String(Math.floor(cs/6000)%60).padStart(2,'0')}:${String(Math.floor(cs/100)%60).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`;}
export function endingAss(plan) {
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Ending,Inter,52,&H00FFFFFF,&H00FFFFFF,&H00131C20,&H90131C20,1,0,0,0,100,100,0,0,3,14,0,8,120,120,${plan.recipe.overlay_y ?? 230},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 10,${timestamp(plan.ending_start_ms)},${timestamp(plan.duration_ms)},Ending,,0,0,0,,The full conversation\\Nis in Episode ${plan.recipe.episode_number}\n`;
}
export function renderFinishedClip(draftDir,recipe,out,knownEpisode=null) {
  const plan=buildFinishPlan(draftDir,recipe,knownEpisode),parent=inspectFinishSource(draftDir);
  out=path.resolve(out);must(!fs.existsSync(out),'Output exists; choose a new finished version');
  const base=path.dirname(out);must(fs.existsSync(base)&&fs.statSync(base).isDirectory(),'Create the output parent directory first');
  must(fs.statfsSync(base).bavail*fs.statfsSync(base).bsize>1024**3,'Need 1 GiB free for finishing');
  verifyEnding(recipe);
  const meta=probe(parent.file),v=meta.streams.find(s=>s.codec_type==='video'),a=meta.streams.find(s=>s.codec_type==='audio');
  must(v?.width===1080&&v.height===1920&&v.codec_name==='h264'&&a?.codec_name==='aac'&&Math.abs(Number(meta.format.duration)*1000-plan.body_duration_ms)<150,'Parent media differs from the expected 1080×1920 portable draft');
  fs.mkdirSync(out);const save=(name,value)=>fs.writeFileSync(path.join(out,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  save('plan.json',plan);save('recipe.json',recipe);save('ending.ass',endingAss(plan));
  const fonts=fileURLToPath(new URL('../fonts/',import.meta.url));
  fs.copyFileSync(path.join(fonts,'Inter-Bold.ttf'),path.join(out,'Inter-Bold.ttf'),fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(fonts,'OFL-LICENSE.txt'),path.join(out,'OFL-LICENSE.txt'),fs.constants.COPYFILE_EXCL);
  const dur=plan.body_duration_ms/1000,ending=plan.ending_duration_ms/1000;
  const args=['-v','error','-n','-i',parent.file];
  let filter;
  if(recipe.mode==='spoken_line') {
    const e=recipe.ending,c=e.crop;args.push('-ss',String(e.start_ms/1000),'-t',String(ending),'-i',e.path);
    filter=`[0:v]trim=duration=${dur},setpts=PTS-STARTPTS,fps=30,setsar=1,format=yuv420p[v0];[0:a]atrim=duration=${dur},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a0];[1:v]trim=duration=${ending},setpts=PTS-STARTPTS,crop=${c.width}:${c.height}:${c.x}:${c.y},scale=1080:1920,fps=30,setsar=1,format=yuv420p[v1];[1:a]atrim=duration=${ending},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${e.gain_db ?? 0}dB[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a];[vc]ass=ending.ass:fontsdir=.[v]`;
  } else filter=`[0:v]trim=duration=${dur},setpts=PTS-STARTPTS,ass=ending.ass:fontsdir=.[v];[0:a]atrim=duration=${dur},asetpts=PTS-STARTPTS[a]`;
  args.push('-filter_complex',filter,'-map','[v]','-map','[a]','-t',String(plan.duration_ms/1000),'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-r','30','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart',path.join(out,'clip.mp4'));
  run('ffmpeg',args,out);
  run('ffmpeg',['-v','error','-n','-i',path.join(out,'clip.mp4'),'-vf','scale=540:960','-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',path.join(out,'preview.mp4')]);
  const outputs={};
  for(const [key,name,w,h] of [['master','clip.mp4',1080,1920],['preview','preview.mp4',540,960]]) {
    const file=path.join(out,name),m=probe(file),vv=m.streams.find(s=>s.codec_type==='video'),aa=m.streams.find(s=>s.codec_type==='audio');
    must(vv?.width===w&&vv.height===h&&vv.codec_name==='h264'&&vv.pix_fmt==='yuv420p'&&vv.avg_frame_rate==='30/1'&&aa?.codec_name==='aac'&&Number(aa.sample_rate)===48000&&aa.channels===2&&Math.abs(Number(m.format.duration)*1000-plan.duration_ms)<150,'Finished output metadata failed');
    run('ffmpeg',['-v','error','-xerror','-i',file,'-map','0:v:0','-map','0:a:0','-f','null','-']);
    outputs[key]={file:name,bytes:fs.statSync(file).size,sha256:shaFile(file),full_decode_passed:true};
  }
  const signal=run('ffmpeg',['-hide_banner','-i',path.join(out,'clip.mp4'),'-vf','blackdetect=d=0.3:pix_th=0.10,freezedetect=n=-60dB:d=2','-af','silencedetect=n=-50dB:d=0.5,ebur128=peak=true','-f','null','-']);save('signal_analysis.log',signal.stderr);
  must(buildFinishPlan(draftDir,recipe,knownEpisode).fingerprint===plan.fingerprint,'Parent changed during finishing');verifyEnding(recipe);
  const receipt={schema:'eaol-social-finished-v1',implementation:FINISH_VERSION,created_at:new Date().toISOString(),status:'technically_verified',plan_fingerprint:plan.fingerprint,parent:plan.parent,episode_number:recipe.episode_number,mode:recipe.mode,duration_ms:plan.duration_ms,outputs,editorial_approval:'pending',human_complete_watch:false,publication_authorized:false,
    pending:['Watch the complete finished master','Verify selection, opening, framing/camera, captions, sound and ending','Listen to the real spoken line and transition; typed transcript is not audio verification','Check overlay position against faces, captions and platform controls','Set Related Video to this full episode and keep Shorts out of the podcast playlist']};
  if(recipe.mode==='text_overlay')receipt.pending[2]='Check the final text cue over the unchanged speech';
  save('receipt.json',receipt);
  save('REVIEW.md',`# Finished social clip: human review pending\n\n${plan.title}\n\nEpisode ${recipe.episode_number}; ${recipe.mode}; ${(plan.duration_ms/1000).toFixed(2)} seconds.\nMaster SHA-256: ${outputs.master.sha256}\nParent SHA-256: ${plan.parent.sha256}\n\nWatch clip.mp4 completely. Preview is lower resolution. Technical validation is not editorial approval or posting authorization.\n\n${['Selection','Opening','Framing/camera changes','Captions','Sound','Ending'].map(x=>`- ${x}: [keep/change/reject, timestamp and note]`).join('\n')}\n\nReviewer: [name]\nReviewed at: [date]\nOverall decision: [keep/change/reject]\n\n${receipt.pending.map(x=>'- '+x).join('\n')}\n\nRevise the recipe into a new output directory; preserve this version. Never transfer approval to changed bytes.\n`);
  return receipt;
}
export function runFinishCli(argv) {
  const [command,...rest]=argv,args={};
  for(let i=0;i<rest.length;i+=2){must(['--draft','--recipe','--out'].includes(rest[i])&&rest[i+1]&&!args[rest[i]],'Use inspect|plan|render --draft DIRECTORY [--recipe JSON --out NEW_DIRECTORY]');args[rest[i]]=rest[i+1];}
  must(args['--draft'],'Supply the existing portable draft directory');
  if(command==='inspect'){const p=inspectFinishSource(args['--draft']);return {title:p.plan.selection.title,parent_sha256:p.receipt.outputs.master.sha256,duration_ms:p.plan.duration_ms,editorial_approval:'pending'};}
  must(args['--recipe']&&['plan','render'].includes(command),'Use plan or render with --recipe');
  const recipe=read(args['--recipe']);if(command==='plan')return buildFinishPlan(args['--draft'],recipe);
  must(args['--out'],'Render needs a fresh --out directory');return renderFinishedClip(args['--draft'],recipe,args['--out']);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{console.log(JSON.stringify(runFinishCli(process.argv.slice(2)),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
