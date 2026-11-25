const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function renderSocialWorkspace(root,episode,{api,toast,pollJob,drafts}) {
  const url=`/api/episodes/${encodeURIComponent(episode.slug)}/social-workspace`;
  root.innerHTML='<p role="status">Checking the finished-video clip workspace…</p>';
  try {
    let state=await api(url);if(!root.isConnected)return;
    const render=()=>{
      const input=drafts.get('__social') || {};
      root.innerHTML=`<section class="release-copy-editor"><h3>Test clips from the finished video</h3>
        <p>${state.source?'Current final master found.':'Finish and review the full export first.'} These are local test drafts; watch each complete clip before choosing it.</p>
        <p class="panel-hint">A prepared source_pack.json supplies exact transcript cues, safe framing and graphic exclusions. An AI coding agent or a person prepares that pack. The editor cannot automatically resolve cuts or burned-in graphics. After reviewing a base draft, use Finish ending below. The ending is either an on-screen text cue or a real recorded line. Finished versions still need a complete human watch.</p>
        <details><summary>Finish the ending from the command line or Studio</summary><p>Keep the base clip. Either add the episode cue as on-screen text over the last seconds, or select a complete 3–5 second recorded line and prepare its source hash, time range and crop. Each finished version has a new master, preview and six-part review sheet.</p><p>The command line equivalent is <code>node studio/social_finishing.mjs plan --draft DIRECTORY --recipe ending.json</code>, then <code>render</code> with a fresh <code>--out DIRECTORY</code>. Nothing uploads or publishes.</p></details>
        ${state.stale?'<p role="alert">The source has changed. Old drafts are retained but rendering is blocked.</p>':''}
        <label>Load the prepared source_pack.json<input id="social-pack" type="file" accept=".json,application/json" ${state.source?'':'disabled'}></label>
        ${state.pack&&!state.stale?`<form id="social-draft-form" novalidate>
          <label>Topic-only title<input name="title" maxlength="100" required value="${esc(input.title)}"></label>
          <div class="production-toolbar"><label>Start (milliseconds)<input name="start_ms" type="number" required value="${esc(input.start_ms)}"></label><label>End (milliseconds)<input name="end_ms" type="number" required value="${esc(input.end_ms)}"></label><label>Picture<select name="layout">${Object.keys(state.pack.framing_presets || {}).map(k=>`<option ${input.layout===k?'selected':''}>${esc(k)}</option>`).join('')}</select></label></div>
          <p class="panel-hint">Choose whole transcript cues over 15–90 seconds. For alternating cameras or caption corrections, use a prepared recipe below.</p>
          <details ${input.recipe?'open':''}><summary>Existing recipe or advanced edits</summary><label>Recipe JSON (overrides the fields above)<textarea name="recipe" rows="8">${esc(input.recipe)}</textarea></label></details>
          <button type="submit">Check and save new test version</button><button type="button" id="social-discard">Discard edits</button>
        </form>
        <details><summary>Transcript cues and safe ranges</summary><p>Keep within ${esc(state.pack.program.start_ms)}–${esc(state.pack.program.end_ms)} ms. A camera cut or existing graphic blocks the range.</p><div class="social-cue-list">${state.pack.cues.map(c=>`<p><code>${esc(c.start_ms)}–${esc(c.end_ms)}</code> · ${esc(c.speaker_id)} · ${esc(c.segment_id)}<br>${esc(c.text)}</p>`).join('')}</div></details>`:''}
        <div class="social-saved-drafts">${state.drafts.slice().reverse().map(d=>`<article><h4>${esc(d.selection.title)}</h4><p>${esc(d.selection.start_ms)}–${esc(d.selection.end_ms)} ms · ${esc(d.created_at)} · ${d.render?'Technically checked; editorial review pending':'Saved test plan; not rendered'}</p><button type="button" data-social-edit="${esc(d.id)}">Edit as a new version</button>${d.render?`<video controls preload="none" src="${url}/preview/${d.id}"></video>`:`<button type="button" data-social-render="${esc(d.id)}" ${state.stale?'disabled':''}>Render this local test</button>`}<p>${esc((d.warnings || []).map(w=>typeof w==='string'?w:JSON.stringify(w)).join(' · '))}</p>
          ${d.render?`<details class="social-finish-editor" ${drafts.get('__finish_'+d.id)?'open':''}><summary>Finish ending · new version</summary><form data-social-finish="${d.id}"><p>Leave the recipe empty to overlay “The full conversation is in Episode ${esc(state.episode_number || 'N')}” as text over the last seconds; existing speech and captions remain. Or paste a prepared ending recipe for a real recorded line. The local ending file must be inside this episode’s work folder.</p>${`<div class="production-toolbar"><label>Cue duration (seconds)<input name="duration" type="number" min="3" max="5" step="0.1" value="${esc(drafts.get('__finish_'+d.id)?.duration || 4)}"></label><label>Cue top position (pixels)<input name="overlay_y" type="number" min="180" max="1200" value="${esc(drafts.get('__finish_'+d.id)?.overlay_y || 230)}"></label></div>`}<label>Recorded ending recipe JSON (optional)<textarea name="recipe" rows="8">${esc(drafts.get('__finish_'+d.id)?.recipe || '')}</textarea></label><p>Watch the base preview first. This button renders locally and creates a new version.</p><button type="submit" ${state.stale?'disabled':''}>Create finished review version</button><button type="button" data-finish-discard="${d.id}">Discard ending edits</button></form></details>`:''}
          ${(d.finishes||[]).slice().reverse().map(f=>`<section class="social-finished"><h5>Finished version · ${esc(f.created_at || f.id)}</h5><p>${f.current?`${esc(f.mode)} · ${(f.duration_ms/1000).toFixed(1)} seconds · human review pending`:'Incomplete or changed files · use a new version'}</p>${f.current?`<video controls preload="none" src="${url}/finish/${d.id}/${f.id}/preview"></video><p><a href="${url}/finish/${d.id}/${f.id}/master" target="_blank" rel="noopener">Open full-resolution master</a> · <a href="${url}/finish/${d.id}/${f.id}/review" target="_blank" rel="noopener">Six-part review sheet</a> · <a href="${url}/finish/${d.id}/${f.id}/receipt" target="_blank" rel="noopener">Technical receipt</a></p><p>Master SHA-256: <code>${esc(f.master_sha256)}</code></p>`:''}</section>`).join('')}
          </article>`).join('')}</div>
      </section>`;
      root.querySelector('#social-pack').onchange=async event=>{
        try {
          if(drafts.get('__social'))throw Error('Save or discard your clip edits before loading a pack');
          const file=event.target.files[0];if(!file)return;if(file.size>900_000)throw Error('Source pack is too large');
          state=await api(url,{method:'PUT',body:JSON.stringify({revision:state.revision,pack:JSON.parse(await file.text())})});state=await api(url);if(root.isConnected)render();
        }catch(error){toast(error.message,'error');}
      };
      const form=root.querySelector('#social-draft-form');
      if(form) {
        form.oninput=()=>drafts.set('__social',Object.fromEntries(new FormData(form)));
        root.querySelector('#social-discard').onclick=()=>{drafts.discard('__social');render();};
        form.onsubmit=async event=>{
          event.preventDefault();const submitted=Object.fromEntries(new FormData(form));drafts.set('__social',submitted);event.submitter.disabled=true;
          try {
            const body={...submitted,revision:state.revision,recipe:submitted.recipe.trim()?JSON.parse(submitted.recipe):undefined};
            state=await api(url,{method:'PUT',body:JSON.stringify(body)});drafts.saved('__social',submitted);state=await api(url);if(root.isConnected)render();toast('Test version saved. Rendering and human review are next.');
          }catch(error){toast(error.message,'error');event.submitter.disabled=false;}
        };
      }
      root.querySelectorAll('form[data-social-finish]').forEach(form=>{
        const id=form.dataset.socialFinish,key='__finish_'+id;
        form.oninput=()=>drafts.set(key,Object.fromEntries(new FormData(form)));
        form.querySelector('[data-finish-discard]').onclick=()=>{drafts.discard(key);render();};
        form.onsubmit=async event=>{
          event.preventDefault();if(drafts.get('__social'))return toast('Save or discard your base-clip edits first.','error');
          const submitted=Object.fromEntries(new FormData(form));drafts.set(key,submitted);const button=event.submitter;button.disabled=true;
          try {
            const recipe=String(submitted.recipe || '').trim()?JSON.parse(submitted.recipe):{schema:'eaol-social-finishing-v1',episode_number:Number(state.episode_number),mode:'text_overlay',duration_ms:Math.round(Number(submitted.duration)*1000),overlay_y:Number(submitted.overlay_y)};
            const {job}=await api(`${url}/finish/${id}`,{method:'POST',body:JSON.stringify({revision:state.revision,recipe,confirmLocalFinish:true})});
            drafts.saved(key,submitted);if(pollJob)await pollJob(job);
          } catch(error){toast(error.message,'error');button.disabled=false;}
        };
      });
      root.querySelectorAll('[data-social-edit]').forEach(button=>button.onclick=()=>{
        if(drafts.get('__social'))return toast('Save or discard current edits first.','error');
        const d=state.drafts.find(d=>d.id===button.dataset.socialEdit);
        drafts.set('__social',{title:d.selection.title,start_ms:d.selection.start_ms,end_ms:d.selection.end_ms,recipe:JSON.stringify(d.selection,null,2)});render();
      });
      root.querySelectorAll('[data-social-render]').forEach(button=>button.onclick=async()=>{
        if(drafts.dirty)return toast('Save or discard your edits before rendering.','error');
        button.disabled=true;
        try {const {job}=await api(`${url}/render`,{method:'POST',body:JSON.stringify({id:button.dataset.socialRender,revision:state.revision,confirmLocalRender:true})});if(pollJob)await pollJob(job);}
        catch(error){toast(error.message,'error');button.disabled=false;}
      });
    };render();
  }catch(error){if(root.isConnected)root.innerHTML=`<p role="alert">${esc(error.message)}</p>`;}
}
