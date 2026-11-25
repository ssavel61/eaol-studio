// Real FFmpeg worker integration on generated test media only.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {resolveTool} from '../platform_tools.mjs';
import {signature, fingerprint} from './recovery.mjs';
import {shaFile} from './social_portable.mjs';
import {loadReleaseWorkspace} from './release_workspace.mjs';
import {loadSocialWorkspace, saveSocialWorkspace, socialJobArgs, socialPreviewPath} from './social_workspace.mjs';
const dir=mkdtempSync(join(tmpdir(),'studio media test ')),root=resolve('.');
function run(bin,args) {const result=spawnSync(bin,args,{encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);}
try {
  const file=join(dir,'synthetic.mp4');
  run(resolveTool('ffmpeg'),['-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','16','-c:v','libx264','-preset','ultrafast','-crf','28','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-c:a','aac','-b:a','320k','-ac','2',file]);
  const before=shaFile(file),sig=signature(file),episode={slug:'ep003_synthetic',recovery:{}},files={final:{receipt:{output:{path:file,sha256:before,signature:sig},checks:{durationSec:16}}}};
  const release=loadReleaseWorkspace(dir,episode,files);
  assert.ok(release.source,'a finished-file receipt supplies the release source');
  const body={schema:'eaol-portable-social-source-v1',source:{sha256:before,bytes:sig.bytes,width:1920,height:1080},timeline_shift_ms:0,program:{start_ms:0,end_ms:16000},shots:[{start_ms:0,end_ms:16000}],graphics:[],framing_presets:{host_1:{mode:'crop',x:0,y:0,width:540,height:960}},cues:[{segment_id:'a',start_ms:0,end_ms:7500,speaker_id:'host_1',text:'First synthetic test phrase.'},{segment_id:'b',start_ms:7500,end_ms:15000,speaker_id:'host_1',text:'Second synthetic test phrase.'}]};
  const pack={...body,fingerprint:fingerprint(body)};
  let state=loadSocialWorkspace(dir,release.source);state=saveSocialWorkspace(dir,release.source,{revision:state.revision,pack});
  state=saveSocialWorkspace(dir,release.source,{revision:state.revision,title:'A synthetic test',start_ms:0,end_ms:15000,layout:'host_1'});
  const id=state.drafts[0].id;
  run(process.execPath,socialJobArgs(root,dir,state,{revision:state.revision,id,confirmLocalRender:true}));
  state=loadSocialWorkspace(dir,release.source);assert.equal(state.drafts[0].render.status,'technically_verified');
  assert.ok(socialPreviewPath(dir,state,id).endsWith('preview.mp4'));
  const receipt=JSON.parse(readFileSync(join(dir,'social_workspace',id,'receipt.json'),'utf8'));
  assert.equal(receipt.human_complete_watch,false);assert.equal(receipt.publication_authorized,false);assert.equal(shaFile(file),before);
  assert.throws(()=>socialJobArgs(root,dir,state,{revision:state.revision,id,confirmLocalRender:true}),/already has/);
  console.log('PASS social worker renders a playable checked draft, preserves source and refuses output overwrite');
} finally {rmSync(dir,{recursive:true,force:true});}
