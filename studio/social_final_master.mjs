// Bounded local draft adapter. Does not populate approved Social Clips state.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync, statfsSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveTool } from '../platform_tools.mjs';
import { fileSha256 } from './local_files.mjs';
import { mapTranscriptToFinalTimeline, deliveryTextMatchesInputs } from './delivery_text.mjs';
import { applySpeakerTranscriptReview, speakerTranscriptReviewMatchesInputs } from './speaker_transcript_review.mjs';
import { buildCaptionLayout } from './social_captions.mjs';
import { socialAss } from './social_clip_renderer.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function requireTrue(value, message) { if (!value) throw new Error(message); }

import { validateFinalFraming, reconcileCaptionHandoffs, mergeCaptionPhrases, finalFramingFilter } from './social_final_framing.mjs';
export { validateFinalFraming, reconcileCaptionHandoffs, mergeCaptionPhrases, finalFramingFilter } from './social_final_framing.mjs';

// Keep the original assembly/selection proof, then bind the separately approved
// delivery bytes without pretending they are the original render output.
export function bindFinalDelivery(plan, { lock, review, readiness, timing, sourceSha, modifiedMs }) {
  const output = lock?.file;
  requireTrue(lock?.status === 'finalized_local' && lock.sha256_recomputed_match === true
    && output?.sha256 === sourceSha && sourceSha, 'final delivery lock mismatch');
  requireTrue(review?.status === 'approved' && review.source_picture_approval_preserved === true
    && ['new_audio_level','sync_spot_check','closing_music'].every(k => review.human_checks?.[k] === 'approved'), 'delivery listening approval required');
  requireTrue(readiness?.status === 'technically_verified' && readiness.new_audio_listening_review === 'approved_by_host_1'
    && Object.keys(readiness.checks || {}).length > 0 && Object.values(readiness.checks).every(x => x === true)
    && readiness.checks.picture_payload_identical === true, 'delivery technical verification required');
  requireTrue(review.source_sha256 === plan.source.sha256 && readiness.source_sha256 === plan.source.sha256, 'delivery original source mismatch');
  for (const candidate of [review.output, readiness.output]) {
    for (const key of ['path','bytes','sha256','duration_sec']) requireTrue(candidate?.[key] === output[key], 'delivery output mismatch');
  }
  const shift = timing?.video_pts_constant_shift_sec;
  requireTrue(timing?.status === 'pass' && Number.isFinite(shift) && Math.abs(shift) <= 0.1
    && Number.isFinite(timing.max_pts_shift_variation_sec) && timing.max_pts_shift_variation_sec <= 0.000002
    && timing.audio_comparisons?.length >= 3
    && timing.audio_comparisons.every(x => Number.isFinite(x.relative_av_change_ms) && Math.abs(x.relative_av_change_ms) <= 1
      && Number.isFinite(x.correlation) && x.correlation >= 0.99), 'delivery timeline verification required');
  const offsetMs = shift * 1000;
  const selection = { ...plan.selection, start_ms:plan.selection.start_ms + offsetMs, end_ms:plan.selection.end_ms + offsetMs };
  if (plan.selection.framing.mode === 'speaker_cuts') selection.framing = {...plan.selection.framing,
    shots:plan.selection.framing.shots.map(s => ({...s,start_ms:s.start_ms+offsetMs,end_ms:s.end_ms+offsetMs}))};
  requireTrue(selection.start_ms >= 3000 && selection.end_ms + 3000 <= output.duration_sec * 1000, 'delivery context outside media');
  const captions = plan.captions.map(c => ({ ...c, start_ms:c.start_ms + offsetMs, end_ms:c.end_ms + offsetMs }));
  const result = { ...plan, original_master:plan.source, original_selection:plan.selection, original_plan_fingerprint:plan.fingerprint,
    source:{...plan.source,...output,modified_ms:modifiedMs}, selection, captions,
    // Relative timing is invariant under the verified constant shift. Retain
    // the original quantized layout to avoid floating-point centisecond drift.
    layout:plan.layout, delivery_timeline_shift_ms:offsetMs, delivery_reviewed_at:review.reviewed_at,
    audio_policy:'retain_approved_final_delivery_mix_no_added_music_or_gain', editorial_approval:'pending' };
  return { ...result, fingerprint:hash({...result,fingerprint:undefined}) };
}

