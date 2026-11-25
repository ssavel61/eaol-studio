// Local, source-bound continuation of an already reviewed multipart recovery.
// This deliberately does not manufacture normal intake or final-master approvals.
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveTool } from '../platform_tools.mjs';
import { validateRecoveryFraming } from './recovery_framing.mjs';
import { validateRecoveryColor, recoveryColorPipeline } from './recovery_color.mjs';

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const readRecoveryJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function recoveryDestination(workRoot, slug) {
  insist(/^[a-z0-9_]{1,80}$/.test(slug), 'Invalid recovery episode slug');
  const dir = join(workRoot, slug);
  if (existsSync(dir)) insist(realpathSync(dir).startsWith(realpathSync(workRoot) + sep), 'Recovery destination leaves the work folder');
  return dir;
}
export function writeRecoveryJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(temp, path);
}
function insist(condition, message) { if (!condition) throw new Error(message); }
export function inside(path, roots) {
  const real = realpathSync(path);
  insist(roots.filter(Boolean).some(root => {
    const base = realpathSync(root);
    return real.startsWith(base + sep);
  }), 'Recovery file must be inside the local work folder or configured Podcast folder');
  insist(statSync(real).isFile(), 'Recovery input must be a regular file');
  return real;
}
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function signature(path) {
  const s = statSync(path);
  return { real: realpathSync(path), bytes: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs, ino: s.ino };
}
export function validateCoverage(items, frames, label) {
  let cursor = 0;
  insist(Array.isArray(items) && items.length > 0 && items.length <= 1000, `${label}: missing or excessive ranges`);
  for (const item of items) {
    insist(Number.isInteger(item.startFrame) && Number.isInteger(item.endFrame) && item.startFrame === cursor && item.endFrame > cursor, `${label}: ranges must cover the timeline exactly, without gaps or overlap`);
    cursor = item.endFrame;
  }
  insist(cursor === frames, `${label}: incomplete timeline coverage`);
}
export function validatePackage(p) {
  insist(p.schema === 'eaol-recovery-v1', 'Unsupported recovery package');
  insist(/^[a-z0-9_]{1,80}$/.test(p.slug), 'Invalid recovery episode slug');
  insist(typeof p.title === 'string' && p.title.length > 0 && p.title.length <= 200, 'Episode title required');
  insist(p.fps === 30 && Number.isInteger(p.frames) && p.frames > 0 && p.frames <= 30 * 60 * 240, 'Recovery supports a 30 fps timeline up to four hours');
  insist(p.hosts?.host_1 && p.hosts?.host_2, 'Two host labels required');
  insist(Array.isArray(p.sources) && p.sources.length >= 2 && p.sources.length <= 100, 'Sources required');
  const ids = new Set();
  for (const s of p.sources) {
    insist(/^[a-z0-9_]+$/.test(s.id) && !ids.has(s.id), 'Source IDs must be unique'); ids.add(s.id);
    insist(['host_1_camera', 'host_2_camera', 'host_1_audio', 'host_2_audio'].includes(s.role), 'Unknown source role');
  }
  insist(Array.isArray(p.evidence) && p.evidence.length > 0 && p.evidence.length <= 40, 'Recovery evidence required');
  const evidenceIds = new Set(p.evidence.map(e => e.id));
  insist(evidenceIds.size === p.evidence.length, 'Evidence IDs must be unique');
  for (const asset of [...p.sources, ...p.evidence, p.review]) {
    insist(asset && typeof asset.path === 'string' && /^[a-f0-9]{64}$/.test(asset.sha256), 'Each input needs a path and SHA-256');
  }
  validateCoverage(p.blocks, p.frames, 'Camera blocks');
  for (const block of p.blocks) for (const host of ['host_1', 'host_2']) {
    const map = block.cameras?.[host];
    insist(map && p.sources.some(s => s.id === map.sourceId && s.role === `${host}_camera`) && Number.isFinite(map.startSec) && map.startSec >= 0, 'Camera mapping is missing or has the wrong host role');
  }
  validateShots(p.shots, p.frames);
  insist(Array.isArray(p.approvals) && p.approvals.length > 0, 'Scoped review decisions required');
  for (const a of p.approvals) {
    insist(evidenceIds.has(a.evidenceId) && typeof a.scope === 'string' && a.scope.trim() && typeof a.reviewer === 'string' && a.reviewer.trim(), 'Every decision needs evidence, reviewer and scope');
    insist(['accepted', 'feedback'].includes(a.kind) && Array.isArray(a.checks) && a.checks.length > 0, 'Every decision must check its exact evidence fields');
    insist(/^[a-f0-9]{64}$/.test(a.targetSha256) && evidenceIds.has(a.targetId), 'Decision target must be a checksum-bound evidence artifact');
  }
  insist(p.finalMasterApproved === false && p.finalVisualTreatmentApproved === false, 'Recovery import cannot grant final visual or master approval');
  return p;
}
function validateShots(shots, frames) {
  validateCoverage(shots, frames, 'Camera shots');
  insist(shots.every(s => ['two', 'host_1', 'host_2'].includes(s.view)), 'Unsupported camera view');
  insist(shots.every(s => s.matchTwoShotFraming === undefined || (typeof s.matchTwoShotFraming === 'boolean' && (!s.matchTwoShotFraming || s.view !== 'two'))), 'Invalid solo framing choice');
}
export function probe(path) {
  const result = spawnSync(resolveTool('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { encoding: 'utf8' });
  insist(result.status === 0, `Cannot probe ${path}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
export async function importRecovery(workRoot, packagePath, podcastRoot = null) {
  packagePath = inside(packagePath, [workRoot]);
  const packageSignature = signature(packagePath);
  const p = validatePackage(readRecoveryJson(packagePath));
  const dir = recoveryDestination(workRoot, p.slug);
  // The job journal may already have created the directory. Never replace normal intake.
  insist(!existsSync(join(dir, 'episode.json')) && !existsSync(join(dir, 'meta.json')), 'Episode already exists as a normal intake');
  const prior = existsSync(join(dir, 'recovery.json')) ? readRecoveryJson(join(dir, 'recovery.json')) : null;
  insist(!prior || prior.packageFingerprint === fingerprint(p), 'A different recovery already uses this episode slug');
  const dependencies = [];
  for (const asset of [...p.sources, ...p.evidence, p.review]) {
    inside(asset.path, [workRoot, podcastRoot]);
    const before = signature(asset.path);
    console.log(`Checking ${asset.id || 'review video'} (${(before.bytes / 1e9).toFixed(2)} GB)`);
    insist(await sha256(asset.path) === asset.sha256, `Checksum mismatch: ${asset.id || 'review video'}`);
    insist(fingerprint(before) === fingerprint(signature(asset.path)), 'Input changed during verification');
    dependencies.push({ path: asset.path, sha256: asset.sha256, signature: before });
  }
  for (const a of p.approvals) {
    const evidence = p.evidence.find(e => e.id === a.evidenceId);
    const target = p.evidence.find(e => e.id === a.targetId);
    insist(target.sha256 === a.targetSha256, 'Decision target checksum mismatch');
    const doc = readRecoveryJson(evidence.path);
    for (const check of a.checks) {
      insist(Array.isArray(check.path) && check.path.length && check.path.every(k => typeof k === 'string' && !['__proto__', 'constructor', 'prototype'].includes(k)), 'Invalid evidence field');
      const value = check.path.reduce((v, key) => v?.[key], doc);
      insist(JSON.stringify(value) === JSON.stringify(check.equals), `Review evidence disagrees with ${a.scope}`);
    }
    insist(JSON.stringify(doc).includes(a.targetSha256), 'Review evidence does not bind the target artifact');
  }
  for (const block of p.blocks) for (const map of Object.values(block.cameras)) {
    const source = p.sources.find(s => s.id === map.sourceId);
    const media = probe(source.path);
    const video = media.streams.find(s => s.codec_type === 'video');
    insist(video && Math.abs(video.width / video.height - 16 / 9) < .02 && !video.side_data_list?.some(s => s.rotation), 'Recovery preview currently requires unrotated 16:9 camera footage');
    insist(map.startSec + (block.endFrame - block.startFrame) / p.fps <= Number(video.duration || media.format.duration) + 1 / p.fps, 'Camera mapping exceeds source coverage');
  }
  const review = probe(p.review.path);
  insist(review.streams.some(s => s.codec_type === 'video') && review.streams.some(s => s.codec_type === 'audio') && Math.abs(Number(review.format.duration) - p.frames / p.fps) < .1, 'Review video duration or streams disagree with timeline');
  insist(fingerprint(packageSignature) === fingerprint(signature(packagePath)), 'Package changed during verification');
  insist(dependencies.every(d => fingerprint(signature(d.path)) === fingerprint(d.signature)), 'Input changed before import completed');
  dependencies.push({ path: packagePath, signature: packageSignature, sha256: await sha256(packagePath) });
  mkdirSync(dir, { recursive: true });
  writeRecoveryJson(join(dir, 'recovery.json'), { ...p, importedAt: prior?.importedAt || new Date().toISOString(), packageFingerprint: fingerprint(p), dependencies });
  console.log(`Recovery verified: ${p.title}. Final master remains unapproved.`);
  return loadRecovery(dir);
}
export function loadRecovery(dir) {
  const p = readRecoveryJson(join(dir, 'recovery.json'));
  const { importedAt, packageFingerprint, dependencies, ...original } = p;
  validatePackage(original);
  insist(fingerprint(original) === packageFingerprint, 'Imported recovery record was modified; restore its verified record');
  const staleInputs = p.dependencies.filter(d => {
    try { return fingerprint(signature(d.path)) !== fingerprint(d.signature); } catch { return true; }
  }).map(d => d.path);
  const draft = existsSync(join(dir, 'recovery_draft.json')) ? readRecoveryJson(join(dir, 'recovery_draft.json')) : { shots: p.shots, notes: '', revision: 0 };
  validateShots(draft.shots, p.frames);
  validateRecoveryFraming(draft.framing, p.sources, p.blocks);
  validateRecoveryColor(draft.color, p.sources);
  const draftFingerprint = fingerprint({ packageFingerprint: p.packageFingerprint, draft });
  const preview = existsSync(join(dir, 'recovery_preview.json')) ? readRecoveryJson(join(dir, 'recovery_preview.json')) : null;
  if (preview) {
    insist(/^recovery_previews\/[a-f0-9-]+\/preview\.mp4$/.test(preview.file), 'Invalid recovery preview path');
    if (preview.comparisonFile) insist(/^recovery_previews\/[a-f0-9-]+\/before\.mp4$/.test(preview.comparisonFile), 'Invalid comparison preview path');
    try { preview.stale = Boolean((preview.comparisonKind === 'color' && preview.colorPipeline !== recoveryColorPipeline) || staleInputs.length || preview.draftFingerprint !== draftFingerprint || fingerprint(preview.signature) !== fingerprint(signature(join(dir, preview.file))) || (preview.comparisonFile && fingerprint(preview.comparisonSignature) !== fingerprint(signature(join(dir, preview.comparisonFile))))); }
    catch { preview.stale = true; }
    if (preview.alternatePlayback) {
      const a = preview.alternatePlayback;
      insist(/^recovery_previews\/[a-f0-9-]+\/alternate_[a-f0-9-]+\.webm$/.test(a.file) && /^recovery_previews\/[a-f0-9-]+\/alternate_before_[a-f0-9-]+\.webm$/.test(a.comparisonFile), 'Invalid alternate playback path');
      try { a.stale = preview.stale || a.sourceSha256 !== preview.sha256 || a.sourceComparisonSha256 !== preview.comparisonSha256 || fingerprint(a.signature) !== fingerprint(signature(join(dir,a.file))) || fingerprint(a.comparisonSignature) !== fingerprint(signature(join(dir,a.comparisonFile))); }
      catch { a.stale = true; }
    }

  }
  return { slug: p.slug, episode_title: p.title, source_name: p.title, duration_sec: p.frames / p.fps, transcribed_at: p.importedAt, candidates: [], transcript: [], intake: { sources: p.sources }, recovery: { ...p, staleInputs, draft, draftFingerprint, preview } };
}
export function saveRecoveryShot(dir, body) {
  const { recovery: p } = loadRecovery(dir);
  insist(!p.staleInputs.length, 'Recovery inputs changed; re-verify before editing');
  insist(body.draftFingerprint === p.draftFingerprint, 'Camera draft changed; reload before editing');
  const { startFrame, endFrame, view } = body;
  insist(Number.isInteger(startFrame) && Number.isInteger(endFrame) && startFrame >= 0 && endFrame <= p.frames && endFrame > startFrame && ['two', 'host_1', 'host_2'].includes(view), 'Invalid camera range');
  insist(typeof body.reason === 'string' && body.reason.trim().length > 0 && body.reason.length <= 1000, 'A short editorial reason is required');
  insist(body.matchTwoShotFraming === undefined || typeof body.matchTwoShotFraming === 'boolean', 'Invalid solo framing choice');
  const matchTwoShotFraming = body.matchTwoShotFraming === true;
  if (matchTwoShotFraming) {
    insist(view !== 'two', 'Matched framing is only for a solo shot');
    insist(p.blocks.filter(b => b.startFrame < endFrame && b.endFrame > startFrame).every(b => p.draft.framing?.sources[b.cameras[view].sourceId]), 'Save two-shot framing before matching solo size');
  }
  const shots = p.draft.shots.flatMap(s => {
    if (s.endFrame <= startFrame || s.startFrame >= endFrame) return [s];
    return [s.startFrame < startFrame ? { ...s, endFrame: startFrame } : null,
      { startFrame: Math.max(s.startFrame, startFrame), endFrame: Math.min(s.endFrame, endFrame), view, reason: body.reason.trim(), ...(matchTwoShotFraming ? { matchTwoShotFraming: true } : {}) },
      s.endFrame > endFrame ? { ...s, startFrame: endFrame } : null].filter(Boolean);
  });
  const merged = [];
  for (const s of shots) {
    const last = merged.at(-1);
    if (last && last.view === s.view && last.reason === s.reason && Boolean(last.matchTwoShotFraming) === Boolean(s.matchTwoShotFraming)) last.endFrame = s.endFrame;
    else merged.push({ ...s });
  }
  validateShots(merged, p.frames);
  writeRecoveryJson(join(dir, 'recovery_draft.json'), { ...p.draft, shots: merged, revision: p.draft.revision + 1, notes: body.reason.trim(), savedAt: new Date().toISOString() });
  return loadRecovery(dir);
}
export function saveRecoveryFraming(dir, body) {
  const { recovery: p } = loadRecovery(dir);
  insist(!p.staleInputs.length, 'Recovery inputs changed; re-verify before editing');
  insist(body.draftFingerprint === p.draftFingerprint, 'Camera draft changed; reload before editing');
  insist(Number.isInteger(body.blockIndex) && p.blocks[body.blockIndex] && typeof body.enabled === 'boolean', 'Choose a recording part');
  const framing = structuredClone(p.draft.framing || { sources: {} });
  for (const host of ['host_1', 'host_2']) {
    const id = p.blocks[body.blockIndex].cameras[host].sourceId;
    if (body.enabled) framing.sources[id] = body[host];
    else delete framing.sources[id];
  }
  validateRecoveryFraming(framing, p.sources, p.blocks);
  writeRecoveryJson(join(dir, 'recovery_draft.json'), { ...p.draft, framing, revision: p.draft.revision + 1, notes: `Two-shot framing for recording part ${body.blockIndex + 1}; human review pending`, savedAt: new Date().toISOString() });
  return loadRecovery(dir);
}
export function saveRecoveryColor(dir, body) {
  const { recovery: p } = loadRecovery(dir);
  insist(!p.staleInputs.length, 'Recovery inputs changed; re-verify before editing');
  insist(body.draftFingerprint === p.draftFingerprint, 'Camera draft changed; reload before editing');
  insist(Number.isInteger(body.blockIndex) && p.blocks[body.blockIndex] && typeof body.enabled === 'boolean', 'Choose a recording part');
  const color = structuredClone(p.draft.color || { sources: {} });
  for (const host of ['host_1', 'host_2']) {
    const id = p.blocks[body.blockIndex].cameras[host].sourceId;
    if (body.enabled) color.sources[id] = body[host];
    else delete color.sources[id];
  }
  validateRecoveryColor(color, p.sources);
  writeRecoveryJson(join(dir, 'recovery_draft.json'), { ...p.draft, color, revision: p.draft.revision + 1, notes: `Color draft for recording part ${body.blockIndex + 1}; human review pending`, savedAt: new Date().toISOString() });
  return loadRecovery(dir);
}
export function previewSegments(p, startFrame, endFrame) {
  insist(Number.isInteger(startFrame) && Number.isInteger(endFrame) && startFrame >= 0 && endFrame <= p.frames && endFrame - startFrame >= p.fps && endFrame - startFrame <= p.fps * 60, 'Preview must be 1–60 seconds within the episode');
  return p.blocks.flatMap(block => p.draft.shots.map(shot => ({ startFrame: Math.max(startFrame, block.startFrame, shot.startFrame), endFrame: Math.min(endFrame, block.endFrame, shot.endFrame), view: shot.view, matchTwoShotFraming: shot.matchTwoShotFraming === true, block })).filter(s => s.endFrame > s.startFrame));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  importRecovery(process.argv[2], process.argv[3], process.argv[4] || null).catch(error => { console.error(error.message); process.exitCode = 1; });
}
