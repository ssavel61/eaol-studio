// Reusable local opening asset: clean base + explicit episode number, no episode approval.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Resvg } from '@resvg/resvg-js';
import { resolveTool } from '../platform_tools.mjs';
import { inside, signature, fingerprint, sha256, probe, writeRecoveryJson } from './recovery.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const FONT = join(HERE, '../fonts/Inter-Regular.ttf');
const read = file => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const implementation = () => fingerprint([readFileSync(fileURLToPath(import.meta.url), 'utf8'), readFileSync(FONT).toString('base64')]);
const sameFile = asset => { try { return fingerprint(signature(asset.path)) === fingerprint(asset.signature); } catch { return false; } };
export function openingLabel(number) {
  if (!Number.isInteger(number) || number < 1 || number > 9999) throw new Error('Episode number must be a whole number from 1 to 9999');
  return `Episode ${String(number).padStart(2, '0')}`;
}
export function validateOpeningInput(body, duration) {
  openingLabel(body.episodeNumber);
  if (body.cleanBaseConfirmed !== true) throw new Error('Confirm the opening has no existing episode number');
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120) throw new Error('Opening must be at most two minutes');
  const { startSec, endSec } = body;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec - startSec < .5 || endSec > duration) throw new Error('Label window must fit inside the opening and last at least half a second');
}
export function loadNumberedOpening(dir) {
  const recipe = read(join(dir, 'numbered_opening.json'));
  const defaults = read(join(dirname(dir), 'numbered_opening_defaults.json'));
  const render = read(join(dir, 'numbered_opening_render.json'));
  const current = Boolean(recipe && recipe.implementation === implementation() && sameFile(recipe.source));
  const outputCurrent = Boolean(current && render?.recipeFingerprint === recipe.fingerprint && sameFile(render.output) && sameFile(render.preview));
  return { recipe, defaults, current, render: render ? { ...render, stale: !outputCurrent } : null };
}
export async function saveNumberedOpening(dir, body, roots) {
  const prior = loadNumberedOpening(dir).recipe;
  if ((body.expectedFingerprint || null) !== (prior?.fingerprint || null)) throw new Error('Opening draft changed; reload before saving');
  const path = inside(body.sourcePath, roots);
  const before = signature(path), metadata = probe(path);
  validateOpeningInput(body, Number(metadata.format.duration));
  const video = metadata.streams.find(s => s.codec_type === 'video');
  if (!video || video.width / video.height !== 16 / 9 || video.width > 3840 || video.height > 2160 || video.width < 640 || Number(video.tags?.rotate || 0) || video.side_data_list?.some(s => s.rotation)) throw new Error('Choose an unrotated 16:9 opening, 640 pixels wide through 4K');
  if (!metadata.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac')) throw new Error('Opening needs embedded AAC audio; review the combined clean base first');
  const sourceHash = await sha256(path);
  if (fingerprint(before) !== fingerprint(signature(path))) throw new Error('Opening changed while saving');
  const recipe = { schema: 'eaol-numbered-opening-v1', episodeNumber: body.episodeNumber, label: openingLabel(body.episodeNumber),
    source: { path, sha256: sourceHash, signature: before }, startSec: body.startSec, endSec: body.endSec,
    cleanBaseConfirmed: true, style: { referenceWidth: 1280, referenceHeight: 720, centerX: 640, baselineY: 667, fontSize: 42, font: 'Inter', color: '#8abfc5', fadeSec: .2 },
    implementation: implementation(), sourceMetadata: metadata, humanApproved: false, finalMasterApproved: false };
  recipe.fingerprint = fingerprint(recipe);
  writeRecoveryJson(join(dir, 'numbered_opening.json'), recipe);
  if (body.saveAsDefault === true) writeRecoveryJson(join(dirname(dir), 'numbered_opening_defaults.json'), { sourcePath: path, startSec: body.startSec, endSec: body.endSec, style: recipe.style, note: 'Clean base and timing only; enter each episode number explicitly. Recheck source on save.' });
  return loadNumberedOpening(dir);
}
function run(args) {
  const result = spawnSync(resolveTool('ffmpeg'), ['-hide_banner', '-v', 'error', '-nostdin', ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || 'Opening render failed');
  return result.stdout;
}
export async function renderNumberedOpening(dir, expectedFingerprint) {
  const state = loadNumberedOpening(dir), p = state.recipe;
  if (!state.current || p.fingerprint !== expectedFingerprint) throw new Error('Opening input or recipe changed; save a current draft first');
  if (await sha256(p.source.path) !== p.source.sha256) throw new Error('Opening source checksum changed');
  const video = p.sourceMetadata.streams.find(s => s.codec_type === 'video');
  const folder = join(dir, 'numbered_openings', randomUUID()); mkdirSync(folder, { recursive: true });
  const badge = join(folder, 'episode-label.png');
  const {centerX, baselineY, fontSize, color, fadeSec} = p.style;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${video.width}" height="${video.height}" viewBox="0 0 1280 720"><text x="${centerX+1}" y="${baselineY+2}" text-anchor="middle" font-family="Inter" font-size="${fontSize}" fill="#000" opacity=".5">${p.label}</text><text x="${centerX}" y="${baselineY}" text-anchor="middle" font-family="Inter" font-size="${fontSize}" fill="${color}">${p.label}</text></svg>`;
  writeFileSync(badge, new Resvg(svg, { font: { fontFiles: [FONT], loadSystemFonts: false } }).render().asPng());
  const outputPath = join(folder, `${p.label.replace(' ', '_')}_opening.mp4`);
  console.log(`Rendering ${p.label} opening at ${video.width}×${video.height}; original audio packets preserved`);
  run(['-i', p.source.path, '-loop', '1', '-framerate', video.avg_frame_rate, '-i', badge, '-filter_complex_threads', '1', '-filter_complex', `[1:v]format=rgba,fade=t=in:st=${p.startSec}:d=${fadeSec}:alpha=1,fade=t=out:st=${p.endSec-fadeSec}:d=${fadeSec}:alpha=1[badge];[0:v][badge]overlay=shortest=1:format=auto,format=yuv420p[v]`, '-map', '[v]', '-map', '0:a:0', '-c:v', 'libx264', '-threads', '4', '-preset', 'veryfast', '-crf', '18', '-c:a', 'copy', '-movflags', '+faststart', outputPath]);
  const outputMetadata = probe(outputPath), outVideo = outputMetadata.streams.find(s => s.codec_type === 'video');
  if (outVideo.width !== video.width || outVideo.height !== video.height || outVideo.nb_frames !== video.nb_frames || Math.abs(Number(outputMetadata.format.duration)-Number(p.sourceMetadata.format.duration)) > .08) throw new Error('Opening dimensions, frame count or duration changed');
  run(['-i', outputPath, '-f', 'null', '-']);
  const audioHash = file => run(['-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).trim();
  const sourceAudioHash = audioHash(p.source.path);
  if (audioHash(outputPath) !== sourceAudioHash) throw new Error('Opening audio packets changed');
  const previewPath = join(folder, 'preview.mp4');
  run(['-i', outputPath, '-vf', 'scale=1280:720', '-c:v', 'libx264', '-threads', '4', '-preset', 'veryfast', '-crf', '20', '-c:a', 'copy', '-movflags', '+faststart', previewPath]);
  const fresh = loadNumberedOpening(dir);
  if (!fresh.current || fresh.recipe.fingerprint !== expectedFingerprint) throw new Error('Opening inputs changed during render');
  const receipt = { schema: 'eaol-numbered-opening-render-v1', createdAt: new Date().toISOString(), recipeFingerprint: p.fingerprint, recipe: p,
    output: { path: outputPath, sha256: await sha256(outputPath), signature: signature(outputPath) }, preview: { path: previewPath, sha256: await sha256(previewPath), signature: signature(previewPath) },
    checks: { fullDecode: true, dimensions: true, frameCount: true, duration: true, originalAudioPackets: true }, audioPacketHash: sourceAudioHash, humanApproved: false, finalMasterApproved: false };
  writeRecoveryJson(join(folder, 'receipt.json'), receipt); writeRecoveryJson(join(dir, 'numbered_opening_render.json'), receipt);
  console.log(`Numbered opening ready for review: ${outputPath}`);
  return receipt;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) renderNumberedOpening(resolve(process.argv[2]), process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
