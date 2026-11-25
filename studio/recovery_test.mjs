import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { resolveTool } from '../platform_tools.mjs';
import { importRecovery, loadRecovery, saveRecoveryShot, saveRecoveryFraming, saveRecoveryColor, sha256, validatePackage, writeRecoveryJson, previewSegments } from './recovery.mjs';
import { renderRecoveryPreview, prepareRecoveryPlayback } from './recovery_render.mjs';
import { recoveryPanelFilter, recoverySoloFilter } from './recovery_framing.mjs';
import { recoveryColorFilter } from './recovery_color.mjs';
import { createStudioServer } from './server.mjs';

const work = mkdtempSync(join(tmpdir(), 'eaol-recovery-test-'));
let server;
function ff(args) {
  const r = spawnSync(resolveTool('ffmpeg'), ['-v', 'error', ...args], { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr.toString()); return r.stdout;
}
try {
  // A blue wall gradient touching the blue-channel ceiling reproduced bright gray
  // speckles with lightness preservation. The corrected filter must stay smooth.
  const wall = Buffer.alloc(256 * 16 * 3);
  for (let y=0;y<16;y++) for (let x=0;x<256;x++) {
    const at=(y*256+x)*3; wall[at]=202; wall[at+1]=222; wall[at+2]=245+Math.floor(x*10/255);
  }
  const wallPath=join(work,'blue-wall.rgb'); writeFileSync(wallPath,wall);
  const wallPixels=ff(['-f','rawvideo','-pix_fmt','rgb24','-s','256x16','-i',wallPath,'-vf','format=gbrp'+recoveryColorFilter({warmth:10,tint:-3,saturation:1}),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-']);
  let maximumStep=0;
  for(let x=1;x<256;x++) for(let c=0;c<3;c++) maximumStep=Math.max(maximumStep,Math.abs(wallPixels[x*3+c]-wallPixels[(x-1)*3+c]));
  assert(maximumStep <= 6, `Color must not create highlight speckles; adjacent step was ${maximumStep}`);
  assert(wallPixels[255*3+2]-wallPixels[255*3]>25,'Blue highlights must retain their color, not collapse to gray');
  // A matched solo must preserve the panel's center pixels (subject size/headroom).
  const matchValues = {zoom:1.35,horizontal:12,vertical:-25};
  const pattern=join(work,'framing-pattern.png');
  ff(['-f','lavfi','-i','testsrc2=size=1920x1080:rate=1','-frames:v','1',pattern]);
  const panel=ff(['-i',pattern,'-vf',recoveryPanelFilter(matchValues),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-']);
  const soloCenter=ff(['-i',pattern,'-vf',recoverySoloFilter(matchValues)+',crop=640:720:320:0','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-']);
  assert.deepEqual(soloCenter,panel,'Solo must match the two-shot subject scale and vertical crop');
  assert.throws(()=>recoverySoloFilter(undefined),/Save two-shot framing/);
  for(const horizontal of [-100,100]) ff(['-i',pattern,'-vf',recoverySoloFilter({...matchValues,horizontal}),'-frames:v','1','-f','null','-']);
  const assets = join(work, 'inputs'); mkdirSync(assets);
  for (const [name, color] of [['one', 'red'], ['two', 'blue'], ['review', 'green']]) {
    ff(['-f', 'lavfi', '-i', `color=${color}:s=640x360:r=30:d=3`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(assets, `${name}.mp4`)]);
  }
  const asset = async (id, file) => ({ id, path: join(assets, file), sha256: await sha256(join(assets, file)) });
  const review = await asset('review_video', 'review.mp4');
  writeRecoveryJson(join(assets, 'accepted.json'), { approved: true, scope: 'continuity only', sha256: review.sha256, finalMasterApproved: false });
  const evidence = await asset('acceptance', 'accepted.json');
  const pack = { schema: 'eaol-recovery-v1', slug: 'demo', title: 'Recovery fixture', fps: 30, frames: 90, hosts: { host_1: 'Host A', host_2: 'Host B' },
    sources: [{ ...await asset('camera_a', 'one.mp4'), role: 'host_1_camera', part: 1 }, { ...await asset('camera_b', 'two.mp4'), role: 'host_2_camera', part: 1 }],
    review, evidence: [evidence, review], blocks: [{ startFrame: 0, endFrame: 45, cameras: { host_1: { sourceId: 'camera_a', startSec: 0 }, host_2: { sourceId: 'camera_b', startSec: 0 } } }, { startFrame: 45, endFrame: 90, cameras: { host_1: { sourceId: 'camera_a', startSec: 1.5 }, host_2: { sourceId: 'camera_b', startSec: 1.5 } } }],
    shots: [{ startFrame: 0, endFrame: 90, view: 'two' }],
    approvals: [{ evidenceId: 'acceptance', targetId: 'review_video', targetSha256: review.sha256, scope: 'Continuity only', reviewer: 'Test reviewer', kind: 'accepted', checks: [{ path: ['approved'], equals: true }] }], finalMasterApproved: false, finalVisualTreatmentApproved: false };
  const path = join(assets, 'recovery-package.json'); writeRecoveryJson(path, pack);
  for (const mutate of [p => p.slug = '../escape', p => p.blocks[0].endFrame = 44, p => p.shots[0].view = 'unknown', p => p.finalMasterApproved = true, p => p.approvals[0].targetId = 'absent']) {
    const p = structuredClone(pack); mutate(p); assert.throws(() => validatePackage(p));
  }
  const original = JSON.stringify(pack);
  let bad = structuredClone(pack); bad.sources[0].sha256 = '0'.repeat(64); writeRecoveryJson(path, bad);
  await assert.rejects(importRecovery(work, path), /Checksum mismatch/);
  bad = structuredClone(pack); bad.approvals[0].checks[0].equals = false; writeRecoveryJson(path, bad);
  await assert.rejects(importRecovery(work, path), /Review evidence disagrees/);
  const external = mkdtempSync(join(tmpdir(), 'eaol-recovery-external-'));
  try {
    writeFileSync(join(external, 'outside.json'), original); symlinkSync(join(external, 'outside.json'), join(assets, 'linked.json'));
    await assert.rejects(importRecovery(work, join(assets, 'linked.json')), /inside the local work/);
    symlinkSync(external, join(work, 'escaped')); bad = structuredClone(pack); bad.slug = 'escaped'; writeRecoveryJson(path, bad);
    await assert.rejects(importRecovery(work, path), /destination leaves/);
  } finally { rmSync(external, { recursive: true, force: true }); }
  writeRecoveryJson(path, pack);
  let episode = await importRecovery(work, path); const dir = join(work, 'demo');
  assert.equal(episode.recovery.finalMasterApproved, false);
  const acceptedBefore = readFileSync(join(dir, 'recovery.json'), 'utf8');
  episode = saveRecoveryShot(dir, { startFrame: 0, endFrame: 45, view: 'host_1', reason: 'Long answer from A', draftFingerprint: episode.recovery.draftFingerprint });
  const oldFingerprint = episode.recovery.draftFingerprint;
  episode = saveRecoveryShot(dir, { startFrame: 45, endFrame: 90, view: 'host_2', reason: 'Answer from B', draftFingerprint: oldFingerprint });
  const reimported = await importRecovery(work, path);
  assert.equal(reimported.recovery.draftFingerprint, episode.recovery.draftFingerprint, 'Re-import must preserve the existing draft');
  bad = structuredClone(pack); bad.title = 'Different recovery'; writeRecoveryJson(path, bad);
  await assert.rejects(importRecovery(work, path), /different recovery/);
  writeRecoveryJson(path, pack);
  episode = await importRecovery(work, path);
  assert.throws(() => saveRecoveryShot(dir, { startFrame: 0, endFrame: 10, view: 'two', reason: 'stale', draftFingerprint: oldFingerprint }), /draft changed/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'recovery.json'), 'utf8')).approvals, JSON.parse(acceptedBefore).approvals);
  assert.equal(previewSegments(episode.recovery, 0, 90).length, 2);
  assert.throws(() => previewSegments(episode.recovery, -1, 30), /within the episode/);
  const receipt = await renderRecoveryPreview(dir, 0, 90, episode.recovery.draftFingerprint);
  for (const [second, channel] of [[.4, 0], [2, 2]]) {
    const pixel = ff(['-ss', String(second), '-i', join(dir, receipt.file), '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    assert(pixel[channel] > 150 && pixel[(channel + 1) % 3] < 80, 'Preview must switch to the requested original camera');
  }
  assert.equal(loadRecovery(dir).recovery.preview.stale, false);
  episode = loadRecovery(dir);
  saveRecoveryShot(dir, { startFrame: 0, endFrame: 30, view: 'two', reason: 'Return to conversation', draftFingerprint: episode.recovery.draftFingerprint });
  assert.equal(loadRecovery(dir).recovery.preview.stale, true);
  episode = loadRecovery(dir);
  const originalShots = structuredClone(episode.recovery.draft.shots);
  const framingBody = { blockIndex: 0, enabled: true, host_1: { zoom: 1.35, horizontal: 12, vertical: -25 }, host_2: { zoom: 1.12, horizontal: 20, vertical: 100 }, draftFingerprint: episode.recovery.draftFingerprint };
  assert.throws(() => saveRecoveryFraming(dir, { ...framingBody, host_1: { ...framingBody.host_1, zoom: 2 } }), /outside the framing range/);
  episode = saveRecoveryFraming(dir, framingBody);
  assert.deepEqual(episode.recovery.draft.shots, originalShots, 'Framing must not alter shot timing');
  episode = saveRecoveryShot(dir, { startFrame: 0, endFrame: 90, view: 'two', reason: 'Test full-height two-shot', draftFingerprint: episode.recovery.draftFingerprint });
  assert.deepEqual(episode.recovery.draft.framing.sources.camera_a, framingBody.host_1, 'Shot edits must retain framing');
  const framed = await renderRecoveryPreview(dir, 0, 90, episode.recovery.draftFingerprint);
  const top = ff(['-i', join(dir, framed.file), '-vf', 'crop=8:8:100:20,scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert(top[0] > 150 && top[1] < 80, 'Framed two-shot must show original camera picture in the former letterbox');
  assert.deepEqual(ff(['-i', join(dir, framed.file), '-map', '0:a:0', '-c', 'copy', '-f', 'adts', '-']), ff(['-i', join(dir, framed.comparisonFile), '-map', '0:a:0', '-c', 'copy', '-f', 'adts', '-']), 'Before/after must use identical encoded audio');
  const soloReason='Matched solo fixture';
  assert.throws(()=>saveRecoveryShot(dir,{startFrame:30,endFrame:60,view:'two',reason:soloReason,matchTwoShotFraming:true,draftFingerprint:episode.recovery.draftFingerprint}),/only for a solo/);
  episode=saveRecoveryShot(dir,{startFrame:30,endFrame:60,view:'host_1',reason:soloReason,matchTwoShotFraming:true,draftFingerprint:episode.recovery.draftFingerprint});
  assert.deepEqual(episode.recovery.draft.shots.map(s=>[s.startFrame,s.endFrame,s.view,Boolean(s.matchTwoShotFraming)]),[[0,30,'two',false],[30,60,'host_1',true],[60,90,'two',false]],'Matching must be scoped to the selected range');
  assert(previewSegments(episode.recovery,0,90).filter(s=>s.view==='host_1').every(s=>s.matchTwoShotFraming),'Matching must survive recording-block splits');
  const matchedSolo=await renderRecoveryPreview(dir,0,90,episode.recovery.draftFingerprint);
  assert.equal(matchedSolo.metadata.streams.find(s=>s.codec_type==='video').nb_frames,'90');
  assert.deepEqual(ff(['-i',join(dir,matchedSolo.file),'-map','0:a:0','-c','copy','-f','adts','-']),ff(['-i',join(dir,framed.file),'-map','0:a:0','-c','copy','-f','adts','-']),'Solo framing must preserve audio');
  episode=saveRecoveryShot(dir,{startFrame:60,endFrame:90,view:'host_1',reason:soloReason,draftFingerprint:episode.recovery.draftFingerprint});
  assert.equal(episode.recovery.draft.shots.length,3,'Adjacent matched and wide solos must not merge');
  episode=saveRecoveryShot(dir,{startFrame:0,endFrame:90,view:'two',reason:'Restore fixture',draftFingerprint:episode.recovery.draftFingerprint});
  const beforeColor = structuredClone(episode.recovery.draft);
  const colorBody = { blockIndex: 0, enabled: true, host_1: { warmth: -15, tint: -10, saturation: .8 }, host_2: { warmth: 0, tint: 0, saturation: 1 }, draftFingerprint: episode.recovery.draftFingerprint };
  assert.throws(() => saveRecoveryColor(dir, { ...colorBody, host_1: {...colorBody.host_1, warmth: 21} }), /outside the color range/);
  assert.throws(() => saveRecoveryColor(dir, { ...colorBody, host_1: {...colorBody.host_1, tint: NaN} }), /outside the color range/);
  episode = saveRecoveryColor(dir, colorBody);
  assert.deepEqual(episode.recovery.draft.shots, beforeColor.shots, 'Color must preserve approved camera timing');
  assert.deepEqual(episode.recovery.draft.framing, beforeColor.framing, 'Color must preserve accepted framing');
  assert.equal(episode.recovery.preview.stale, true, 'Color changes must expire prior previews');
  assert.throws(() => saveRecoveryColor(dir, colorBody), /draft changed/);
  episode = saveRecoveryShot(dir, { startFrame:45, endFrame:90, view:'host_1', reason:'Verify consistent color in solo', draftFingerprint:episode.recovery.draftFingerprint });
  assert.deepEqual(episode.recovery.draft.color.sources.camera_a, colorBody.host_1, 'Camera edits must preserve color');
  const colored = await renderRecoveryPreview(dir, 0, 90, episode.recovery.draftFingerprint);
  assert.equal(colored.comparisonKind, 'color');
  writeRecoveryJson(join(dir, 'recovery_preview.json'), { ...colored, colorPipeline: 'retired-lightness-filter' });
  assert.equal(loadRecovery(dir).recovery.preview.stale, true, 'Retired color treatment must require a new preview');
  writeRecoveryJson(join(dir, 'recovery_preview.json'), colored);
  assert.equal(loadRecovery(dir).recovery.preview.stale, false);
  for (const second of [.4, 2]) {
    const pixel = file => ff(['-ss', String(second), '-i', join(dir,file), '-vf', 'crop=8:8:100:20,scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const original = pixel(colored.comparisonFile), corrected = pixel(colored.file);
    assert(original[0] > 150 && original[1] < 80, 'Color Before must retain current crop and camera, not the green continuity fixture');
    assert([...original].some((v,i) => Math.abs(v-corrected[i]) > 8), 'Color must visibly affect both two-shot and solo');
  }
  assert.deepEqual(ff(['-i', join(dir, colored.file), '-map', '0:a:0', '-c', 'copy', '-f', 'adts', '-']), ff(['-i', join(dir, colored.comparisonFile), '-map', '0:a:0', '-c', 'copy', '-f', 'adts', '-']), 'Color comparison must preserve identical encoded audio');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'recovery.json'), 'utf8')).approvals, JSON.parse(acceptedBefore).approvals, 'Color cannot manufacture or edit approvals');
  await assert.rejects(prepareRecoveryPlayback(dir, '0'.repeat(64)), /current preview/);
  const alternative = await prepareRecoveryPlayback(dir, colored.sha256);
  assert.equal(loadRecovery(dir).recovery.preview.alternatePlayback.stale, false);
  const alternatePixel=ff(['-ss','2','-i',join(dir,alternative.file),'-vf','scale=1:1','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-']);
  assert(alternatePixel[0]>100, 'Alternate playback must contain the expected picture');
  assert.deepEqual(ff(['-i',join(dir,alternative.file),'-map','0:a:0','-f','s16le','-']),ff(['-i',join(dir,alternative.comparisonFile),'-map','0:a:0','-f','s16le','-']), 'Alternate Before/After must have identical decoded audio');
  server = createStudioServer({ root: resolve('.'), workRoot: work }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = await (await fetch(`${base}/api/episodes`)).json(); assert.equal(list.episodes[0].workflow_status, 'Recovered episode · visual finishing');
  const media = await fetch(`${base}/api/episodes/demo/recovery/media`, { headers: { range: 'bytes=0-31' } }); assert.equal(media.status, 206); assert.equal((await media.arrayBuffer()).byteLength, 32);
  assert.equal((await fetch(`${base}/api/episodes/demo/recovery/comparison-media`, { headers: {range:'bytes=0-31'} })).status, 206);
  const alternateResponse = await fetch(`${base}/api/episodes/demo/recovery/alternate-media`, { headers:{range:'bytes=0-31'} });
  assert.equal(alternateResponse.status,206);
  assert.equal(alternateResponse.headers.get('content-type'),'video/webm');
  assert.equal((await alternateResponse.arrayBuffer()).byteLength,32);
  writeFileSync(join(dir,alternative.file),Buffer.from('changed playback bytes'));
  assert.equal(loadRecovery(dir).recovery.preview.alternatePlayback.stale,true);
  assert.equal((await fetch(`${base}/api/episodes/demo/recovery/alternate-media`)).status,409);
  const colorResponse = await fetch(`${base}/api/episodes/demo/recovery/color`, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({...colorBody, enabled:false, draftFingerprint:episode.recovery.draftFingerprint}) });
  assert.equal(colorResponse.status, 200);
  episode = loadRecovery(dir);
  assert.deepEqual(episode.recovery.draft.color.sources, {}, 'Disabling color restores the neutral source mapping');
  const editResponse = await fetch(`${base}/api/episodes/demo/recovery/framing`, { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ ...framingBody, enabled:false, draftFingerprint: episode.recovery.draftFingerprint }) });
  assert.equal(editResponse.status, 200);
  assert.equal((await fetch(`${base}/api/episodes/demo/recovery/preview-media`)).status, 409);
  assert.equal((await fetch(`${base}/api/episodes/demo/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 409);
  writeFileSync(pack.sources[0].path, Buffer.from('changed'));
  assert.equal(loadRecovery(dir).recovery.staleInputs.length, 1);
  assert.equal((await fetch(`${base}/api/episodes/demo/recovery/media`)).status, 409);
  await assert.rejects(renderRecoveryPreview(dir, 0, 90, episode.recovery.draftFingerprint), /inputs or camera draft changed/);
  console.log('PASS: scoped import, evidence/hash/path/coverage rejection, original-camera render, bounded framing, full-height picture, identical comparison audio, draft and source invalidation, media and pipeline guards');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(work, { recursive: true, force: true });
}
