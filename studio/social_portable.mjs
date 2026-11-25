#!/usr/bin/env node
// Local draft production only. A portable source pack carries source evidence, never clip approval.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolveTool} from '../platform_tools.mjs';
import {validateFinalFraming,mergeCaptionPhrases,reconcileCaptionHandoffs,finalFramingFilter} from './social_final_framing.mjs';
import {buildCaptionLayout} from './social_captions.mjs';
import {socialAss} from './social_clip_renderer.mjs';
const must=(ok,msg)=>{if(!ok)throw new Error(msg)};
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function shaFile(p){const h=createHash('sha256'),fd=fs.openSync(p,'r'),buf=Buffer.alloc(4*1024*1024);try{let n;while((n=fs.readSync(fd,buf,0,buf.length,null)))h.update(buf.subarray(0,n));}finally{fs.closeSync(fd)}return h.digest('hex')}
function run(tool,args,cwd){const r=spawnSync(resolveTool(tool),args,{cwd,encoding:'utf8',maxBuffer:32*1024*1024});must(r.status===0,`${tool}: ${r.error?.message||r.stderr||'failed'}`);return r}
function probe(p){return JSON.parse(run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',p]).stdout)}
export function verifySource(pack,master,hash=shaFile){must(fs.statSync(master).size===pack.source.bytes,'Final 4K byte size differs');must(hash(master)===pack.source.sha256,'Final 4K SHA-256 differs; use the exact approved UPLOAD_4K file');}
export function validatePack(pack){must(pack.schema==='eaol-portable-social-source-v1','Wrong source-pack schema');const {fingerprint,...body}=pack;must(fingerprint===digest(body),'Source-pack fingerprint changed; restore the delivered source pack');must(pack.source?.sha256?.match(/^[a-f0-9]{64}$/)&&Number.isInteger(pack.source.bytes)&&pack.source.bytes>0,'Invalid source binding');must(Number.isFinite(pack.timeline_shift_ms)&&Math.abs(pack.timeline_shift_ms)<=100,'Invalid final timeline shift');must(pack.cues?.length>0&&pack.shots?.length>0&&Array.isArray(pack.graphics),'Missing source evidence');return pack;}
export function buildPortablePlan(pack,selection){
 validatePack(pack);
 const allowed=new Set(['id','title','start_ms','end_ms','status','editorial_approval','reason','caption_segment_ids','framing','caption_phrase_groups','caption_display_adjustments','caption_corrections','context_before','context_after']);
 for(const key of Object.keys(selection))must(allowed.has(key),`Unknown recipe field: ${key}`);
 const start=selection.start_ms,end=selection.end_ms;
 must(Number.isInteger(start)&&Number.isInteger(end)&&end-start>=15000&&end-start<=90000,'Use a 15–90 second whole-cue range in original final-master milliseconds');
 must(start>=pack.program.start_ms&&end<=pack.program.end_ms,'Selection outside program');
 const shots=pack.shots.filter(s=>s.end_ms>start&&s.start_ms<end);must(shots.length===1,'Source camera cut requires new framing review; choose a continuous source shot');
 must(pack.graphics.every(g=>Number.isFinite(g.start_ms)&&Number.isFinite(g.end_ms)),'Invalid graphic evidence');
 must(!pack.graphics.some(g=>g.start_ms<end&&g.end_ms>start),'Burned graphic intersects selection; choose another interval or obtain separate treatment');
 validateFinalFraming(selection.framing,start,end,pack.source.width,pack.source.height);
 const original=pack.cues.filter(c=>c.end_ms>start&&c.start_ms<end);
 must(JSON.stringify(original.map(c=>c.segment_id))===JSON.stringify(selection.caption_segment_ids),'Recipe cue IDs do not exactly match the selected source interval');
 let cues=original.map(c=>({...c}));const corrections=selection.caption_corrections||[];const seen=new Set();
 for(const edit of corrections){const cue=cues.find(c=>c.segment_id===edit.segment_id);must(cue&&!seen.has(edit.segment_id)&&edit.from===cue.text&&typeof edit.to==='string'&&edit.to.trim()&&typeof edit.reason==='string'&&edit.reason.trim(),'Caption correction requires unique cue ID, exact from text, nonempty to text and reason');must(!/[{}\\]/.test(edit.to),'Subtitle control characters refused');seen.add(edit.segment_id);cue.text=edit.to.trim();}
 cues=mergeCaptionPhrases(cues,selection.caption_phrase_groups);
 const adjusted=reconcileCaptionHandoffs(cues,selection.caption_display_adjustments);cues=adjusted.captions;
 if(selection.framing.mode==='speaker_cuts')must(cues.every(c=>selection.framing.shots.some(s=>s.speaker_id===c.speaker_id&&c.start_ms>=s.start_ms&&c.end_ms<=s.end_ms)),'Speaker crop does not match caption speaker');
 const layout=buildCaptionLayout(cues,start,end);
 const shift=pack.timeline_shift_ms,framing=structuredClone(selection.framing);
 if(framing.mode==='speaker_cuts')framing.shots=framing.shots.map(s=>({...s,start_ms:s.start_ms+shift,end_ms:s.end_ms+shift}));
 const plan={schema:'eaol-portable-social-draft-v1',source:pack.source,source_pack_fingerprint:pack.fingerprint,original_selection:selection,
 selection:{...selection,start_ms:start+shift,end_ms:end+shift,framing},duration_ms:end-start,original_captions:original,
 captions:cues.map(c=>({...c,start_ms:c.start_ms+shift,end_ms:c.end_ms+shift})),caption_corrections:corrections,
 caption_display_edits:adjusted.edits,layout,editorial_approval:'pending',human_complete_watch:false,publication_authorized:false};
 return {...plan,fingerprint:digest(plan)};
}
export function makeRecipe(pack,{id,title,start,end,layout='host_1'}){
 validatePack(pack);const framing=pack.framing_presets[layout];must(framing,'Choose host_1, host_2, or stacked; build explicit speaker cuts from a supplied example');
 return {id,title,start_ms:start,end_ms:end,status:'test_draft',editorial_approval:'pending',reason:'Proposed locally by operator; complete human review required',caption_segment_ids:pack.cues.filter(c=>c.end_ms>start&&c.start_ms<end).map(c=>c.segment_id),framing:structuredClone(framing)};
}
export function renderPortable(pack,selection,master,out){
 const plan=buildPortablePlan(pack,selection);must(!fs.existsSync(out),'Output exists; choose a new version directory');must(fs.statfsSync(path.dirname(out)).bavail*fs.statfsSync(path.dirname(out)).bsize>2*1024**3,'Need 2 GiB free');
 console.log('Checking the exact final 4K. This reads the full file.');verifySource(pack,master);const meta=probe(master),v=meta.streams.find(s=>s.codec_type==='video');must(v?.width===pack.source.width&&v.height===pack.source.height&&!(v.side_data_list||[]).some(s=>s.rotation),'Final source geometry differs');
 const filters=run('ffmpeg',['-hide_banner','-filters']);must(/\bass\s/.test(filters.stdout+filters.stderr),'FFmpeg needs libass (ass filter); use the Studio setup guide');
 fs.mkdirSync(out);const save=(n,x)=>fs.writeFileSync(path.join(out,n),JSON.stringify(x,null,2)+'\n',{flag:'wx'});save('plan.json',plan);
 let ass=socialAss({video:{shots:[{timeline_start_ms:plan.selection.start_ms}]},duration_ms:plan.duration_ms,captions:plan.captions,hook_overlay:null},plan.layout);
 if(plan.selection.framing.mode==='stacked')ass=ass.replace(',120,120,470,1',',120,120,930,1');
 fs.writeFileSync(path.join(out,'captions.ass'),ass,{flag:'wx'});
 const start=plan.selection.start_ms/1000,duration=plan.duration_ms/1000;
 const masterOut=path.join(out,'clip.mp4'),preview=path.join(out,'preview.mp4');
 console.log('Rendering draft; approved final audio remains continuous.');
 run('ffmpeg',['-v','error','-n','-ss',String(start),'-i',master,'-t',String(duration),'-filter_complex',finalFramingFilter(plan.selection.framing,plan.selection.start_ms),'-map','[v]','-map','0:a:0','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-r','30','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart',masterOut],out);
 run('ffmpeg',['-v','error','-n','-i',masterOut,'-vf','scale=540:960','-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',preview]);
 const outputs={};for(const [name,file,w,h] of [['master',masterOut,1080,1920],['preview',preview,540,960]]){const m=probe(file),v=m.streams.find(s=>s.codec_type==='video'),a=m.streams.find(s=>s.codec_type==='audio');must(v.width===w&&v.height===h&&v.codec_name==='h264'&&v.pix_fmt==='yuv420p'&&v.avg_frame_rate==='30/1'&&a.codec_name==='aac'&&Number(a.sample_rate)===48000&&a.channels===2&&Math.abs(Number(m.format.duration)-duration)<0.15,'Output metadata check failed');run('ffmpeg',['-v','error','-xerror','-i',file,'-map','0:v:0','-map','0:a:0','-f','null','-']);outputs[name]={file:path.basename(file),bytes:fs.statSync(file).size,sha256:shaFile(file),full_decode_passed:true};}
 const analysis=run('ffmpeg',['-hide_banner','-i',masterOut,'-vf','blackdetect=d=0.3:pix_th=0.10,freezedetect=n=-60dB:d=2','-af','silencedetect=n=-50dB:d=0.5,ebur128=peak=true','-f','null','-']);fs.writeFileSync(path.join(out,'signal_analysis.log'),analysis.stderr,{flag:'wx'});
 verifySource(pack,master);
 const receipt={schema:'eaol-portable-social-render-v1',created_at:new Date().toISOString(),status:'technically_verified',source_sha256:pack.source.sha256,plan_fingerprint:plan.fingerprint,outputs,caption_warnings:plan.layout.warnings,caption_corrections:plan.caption_corrections,editorial_approval:'pending',human_complete_watch:false,publication_authorized:false};save('receipt.json',receipt);console.log(JSON.stringify(receipt,null,2));return receipt;
}
async function main(){const [command,...rest]=process.argv.slice(2),args={};for(let i=0;i<rest.length;i+=2){must(rest[i]?.startsWith('--')&&rest[i+1], 'Use --name value pairs');args[rest[i].slice(2)]=rest[i+1];}must(args.pack,'Supply --pack source_pack.json');const pack=validatePack(read(path.resolve(args.pack)));
 if(command==='inspect'){console.log(JSON.stringify({source:pack.source,coordinate_system:pack.coordinate_system,program:pack.program,blocked_graphics:pack.graphics,framing_presets:pack.framing_presets},null,2));if(args.master){verifySource(pack,path.resolve(args.master));console.log('Exact source verified.')}return;}
 if(command==='cues'){const start=Number(args.start||0),end=Number(args.end||pack.program.end_ms);for(const c of pack.cues.filter(c=>c.end_ms>start&&c.start_ms<end))console.log(`${c.segment_id}\t${c.start_ms}\t${c.end_ms}\t${c.speaker_id}\t${c.text}`);return;}
 if(command==='recipe'){must(args.out&&args.start&&args.end,'Supply --out, --start and --end');const recipe=makeRecipe(pack,{id:args.id||'draft',title:args.title||'Local draft',start:Number(args.start),end:Number(args.end),layout:args.layout||'host_1'});fs.writeFileSync(path.resolve(args.out),JSON.stringify(recipe,null,2)+'\n',{flag:'wx'});console.log('Recipe created; run plan before rendering.');return;}
 must(args.selection,'Supply --selection recipe.json');const selection=read(path.resolve(args.selection));const plan=buildPortablePlan(pack,selection);
 if(command==='plan'){console.log(JSON.stringify({status:'draft_plan_valid',duration_ms:plan.duration_ms,caption_warnings:plan.layout.warnings,editorial_approval:'pending',fingerprint:plan.fingerprint},null,2));return;}
 must(command==='render'&&args.master&&args.out,'Use inspect, cues, recipe, plan or render; render needs --master and --out');renderPortable(pack,selection,path.resolve(args.master),path.resolve(args.out));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1});