export function buildFinalMasterPlan({ render, assembly, approval, sourceSha, selection, cues }) {
  requireTrue(render?.status === 'complete' && render.quality === 'full' && render.full_render_authorized === true
    && Object.keys(render.checks || {}).length > 0 && Object.values(render.checks).every(x => x === true), 'current full render required');
  requireTrue(assembly?.plan_fingerprint === render.assembly_fingerprint, 'stale assembly');
  requireTrue(approval?.status === 'approved' && approval.local_social_test_authorized === true
    && approval.assembly_fingerprint === render.assembly_fingerprint
    && sourceSha && approval.output?.sha256 === sourceSha, 'stale or missing final approval');
  for (const key of ['path', 'bytes', 'modified_ms']) requireTrue(approval.output[key] === render.output[key], 'approval output mismatch');
  const { start_ms: start, end_ms: end, framing: crop } = selection;
  const opening = Math.round(Number(render.segments.find(x => x.type === 'opening')?.duration_sec || 0) * 1000);
  requireTrue(Number.isInteger(start) && Number.isInteger(end) && end - start >= 15000 && end - start <= 90000
    && start >= opening && end <= opening + assembly.program.duration_ms, 'invalid final program range');
  validateFinalFraming(crop,start,end,render.output.width,render.output.height);
  const shots = assembly.program.shots.filter(s => s.end_ms - assembly.program.start_ms + opening > start
    && s.start_ms - assembly.program.start_ms + opening < end);
  requireTrue(shots.length === 1, 'camera cut needs separate framing review');
  const graphics = [...(render.program_graphics?.timeline || []), ...(render.cta?.timeline || [])];
  requireTrue(graphics.every(g => Number.isFinite(g.start_sec) && Number.isFinite(g.end_sec)), 'invalid graphic timing');
  requireTrue(!graphics.some(g => g.start_sec * 1000 < end && g.end_sec * 1000 > start), 'burned graphic needs separate treatment');
  const originalCaptions = cues.filter(c => c.end_ms > start && c.start_ms < end);
  requireTrue(JSON.stringify(originalCaptions.map(c => c.segment_id)) === JSON.stringify(selection.caption_segment_ids), 'selection caption ids mismatch');
  const groupedCaptions = mergeCaptionPhrases(originalCaptions,selection.caption_phrase_groups);
  const {captions, edits:captionDisplayEdits} = reconcileCaptionHandoffs(groupedCaptions,selection.caption_display_adjustments);
  if (crop.mode === 'speaker_cuts') requireTrue(captions.every(c => crop.shots.some(s => s.speaker_id === c.speaker_id
    && c.start_ms >= s.start_ms && c.end_ms <= s.end_ms)), 'speaker crop does not match caption speaker');
  const layout = buildCaptionLayout(captions, start, end);
  const plan = { schema: 'eaol-final-master-social-draft-v1', status: 'test_draft', editorial_approval: 'pending',
    source: { ...render.output, sha256: sourceSha, assembly_fingerprint: render.assembly_fingerprint },
    final_reviewed_at: approval.reviewed_at, selection, duration_ms: end - start, captions, original_captions:originalCaptions,
    caption_display_edits:captionDisplayEdits, layout,
    audio_policy: 'retain_final_master_mix_no_added_music_or_gain', camera_policy: crop.mode,
    upload_authorized: false, publication_authorized: false };
  return { ...plan, fingerprint: hash(plan) };
}

