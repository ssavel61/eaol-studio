// Local review of a recovered program sign-off with a continuous closing music lead.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveTool } from '../platform_tools.mjs';
import { loadRecovery, readRecoveryJson, writeRecoveryJson, fingerprint, signature, sha256, probe } from './recovery.mjs';
import { renderRecoveryPreview } from './recovery_render.mjs';
const HERE=dirname(fileURLToPath(import.meta.url));
const implementation=()=>fingerprint(['closing_transition.mjs','recovery_render.mjs','recovery_framing.mjs','recovery_color.mjs'].map(f=>readFileSync(join(HERE,f),'utf8')));
export function closingInputs(dir) {
 const p=loadRecovery(dir).recovery;
 if(p.staleInputs.length)throw new Error('Recovery inputs changed; re-verify first');
 if(p.frames<600)throw new Error('Closing review requires at least twenty seconds of program');
 return {p,key:fingerprint({draft:p.draftFingerprint,implementation:implementation()})};
}
export function loadClosingTransition(dir) {
 let inputs,error;try{inputs=closingInputs(dir);}catch(e){error=e.message;}
 const receipt=existsSync(join(dir,'closing_transition.json'))?readRecoveryJson(join(dir,'closing_transition.json')):null;
 let current=false;
 try{current=Boolean(inputs&&receipt&&receipt.inputsKey===inputs.key&&fingerprint(signature(receipt.source.path))===fingerprint(receipt.source.signature)&&fingerprint(signature(receipt.output.path))===fingerprint(receipt.output.signature));}catch{}
 return {ready:Boolean(inputs),error:error||null,inputsKey:inputs?.key||null,receipt:receipt?{...receipt,stale:!current}:null};
}
export function validateClosingSettings(body,metadata) {
 const video=metadata.streams.find(s=>s.codec_type==='video'),audio=metadata.streams.find(s=>s.codec_type==='audio'),duration=Number(video?.duration||metadata.format.duration);
 if(!video||!audio||!Number.isFinite(duration)||duration<2||duration>60||Math.abs(video.width/video.height-16/9)>.02||(video.side_data_list||[]).some(s=>Number(s.rotation||0)!==0))throw new Error('Closing must be an unrotated 16:9 video with audio, 2–60 seconds');
 if(!Number.isFinite(body.leadSec)||body.leadSec<0||body.leadSec>15||duration-body.leadSec<1)throw new Error('Music lead must be 0–15 seconds and leave at least one second of closing picture');
 if(!Number.isFinite(body.gainDb)||body.gainDb>0||body.gainDb< -24)throw new Error('Closing gain must be -24–0 dB');
 const trim=body.trimProgramEndSec??0;
 if(!Number.isFinite(trim)||trim<0||trim>5)throw new Error('Program tail trim must be 0–5 seconds');
 const trimProgramEndFrames=Math.round(trim*30);
 return {leadSec:Math.round(body.leadSec*30)/30,gainDb:body.gainDb,trimProgramEndFrames,trimProgramEndSec:trimProgramEndFrames/30,programContextSec:(600-trimProgramEndFrames)/30,closingFrames:Math.floor(duration*30)};
}
function run(args) {
 const r=spawnSync(resolveTool('ffmpeg'),['-hide_banner','-nostdin',...args],{encoding:'utf8',maxBuffer:8*1024*1024});
 if(r.status!==0)throw new Error(r.stderr||'Closing render failed');return r;
}
export function composeClosingTransition({programPath,closingPath,folder,settings}) {
 const {leadSec,gainDb,programContextSec:context,closingFrames}=settings;
 const offset=context-leadSec,closingSec=closingFrames/30,frames=Math.round(context*30)+closingFrames-Math.round(leadSec*30),duration=frames/30;
 const norm='aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo';
 const dialogue=join(folder,'dialogue.wav'),music=join(folder,'closing_music.wav'),mix=join(folder,'transition_mix.wav');
 run(['-v','error','-i',programPath,'-map','0:a:0','-af',`${norm},atrim=end_sample=${Math.round(context*48000)},asetpts=N/SR/TB`,'-c:a','pcm_f32le',dialogue]);
 const ramp=leadSec?`,volume='if(lt(t,${leadSec}),0.22+0.78*t/${leadSec},1)':eval=frame`:'';
 run(['-v','error','-i',closingPath,'-map','0:a:0','-af',`${norm},atrim=end_sample=${Math.round(closingSec*48000)},asetpts=N/SR/TB,apad=whole_len=${Math.round(closingSec*48000)},atrim=end_sample=${Math.round(closingSec*48000)}${ramp},volume=${gainDb}dB,adelay=${Math.round(offset*48000)}S:all=1`,'-c:a','pcm_f32le',music]);
 run(['-v','error','-i',dialogue,'-i',music,'-filter_complex','[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[a]','-map','[a]','-c:a','pcm_f32le',mix]);
 const output=join(folder,'preview.mp4');
 run(['-v','error','-i',programPath,'-i',closingPath,'-i',mix,'-filter_complex_threads','1','-filter_complex',`[0:v]fps=30,scale=1280:720,setsar=1,trim=end_frame=${Math.round(context*30)},setpts=PTS-STARTPTS[vp];[1:v]fps=30,scale=1280:720,setsar=1,trim=start_frame=${Math.round(leadSec*30)}:end_frame=${closingFrames},setpts=PTS-STARTPTS[vc];[vp][vc]concat=n=2:v=1:a=0[v]`,'-map','[v]','-map','2:a','-t',String(duration),'-c:v','libx264','-threads','4','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',output]);
 const metadata=probe(output),video=metadata.streams.find(s=>s.codec_type==='video');
 if(Number(video.nb_frames)!==frames||Math.abs(Number(metadata.format.duration)-duration)>.05)throw new Error('Closing frame/duration check failed');
 run(['-v','error','-i',output,'-f','null','-']);
 const pcmHash=(file,filter)=>run(['-v','error','-i',file,'-map','0:a:0','-af',filter,'-c:a','pcm_f32le','-f','hash','-hash','sha256','-']).stdout.trim();
 if(pcmHash(programPath,`${norm},atrim=end_sample=${Math.round(context*48000)},asetpts=N/SR/TB`)!==pcmHash(dialogue,'anull'))throw new Error('Retained dialogue stem changed');
 // Before music begins, the mixed signal must remain exactly the dialogue.
 const before=`atrim=end_sample=${Math.round(offset*48000)},asetpts=N/SR/TB`;
 if(pcmHash(dialogue,before)!==pcmHash(mix,before))throw new Error('Dialogue changed before music entry');
 const report=run(['-i',output,'-af','ebur128=peak=true','-f','null','-']).stderr;
 const peaks=[...report.matchAll(/Peak:\s*([-\d.]+)\s*dBFS/g)],peak=Number(peaks.at(-1)?.[1]);
 if(!Number.isFinite(peak)||peak> -1)throw new Error(`Closing preview true peak ${peak} dBTP exceeds -1 dBTP; lower music gain and review`);
 return {output,metadata,checks:{fullDecode:true,frames,durationSec:duration,dialogueStemUnchanged:true,beforeMusicPcmUnchanged:true,truePeakDbtp:peak},musicStartsSec:offset,closingPictureStartsSec:context};
}
export async function renderClosingTransition(dir,body) {
 const inputs=closingInputs(dir);if(inputs.key!==body.inputsKey)throw new Error('Closing inputs changed; reload first');
 const source={path:body.sourcePath,signature:signature(body.sourcePath),sha256:await sha256(body.sourcePath)};
 const settings=validateClosingSettings(body,probe(source.path));
 const folder=join(dir,'closing_transitions',randomUUID());mkdirSync(folder,{recursive:true});
 console.log('Rendering final twenty seconds of current camera draft and accepted dialogue');
 const program=await renderRecoveryPreview(dir,inputs.p.frames-600,inputs.p.frames-settings.trimProgramEndFrames,inputs.p.draftFingerprint);
 const result=composeClosingTransition({programPath:join(dir,program.file),closingPath:source.path,folder,settings});
 if(closingInputs(dir).key!==inputs.key||fingerprint(signature(source.path))!==fingerprint(source.signature))throw new Error('Closing inputs changed during render');
 const receipt={schema:'eaol-closing-transition-v1',createdAt:new Date().toISOString(),inputsKey:inputs.key,draftFingerprint:inputs.p.draftFingerprint,source,settings,programPreview:program,musicStartsSec:result.musicStartsSec,closingPictureStartsSec:result.closingPictureStartsSec,output:{path:result.output,sha256:await sha256(result.output),signature:signature(result.output)},checks:result.checks,humanApproved:false,finalMasterApproved:false};
 writeRecoveryJson(join(folder,'receipt.json'),receipt);writeRecoveryJson(join(dir,'closing_transition.json'),receipt);
 console.log(`Closing music lead ready for review: ${result.output}`);return receipt;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)renderClosingTransition(resolve(process.argv[2]),JSON.parse(process.argv[3])).catch(e=>{console.error(e.message);process.exitCode=1;});
