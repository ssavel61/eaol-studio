import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveTool } from '../platform_tools.mjs';
import { loadRecovery, previewSegments, probe, sha256, signature, writeRecoveryJson } from './recovery.mjs';
import { recoveryPanelFilter, recoverySoloFilter } from './recovery_framing.mjs';
import { recoveryColorFilter, recoveryColorPipeline } from './recovery_color.mjs';

function run(args) {
  const r = spawnSync(resolveTool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr || 'Recovery preview render failed');
}
export async function renderRecoveryPreview(dir, startFrame, endFrame, expectedFingerprint) {
  const { recovery: p } = loadRecovery(dir);
  if (p.staleInputs.length || expectedFingerprint !== p.draftFingerprint) throw new Error('Recovery inputs or camera draft changed; reload first');
  const segments = previewSegments(p, startFrame, endFrame);
  // Verify the original cameras used by this short preview and its accepted audio.
  const usedIds = new Set(segments.flatMap(s => s.view === 'two' ? Object.values(s.block.cameras).map(c => c.sourceId) : [s.block.cameras[s.view].sourceId]));
  for (const input of [...p.sources.filter(s => usedIds.has(s.id)), p.review]) {
    console.log(`Verifying render input: ${input.id || 'accepted review audio'}`);
    if (await sha256(input.path) !== input.sha256) throw new Error('Preview source checksum changed');
  }
  const folder = `recovery_previews/${randomUUID()}`;
  const out = join(dir, folder);
  mkdirSync(out, { recursive: true });
  const compareColor = [...usedIds].some(id => recoveryColorFilter(p.draft.color?.sources[id]));
  async function renderPictureParts(applyColor, prefix) {
    const parts = [];
    for (const [i, segment] of segments.entries()) {
      const frames = segment.endFrame - segment.startFrame;
      const hosts = segment.view === 'two' ? ['host_1', 'host_2'] : [segment.view];
      const framed = hosts.length === 2 && hosts.every(host => p.draft.framing?.sources[segment.block.cameras[host].sourceId]);
      const args = [], filters = [];
      for (const [n, host] of hosts.entries()) {
        const camera = segment.block.cameras[host];
        const source = p.sources.find(s => s.id === camera.sourceId);
        const seek = camera.startSec + (segment.startFrame - segment.block.startFrame) / p.fps;
        args.push('-ss', String(seek), '-i', source.path);
        const size = hosts.length === 2 ? '640:360' : '1280:720';
        const picture = framed ? recoveryPanelFilter(p.draft.framing.sources[camera.sourceId]) : segment.matchTwoShotFraming ? recoverySoloFilter(p.draft.framing?.sources[camera.sourceId]) : `scale=${size}:in_range=auto:out_range=tv`;
        filters.push(`[${n}:v:0]fps=30,${picture}${applyColor ? recoveryColorFilter(p.draft.color?.sources[camera.sourceId]) : ''},setsar=1,format=yuv420p,trim=end_frame=${frames},setpts=PTS-STARTPTS[v${n}]`);
      }
      filters.push(hosts.length === 2 ? `[v0][v1]hstack=inputs=2${framed ? '' : ',pad=1280:720:0:180:black'}[v]` : '[v0]null[v]');
      const file = join(out, `${prefix}_${i}.mp4`); parts.push(file);
      console.log(`Rendering ${segment.view}: ${(segment.startFrame / 30).toFixed(2)}–${(segment.endFrame / 30).toFixed(2)}`);
      run([...args, '-filter_complex_threads', '1', '-filter_complex', filters.join(';'), '-map', '[v]', '-an', '-frames:v', String(frames), '-c:v', 'libx264', '-threads', '4', '-preset', 'veryfast', '-crf', '20', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', file]);
      const metadata = probe(file);
      if (Number(metadata.streams[0].nb_frames) !== frames) throw new Error('Camera preview frame coverage failed');
    }
    return parts;
  }
  const parts = await renderPictureParts(true, 'part');
  const args = parts.flatMap(file => ['-i', file]);
  args.push('-ss', String(startFrame / 30), '-i', p.review.path);
  const filter = parts.map((_, i) => `[${i}:v:0]`).join('') + `concat=n=${parts.length}:v=1:a=0[v]`;
  const file = join(out, 'preview.mp4');
  run([...args, '-filter_complex_threads', '1', '-filter_complex', filter, '-map', '[v]', '-map', `${parts.length}:a:0`, '-t', String((endFrame - startFrame) / 30), '-c:v', 'libx264', '-threads', '4', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', file]);
  run(['-i', file, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  const metadata = probe(file);
  if (Number(metadata.streams.find(s => s.codec_type === 'video')?.nb_frames) !== endFrame - startFrame || Math.abs(Number(metadata.format.duration) - (endFrame - startFrame) / 30) > .1) throw new Error('Preview duration/frame validation failed');
  // Same time window and exact same encoded audio as the draft, for a fair visual comparison.
  const before = join(out, 'before.mp4');
  if (compareColor) {
    const neutralParts = await renderPictureParts(false, 'ungraded');
    const neutralArgs = neutralParts.flatMap(part => ['-i', part]);
    const neutralFilter = neutralParts.map((_, i) => `[${i}:v:0]`).join('') + `concat=n=${neutralParts.length}:v=1:a=0[v]`;
    run([...neutralArgs, '-i', file, '-filter_complex_threads', '1', '-filter_complex', neutralFilter, '-map', '[v]', '-map', `${neutralParts.length}:a:0`, '-t', String((endFrame - startFrame) / 30), '-c:v', 'libx264', '-threads', '4', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', before]);
  } else {
    run(['-ss', String(startFrame / 30), '-i', p.review.path, '-i', file, '-map', '0:v:0', '-map', '1:a:0', '-t', String((endFrame - startFrame) / 30), '-vf', 'fps=30,scale=1280:720,setsar=1', '-c:v', 'libx264', '-threads', '4', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', before]);
  }
  run(['-i', before, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  if (Number(probe(before).streams.find(s => s.codec_type === 'video')?.nb_frames) !== endFrame - startFrame) throw new Error('Comparison frame validation failed');
  const current = loadRecovery(dir).recovery;
  if (current.staleInputs.length || current.draftFingerprint !== expectedFingerprint) throw new Error('Inputs changed while rendering; output is not current');
  const receipt = { file: `${folder}/preview.mp4`, sha256: await sha256(file), signature: signature(file), comparisonFile: `${folder}/before.mp4`, comparisonSha256: await sha256(before), comparisonSignature: signature(before), framing: p.draft.framing || null, color: p.draft.color || null, comparisonKind: compareColor ? 'color' : 'framing', colorPipeline: recoveryColorPipeline, draftFingerprint: expectedFingerprint, startFrame, endFrame, createdAt: new Date().toISOString(), acceptedAudioSha256: p.review.sha256, audioTreatment: 'Accepted review mix, excerpt only; AAC re-encoded for preview, copied byte-for-byte to comparison', humanApproved: false, metadata };
  writeRecoveryJson(join(dir, 'recovery_preview.json'), receipt);
  console.log('Camera preview ready. Human review is still required; accepted continuity video is unchanged.');
  return receipt;
}
export async function prepareRecoveryPlayback(dir, expectedSha) {
  const { recovery: p } = loadRecovery(dir);
  const preview = p.preview;
  if (!preview || preview.stale || preview.sha256 !== expectedSha) throw new Error('Render a current preview before repairing playback');
  for (const [fileKey, hashKey] of [['file', 'sha256'], ['comparisonFile', 'comparisonSha256']]) {
    if (!preview[fileKey] || await sha256(join(dir, preview[fileKey])) !== preview[hashKey]) throw new Error('Preview bytes changed');
  }
  const folder = preview.file.slice(0, preview.file.lastIndexOf('/'));
  const id = randomUUID();
  const after = `${folder}/alternate_${id}.webm`, before = `${folder}/alternate_before_${id}.webm`;
  const videoArgs = ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-threads', '4', '-crf', '18', '-b:v', '0', '-pix_fmt', 'yuv420p'];
  console.log('Preparing alternate browser playback from the exact review files');
  run(['-i', join(dir, preview.file), '-map', '0:v:0', '-map', '0:a:0', ...videoArgs, '-c:a', 'libopus', '-b:a', '160k', join(dir, after)]);
  run(['-i', join(dir, preview.comparisonFile), '-i', join(dir, after), '-map', '0:v:0', '-map', '1:a:0', ...videoArgs, '-c:a', 'copy', join(dir, before)]);
  const alternatePlayback = { file: after, comparisonFile: before, sourceSha256: preview.sha256, sourceComparisonSha256: preview.comparisonSha256, format: 'VP9/Opus', createdAt: new Date().toISOString() };
  for (const [key, hashKey, signatureKey] of [['file', 'sha256', 'signature'], ['comparisonFile', 'comparisonSha256', 'comparisonSignature']]) {
    const path = join(dir, alternatePlayback[key]);
    run(['-i', path, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    const metadata = probe(path);
    if (metadata.streams.find(s => s.codec_type === 'video')?.codec_name !== 'vp9' || Math.abs(Number(metadata.format.duration) - (preview.endFrame - preview.startFrame) / 30) > .1) throw new Error('Alternate playback validation failed');
    alternatePlayback[hashKey] = await sha256(path);
    alternatePlayback[signatureKey] = signature(path);
  }
  const current = loadRecovery(dir).recovery.preview;
  if (!current || current.stale || current.sha256 !== expectedSha) throw new Error('Preview changed while preparing playback');
  const { stale, ...receipt } = current;
  writeRecoveryJson(join(dir, 'recovery_preview.json'), { ...receipt, alternatePlayback });
  console.log('Alternate playback ready. This is a review copy, not a new editorial approval.');
  return alternatePlayback;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const task = process.argv[3] === '--alternate-playback'
    ? prepareRecoveryPlayback(process.argv[2], process.argv[4])
    : renderRecoveryPreview(process.argv[2], Number(process.argv[3]), Number(process.argv[4]), process.argv[5]);
  task.catch(error => { console.error(error.message); process.exitCode = 1; });
}
