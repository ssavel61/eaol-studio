const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
// One control shared by normal and recovered episodes. Numbers never inherit from the show preset.
export async function renderNumberedOpeningControl(episode, { api, openEpisode, pollJob, toast }) {
  const parent = document.querySelector(episode.recovery ? '#recovery-workspace' : '#assembly-workspace');
  parent.querySelector('#numbered-opening-control')?.remove();
  const panel = document.createElement('section'); panel.id = 'numbered-opening-control'; panel.className = 'recovery-status'; parent.append(panel);
  const url = `/api/episodes/${encodeURIComponent(episode.slug)}/numbered-opening`;
  try {
    const state = await api(url);
    if (!panel.isConnected) return;
    const p = state.recipe, base = state.defaults || {}, ready = state.render && !state.render.stale;
    panel.innerHTML = `<h3>Episode number on the opening</h3>
      <p>Reuse a clean opening and add this episode’s number. The base file and its sound stay unchanged. Each render creates a separate opening asset for review.</p>
      <form id="numbered-opening-form">
        <label>Clean opening file<input name="sourcePath" value="${esc(p?.source.path || base.sourcePath || '')}" required placeholder="Full local path to the clean opening MP4" /></label>
        <label>Opening episode number<input name="episodeNumber" type="number" min="1" max="9999" step="1" required value="${esc(p?.episodeNumber || '')}" /></label>
        <label>Number appears at (seconds)<input name="startSec" type="number" min="0" max="120" step=".01" value="${p?.startSec ?? base.startSec ?? 7.75}" required /></label>
        <label>Number disappears at (seconds)<input name="endSec" type="number" min=".5" max="120" step=".01" value="${p?.endSec ?? base.endSec ?? 36}" required /></label>
        <label class="recovery-inline"><input type="checkbox" name="cleanBaseConfirmed" ${p?.cleanBaseConfirmed ? 'checked' : ''} required /> This base has no episode number already in the picture</label>
        <label class="recovery-inline"><input type="checkbox" name="saveAsDefault" /> Remember this clean base and timing for future episodes</label>
        <p>Style: teal, bottom center, “Episode NN” format. Each episode needs its own number.</p>
        <button class="primary-button">Save numbered opening draft</button>
      </form>
      ${p ? `<p>${esc(p.label)} · ${state.current ? 'Draft saved' : 'Source or renderer changed — save again'}</p><button type="button" id="render-numbered-opening" ${state.current ? '' : 'disabled'}>Render numbered opening</button>` : ''}
      ${state.render ? ready ? `<p>Numbered opening ready for review. This is a separate opening asset, not a finished episode.</p><video controls playsinline preload="metadata" src="${url}/media?v=${esc(state.render.preview.sha256)}"></video><details><summary>Open in a local player or use in episode assembly</summary><p>Use the full-resolution file below as this episode’s opening override after review. The reusable clean base remains the show default.</p><code class="recovery-path">${esc(state.render.output.path)}</code></details>` : '<p>Previous numbered opening is outdated. Render again before use.</p>' : ''}`;
    panel.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const button = event.submitter; button.disabled = true;
      try {
        const f = event.currentTarget.elements;
        await api(url, {method:'PUT',body:JSON.stringify({sourcePath:f.sourcePath.value,episodeNumber:Number(f.episodeNumber.value),startSec:Number(f.startSec.value),endSec:Number(f.endSec.value),cleanBaseConfirmed:f.cleanBaseConfirmed.checked,saveAsDefault:f.saveAsDefault.checked,expectedFingerprint:p?.fingerprint || null})});
        toast('Numbered opening draft saved. Review its rendered output next.'); await openEpisode(episode.slug);
      } catch(error) { toast(error.message,'error'); } finally { button.disabled = false; }
    };
    const render = panel.querySelector('#render-numbered-opening');
    if (render) render.onclick = async () => {
      render.disabled = true;
      try { const result = await api(`${url}/render`,{method:'POST',body:JSON.stringify({fingerprint:p.fingerprint})}); await pollJob(result.job); }
      catch(error) { toast(error.message,'error'); } finally { render.disabled = false; }
    };
  } catch(error) { if(panel.isConnected) panel.textContent = `Opening controls unavailable: ${error.message}`; }
}