function run(tool, args, cwd) {
  const result = spawnSync(resolveTool(tool), args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${tool} failed: ${result.error?.message || result.stderr}`);
  return result;
}
function probe(path) {
  return JSON.parse(run('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',path]).stdout);
}
function verifyMedia(path, width, height, duration) {
  const metadata = probe(path), video = metadata.streams.find(s => s.codec_type === 'video'), audio = metadata.streams.find(s => s.codec_type === 'audio');
  requireTrue(video?.width === width && video.height === height && video.codec_name === 'h264' && video.pix_fmt === 'yuv420p'
    && video.avg_frame_rate === '30/1' && audio?.codec_name === 'aac' && Number(audio.sample_rate) === 48000 && audio.channels === 2
    && Math.abs(Number(metadata.format.duration) - duration) < 0.15, 'output media verification failed');
  run('ffmpeg', ['-v','error','-xerror','-i',path,'-map','0:v:0','-map','0:a:0','-f','null','-']);
  return { path, bytes: statSync(path).size, sha256: fileSha256(path), metadata, full_decode_passed: true };
}

export function renderFinalMasterDraft(workDir, selectionPath, outputDir, finalDeliveryDir) {
  const dir = resolve(workDir), destination = resolve(outputDir);
  requireTrue(!existsSync(destination), 'choose a new draft directory; existing output is preserved');
  requireTrue(destination.startsWith(dir + '/'), 'draft output must remain inside this local episode');
  const disk = statfsSync(dir);
  requireTrue(disk.bavail * disk.bsize >= 2 * 1024 ** 3, 'at least 2 GiB of local draft headroom required');
  const render = read(join(dir,'episode_render.json')), assembly = read(join(dir,'episode_assembly.json'));
  const approval = read(join(dir,'episode_full_review.json')), transcript = read(join(dir,'speaker_transcript.json'));
  const review = read(join(dir,'speaker_transcript_review.json')), delivery = read(join(dir,'delivery_text.json'));
  const manifest = read(join(dir,'episode.json')), timeline = read(join(dir,'timeline.json'));
  const sourceStat = statSync(render.output.path);
  requireTrue(sourceStat.size === render.output.bytes && Math.round(sourceStat.mtimeMs) === render.output.modified_ms, 'master changed');
  requireTrue(review.status === 'approved' && speakerTranscriptReviewMatchesInputs(review, transcript, manifest, timeline), 'stale transcript review');
  requireTrue(deliveryTextMatchesInputs(delivery, render, transcript, review), 'stale delivery text');
  requireTrue(Object.values(delivery.files).every(f => fileSha256(f.path) === f.sha256), 'delivery text content changed');
  const metadata = probe(render.output.path), video = metadata.streams.find(s => s.codec_type === 'video');
  requireTrue(video.width === render.output.width && video.height === render.output.height
    && !(video.side_data_list || []).some(x => x.rotation), 'source dimensions or rotation changed');
  let plan = buildFinalMasterPlan({ render, assembly, approval, sourceSha: fileSha256(render.output.path), selection: read(selectionPath),
    cues: mapTranscriptToFinalTimeline(applySpeakerTranscriptReview(transcript, review), assembly, render) });
  plan.input_hashes = Object.fromEntries(['episode_render','episode_assembly','episode_full_review','speaker_transcript','speaker_transcript_review','delivery_text']
    .map(n => [n, fileSha256(join(dir,`${n}.json`))]));
  if (finalDeliveryDir) {
    const deliveryDir = resolve(finalDeliveryDir);
    requireTrue(deliveryDir.startsWith(dir + '/'), 'delivery input must remain inside this local episode');
    const lock = read(join(deliveryDir,'FINAL_4K_LOCK.json'));
    requireTrue(resolve(lock.file.path).startsWith(deliveryDir + '/'), 'delivery file outside locked directory');
    const st = statSync(lock.file.path);
    requireTrue(st.size === lock.file.bytes, 'delivery file size changed');
    const deliveryMetadata = probe(lock.file.path), v = deliveryMetadata.streams.find(s => s.codec_type === 'video');
    requireTrue(v?.width === render.output.width && v.height === render.output.height
      && !(v.side_data_list || []).some(x => x.rotation), 'delivery source dimensions or rotation changed');
    plan = bindFinalDelivery(plan, {lock, review:read(join(deliveryDir,'upload_review.json')),
      readiness:read(join(deliveryDir,'upload_readiness.json')), timing:read(join(deliveryDir,'timing_verification.json')),
      sourceSha:fileSha256(lock.file.path), modifiedMs:Math.round(st.mtimeMs)});
    plan.delivery_input_hashes = Object.fromEntries(['FINAL_4K_LOCK','upload_review','upload_readiness','timing_verification']
      .map(n => [join(deliveryDir,`${n}.json`),fileSha256(join(deliveryDir,`${n}.json`))]));
  }
  plan.fingerprint = hash({ ...plan, fingerprint: undefined });
  mkdirSync(destination, { recursive: true });
  save(join(destination,'plan.json'), plan);
  const start = plan.selection.start_ms / 1000, duration = plan.duration_ms / 1000, c = plan.selection.framing;
  let subtitles = socialAss({ video: { shots: [{ timeline_start_ms: plan.selection.start_ms }] },
    duration_ms: plan.duration_ms, captions: plan.captions, hook_overlay: null }, plan.layout);
  if (c.mode === 'stacked') subtitles = subtitles.replace(',120,120,470,1',',120,120,930,1');
  writeFileSync(join(destination,'captions.ass'), subtitles, { flag: 'wx' });
  console.log('Verified exact approved master; rendering portrait draft.');
  const master = join(destination,'clip_001.mp4'), preview = join(destination,'clip_001_preview.mp4'), context = join(destination,'context.mp4');
  const encode = ['-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-r','30','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart'];
  run('ffmpeg', ['-v','error','-n','-ss',String(start),'-i',plan.source.path,'-t',String(duration),'-filter_complex',finalFramingFilter(c,plan.selection.start_ms),
    '-map','[v]','-map','0:a:0',...encode,master], destination);
  console.log('Portrait rendered; creating browser and context previews.');
  run('ffmpeg', ['-v','error','-n','-i',master,'-vf','scale=540:960','-c:v','libx264','-profile:v','baseline','-level','3.1','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',preview]);
  run('ffmpeg', ['-v','error','-n','-ss',String(start - 3),'-i',plan.source.path,'-t',String(duration + 6),'-map','0:v:0','-map','0:a:0',
    '-vf','scale=960:540,setsar=1',...encode,context]);
  const outputs = { master: verifyMedia(master,1080,1920,duration), preview: verifyMedia(preview,540,960,duration), context: verifyMedia(context,960,540,duration + 6) };
  const analysis = run('ffmpeg', ['-hide_banner','-i',master,'-vf','blackdetect=d=0.3:pix_th=0.10,freezedetect=n=-60dB:d=2',
    '-af','silencedetect=n=-50dB:d=0.5,ebur128=peak=true','-f','null','-']);
  writeFileSync(join(destination,'signal_analysis.log'), analysis.stderr, { flag:'wx' });
  requireTrue(fileSha256(plan.source.path) === plan.source.sha256, 'master changed during draft rendering');
  requireTrue(Object.entries(plan.input_hashes).every(([n,h]) => fileSha256(join(dir,`${n}.json`)) === h), 'inputs changed during render');
  requireTrue(Object.entries(plan.delivery_input_hashes || {}).every(([p,h]) => fileSha256(p) === h), 'delivery inputs changed during render');
  const receipt = { schema: 'eaol-final-master-social-test-v1', generated_at: new Date().toISOString(), status:'technically_verified',
    plan_fingerprint: plan.fingerprint, source_sha256: plan.source.sha256, outputs,
    checks: { source_unchanged:true, inputs_unchanged:true, captions_lossless:plan.layout.checks.complete_caption_text, decode_all_outputs:true },
    preview_of_sha256:outputs.master.sha256, context_range_ms:[plan.selection.start_ms - 3000,plan.selection.end_ms + 3000],
    caption_warnings:plan.layout.warnings, editorial_approval:'pending', upload_authorized:false, publication_authorized:false };
  save(join(destination,'receipt.json'), receipt);
  console.log(JSON.stringify({ status:receipt.status, master, preview, caption_warnings:receipt.caption_warnings }));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  renderFinalMasterDraft(...process.argv.slice(2));
}
