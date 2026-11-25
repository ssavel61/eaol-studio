// Shared release-copy contract for the Studio UI and its downloads.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fingerprint} from './recovery.mjs';
import {loadReleaseWorkspace} from './release_workspace.mjs';
import {buildReleaseCopy, episodeNumber} from './release_policy.mjs';
import {parseChapterLines, validateChapters} from './delivery_text.mjs';

export function releaseBrief(state) {
  if(!state.copy) throw Error('Save a release-copy draft first');
  if(state.copy_stale) throw Error('The copy source or generator changed; review and save the draft again');
  return {schema:'eaol-release-brief-v1',episode_number:Number(state.input.episode_number),
    source_sha256:state.source?.sha256 || null,source_key:state.source?.key || null,
    copy_fingerprint:fingerprint(state.copy),copy:state.copy,chapters:state.input.chapters || '',
    state:'draft_review_required',publication_authorized:false,upload_authorized:false};
}
export function releaseBriefMarkdown(brief) {
  const c=brief.copy;
  return `# Episode ${brief.episode_number} release brief — DRAFT\n\n`+
    `Human copy review and platform actions remain separate. This brief contains text only; video/audio/transcript files are not embedded.\n\n`+
    `Copy fingerprint: ${brief.copy_fingerprint}\nSource master SHA-256: ${brief.source_sha256 || 'Not recorded; verify the completed master'}\n\n`+
    `## Remaining checks\n${c.pending.map(x=>'- '+x).join('\n')}\n\n`+
    `## YouTube title\n${c.titles.youtube}\n\n## YouTube description\n${c.youtube_description}\n\n`+
    `## Podcast feed title\n${c.titles.podcast_rss}\n\n## Show-notes HTML (${c.spotify_characters}/4,000)\n${c.spotify_html}\n\n`+
    `## Pinned comment\n${c.pinned_comment || '[Draft required]'}\n\nPost and pin from the show's channel account after publication.\n\n`+
    `## End screen — last 20 seconds\n- Subscribe element\n- Specific full episode: ${c.end_screen.video_url || '[Choose previous or next episode]'}\n- Podcast playlist: ${c.end_screen.playlist_url || '[Add playlist URL]'}\n${c.end_screen.verify}\n\n`+
    `## Posting checks\nUse a privately reviewed upload, the full-episode podcast playlist, English language settings and the separately approved schedule. Check podcast-platform processing and RSS propagation. Record the live result; this brief grants no publication approval.\n`;
}

export function deliveryCopyFromWorkspace(dir,render,assembly,legacy,text) {
  const number=episodeNumber(assembly) || episodeNumber({slug:render?.source_slug});
  if(!existsSync(join(dir,'release_workspace.json'))) {
    return legacy;
  }
  if(!render || assembly?.plan_fingerprint!==render.assembly_fingerprint) throw Error('Release copy requires the current assembled final master');
  const state=loadReleaseWorkspace(dir,{slug:render?.source_slug,episode_render:render,episode_assembly:assembly});
  if(!state.source || !state.copy || state.copy_stale) throw Error('Release copy must match the current final master; review and save it again');
  const canonical=buildReleaseCopy(state.input);
  if(fingerprint(canonical)!==fingerprint(state.copy)) throw Error('Release copy changed outside its editor; review and save it again');
  if(canonical.missing.length) throw Error('Complete Release copy: '+canonical.missing.join('; '));
  const chapters=validateChapters(parseChapterLines(state.input.chapters.split(/\r?\n/)),state.source.duration_ms,Number(state.input.episode_number));
  const comparable=items=>(items || []).map(({start_ms,title})=>({start_ms,title}));
  if(JSON.stringify(comparable(chapters))!==JSON.stringify(comparable(text?.chapters))) throw Error('Release chapters differ from the final transcript/chapter package; reconcile them before delivery');
  return {schema:'eaol-episode-platform-copy-v1',source_slug:render.source_slug,
    assembly_fingerprint:render.assembly_fingerprint,episode_number:Number(state.input.episode_number),
    titles:canonical.titles,youtube:{description_lines:canonical.youtube_description.split('\n'),pinned_comment:canonical.pinned_comment,end_screen:canonical.end_screen},
    spotify:{show_notes_html:canonical.spotify_html},release_brief:releaseBrief(state),
    copy_review_required:true,publication_authorized:false};
}
