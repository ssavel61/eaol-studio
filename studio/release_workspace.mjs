import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { inside, signature, fingerprint, writeRecoveryJson } from './recovery.mjs';
import { buildReleaseCopy, episodeNumber, RELEASE_POLICY, RELEASE_COPY_VERSION } from './release_policy.mjs';
import { parseChapterLines, validateChapters } from './delivery_text.mjs';

export function localDestination(dir,...parts) {
  const target=resolve(dir,...parts), rel=relative(resolve(dir),target);
  if(!rel || rel==='..' || rel.startsWith('..'+sep) || isAbsolute(rel)) throw Error('Invalid local destination');
  let cursor=resolve(dir);
  for(const part of rel.split(sep)) { cursor=join(cursor,part); try { if(lstatSync(cursor).isSymbolicLink()) throw Error('Symlink output refused'); } catch(e) { if(e.code!=='ENOENT') throw e; } }
  return target;
}

export function releaseSource(dir, episode, files = {}) {
  // A caller may supply the receipt of a finished file made outside the normal
  // pipeline through files.final; the normal path uses the episode render.
  const receipt = episode.recovery ? files.final?.receipt : episode.episode_render;
  if (!receipt || receipt.stale || !receipt.output?.path) return null;
  try {
    inside(receipt.output.path,[dir]);
    const sig=signature(receipt.output.path), recorded=receipt.output.signature;
    if (recorded ? fingerprint(sig)!==fingerprint(recorded) : sig.bytes!==receipt.output.bytes || Math.round(sig.mtime)!==receipt.output.modified_ms) return null;
    return { path:receipt.output.path, signature:sig, sha256:receipt.output.sha256 || null,
      duration_ms:Math.round(Number(receipt.output.duration_sec || receipt.checks?.durationSec || receipt.duration_sec || 0)*1000), key:fingerprint({path:receipt.output.path,sig,sha256:receipt.output.sha256}) };
  } catch { return null; }
}
function read(dir,name) {
  const p=join(dir,name); if(!existsSync(p)) return null;
  inside(p,[dir]); return JSON.parse(readFileSync(p,'utf8'));
}
export function loadReleaseWorkspace(dir,episode,files={}) {
  const source=releaseSource(dir,episode,files), saved=read(dir,'release_workspace.json');
  const number=episodeNumber(episode);
  return { schema:'eaol-release-workspace-v1', policy:RELEASE_POLICY, source,
    input:saved?.input || {episode_number:number || '',title:episode.episode_assembly?.title || '',summary:'',youtube_url:'',article_urls:'',chapters:'',pinned_comment:'',end_screen_video_url:'',end_screen_playlist_url:''},
    copy:saved?.copy || null, copy_stale:Boolean(saved && (saved.source_key!==(source?.key || null) || saved.copy?.generator_version!==RELEASE_COPY_VERSION)),
    revision:fingerprint({saved,sourceKey:source?.key || null}), publication_authorized:false };
}
export function saveReleaseWorkspace(dir,episode,files,body) {
  const state=loadReleaseWorkspace(dir,episode,files);
  if(body.revision!==state.revision) throw Error('Release inputs changed; reload before saving');
  const input=Object.fromEntries(['episode_number','title','summary','youtube_url','article_urls','chapters','pinned_comment','end_screen_video_url','end_screen_playlist_url'].map(k=>[k,String(body.input?.[k] || '').trim()]));
  if(Object.values(input).some(v=>v.length>12000)) throw Error('Release input is too long');
  const known=episodeNumber(episode);
  if(known && Number(input.episode_number)!==known) throw Error('Episode number differs from this workspace');
  const copy=buildReleaseCopy(input);
  if(input.chapters) {
    const duration=state.source?.duration_ms || 0;
    // A source-less copy draft can exist, but cannot claim chapter timing validation.
    if(duration>0) validateChapters(parseChapterLines(input.chapters.split(/\r?\n/)),duration,Number(input.episode_number));
    else copy.pending.push('Verify chapter timing against the completed export');
  }
  const p=localDestination(dir,'release_workspace.json');
  writeRecoveryJson(p,{schema:state.schema,input,copy,source_key:state.source?.key || null,saved_at:new Date().toISOString()});
  return loadReleaseWorkspace(dir,episode,files);
}
