const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function renderReleaseWorkspace(root,episode,{api,toast,pollJob,drafts}) {
  const url=`/api/episodes/${encodeURIComponent(episode.slug)}/release-workspace`;
  root.innerHTML='<p role="status">Checking the release files…</p>';
  try {
    let state=await api(url); if(!root.isConnected)return;
    const render=()=>{
      const input=drafts.get('__release') || state.input;
      root.innerHTML=`<section class="release-files"><h3>Final file</h3>
        <div class="release-file-row"><strong>Video</strong><span>${state.source?'Current final master':'Finish and review the full export first'}</span>${state.source?`<a target="_blank" rel="noopener" href="/api/episodes/${episode.slug}/episode-media?quality=full">Watch final video</a>`:''}</div>
      </section>
      <details class="release-copy-editor" open><summary><strong>Title, show notes and chapters</strong></summary>
        <p>Save a local draft to generate separate video-platform and podcast-feed copy from the links in show.config.json. Title approval, uploading and scheduling remain separate.</p>
        ${state.copy_stale?'<p role="alert">The final source or copy generator changed. Review and save this draft again before exporting.</p>':''}
        <form id="release-copy-form">
          <label>Episode number<input name="episode_number" type="number" min="1" max="9999" required value="${esc(input.episode_number)}"></label>
          <label>Topic-first title<input name="title" maxlength="180" required value="${esc(input.title)}"></label>
          <label>Approved story or draft show notes<textarea name="summary" rows="5" maxlength="3500" required>${esc(input.summary)}</textarea></label>
          <label>This episode’s YouTube watch URL<input name="youtube_url" type="url" value="${esc(input.youtube_url)}" placeholder="Add after the private YouTube upload"></label>
          <label>Discussed article links, one per line<textarea name="article_urls" rows="3">${esc(input.article_urls)}</textarea></label>
          <label>Chapters, one timestamp and title per line<textarea name="chapters" rows="4" placeholder="00:00 First segment: topic&#10;MM:SS Second segment: topic&#10;MM:SS Third segment: topic">${esc(input.chapters)}</textarea></label>
          <p class="panel-hint">Add at least three chapters; the first starts at 00:00. Titles over 45 characters get a display warning. Recurring-segment rules come from show.config.json.</p>
          <details class="release-engagement" ${input.pinned_comment || input.end_screen_video_url?'open':''}><summary>Pinned comment and end screen</summary>
            <label>Specific question to pin as the show<textarea name="pinned_comment" maxlength="1000" rows="3" placeholder="What question should listeners respond to?">${esc(input.pinned_comment)}</textarea></label>
            <label>Previous or next full episode for the end screen<input name="end_screen_video_url" type="url" value="${esc(input.end_screen_video_url)}" placeholder="https://youtu.be/…"></label>
            <label>Podcast playlist URL<input name="end_screen_playlist_url" type="url" value="${esc(input.end_screen_playlist_url)}" placeholder="https://www.youtube.com/playlist?list=…"></label>
            <p class="panel-hint">Last 20 seconds: Subscribe, the chosen full episode and the podcast playlist. Confirm the actual destinations and room on the outro.</p>
          </details>
          <button type="submit">Save draft and check copy</button><button type="button" id="release-discard">Discard copy edits</button>
        </form>
        ${state.copy?`<div class="release-export-bar"><strong>${state.copy_stale?'Review and resave':state.copy.missing?.length?'Draft has missing fields':'Draft complete · human review next'}</strong>${!state.copy_stale?`<a href="${url}/brief">Download release brief</a><a href="${url}/brief-json">Release brief as JSON</a>`:''}</div><p role="status">${esc(state.copy.pending.join(' · '))}</p><label>YouTube title<input readonly value="${esc(state.copy.titles.youtube)}"></label><label>YouTube description<textarea readonly rows="7">${esc(state.copy.youtube_description)}</textarea></label><label>Podcast feed title<input readonly value="${esc(state.copy.titles.podcast_rss)}"></label><label>Show-notes HTML · ${state.copy.spotify_characters}/4,000 characters<textarea readonly rows="7">${esc(state.copy.spotify_html)}</textarea></label><label>Pinned comment<textarea readonly rows="3">${esc(state.copy.pinned_comment)}</textarea></label>`:''}
      </details>
`;
      const form=root.querySelector('#release-copy-form');
      const markUnsaved=()=>{
        if(!drafts.get('__release'))return;
        const bar=root.querySelector('.release-export-bar');
        if(bar)bar.innerHTML='<strong>Unsaved edits · save before downloading the current brief</strong>';
      };
      form.oninput=()=>{drafts.set('__release',Object.fromEntries(new FormData(form)));markUnsaved();};
      markUnsaved();
      root.querySelector('#release-discard').onclick=()=>{drafts.discard('__release');render();};
      form.onsubmit=async event=>{
        event.preventDefault();const submitted=Object.fromEntries(new FormData(form));drafts.set('__release',submitted);event.submitter.disabled=true;
        try { state=await api(url,{method:'PUT',body:JSON.stringify({revision:state.revision,input:submitted})});drafts.saved('__release',submitted);if(root.isConnected)render();toast('Local copy draft saved. Publication is separate.'); }
        catch(error){toast(error.message,'error');event.submitter.disabled=false;}
      };
    };render();
  }catch(error){if(root.isConnected)root.innerHTML=`<p role="alert">${esc(error.message)}</p>`;}
}
