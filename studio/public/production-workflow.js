import { renderSocialWorkspace } from './social-workspace.js';
import { renderReleaseWorkspace } from './release-workspace.js';
import { createNoteDrafts } from './note-drafts.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const labels = { todo: 'No note yet', complete: 'Recorded complete', blocked: 'Blocked', not_applicable: 'Not applicable' };
const phases = [
  { title:'Prepare', steps:['intake','continuity'] },
  { title:'Edit', steps:['finishing','ctas'] },
  { title:'Review', steps:['review'] },
  { title:'Export', steps:['final'] },
  { title:'Release', steps:['release'] },
  { title:'Social & learn', steps:['social','learning'] },
];
const shortNames = { intake:'Recordings', continuity:'Joins & sync', finishing:'Picture & sound', ctas:'Callouts', review:'Draft review', final:'Final files', release:'Release copy', social:'Social clips', learning:'Next run' };
let requestNumber = 0;
const selection = new Map();
const episodeDrafts = new Map();
window.addEventListener('beforeunload', event => {
  if ([...episodeDrafts.values()].some(drafts => drafts.dirty)) { event.preventDefault(); event.returnValue = ''; }
});

export async function renderProductionWorkflow(episode, { api, toast, activate, operatorChanged, pollJob }) {
  const root = document.querySelector('#production-workflow');
  root.classList.remove('hidden');
  const request = ++requestNumber;
  const url = `/api/episodes/${encodeURIComponent(episode.slug)}/production-workflow`;
  root.innerHTML = '<p role="status">Loading your episode…</p>';
  try {
    let state = await api(url), allControls = false, notesOpen = false;
    if (!episodeDrafts.has(episode.slug)) episodeDrafts.set(episode.slug, createNoteDrafts());
    const drafts = episodeDrafts.get(episode.slug);
    if (request !== requestNumber) return;
    function changeStep(id) {
      if (drafts.dirty) { toast('Save your note before changing steps, or use Discard unsaved note.', 'error'); return; }
      selection.set(episode.slug,id);
      try { localStorage.setItem(`eaol-production-step:${episode.slug}`,id); } catch {}
      notesOpen = false; allControls = false; render();
      root.scrollIntoView({behavior:'instant',block:'start'});
    }
    function render() {
      if (request !== requestNumber) return;
      let selected = selection.get(episode.slug);
      if (!selected) { try { selected = localStorage.getItem(`eaol-production-step:${episode.slug}`); } catch {} }
      selected ||= state.recovery ? 'finishing' : 'intake';
      const step = state.steps.find(s => s.id === selected) || state.steps[0];
      const index = state.steps.indexOf(step), phase = phases.find(p=>p.steps.includes(step.id));
      const next = state.steps[index+1], prev = state.steps[index-1];
      const files = ['final','release'].includes(step.id) ? state.media : [];
      root.innerHTML = `
        <header class="production-header"><div><p class="section-kicker">Episode workspace</p><h2>${esc(state.title)}</h2><p class="production-status">${esc(state.facts.find(([k])=>k==='Full render')?.[1] || 'Prepare and verify the recordings')}</p></div>
          <details class="production-tools"><summary>Session &amp; files</summary>
            <div class="production-toolbar"><label>Working as<select id="production-operator"><option value="">Choose operator</option><option value="host_1" ${state.operator_id==='host_1'?'selected':''}>Host 1</option><option value="host_2" ${state.operator_id==='host_2'?'selected':''}>Host 2</option></select></label><button type="button" id="production-save-operator">Use identity</button></div>
            <a href="${url}/handoff">Download workflow notes</a><button type="button" id="production-refresh">Refresh file status</button>
            <ul>${state.facts.map(([k,v])=>`<li><strong>${esc(k)}:</strong> ${esc(v)}</li>`).join('')}</ul>
            <details><summary>Assisted steps &amp; approval boundaries</summary><p>${esc(state.notice)}</p><ul>${state.blockers.map(b=>`<li>${esc(b)}</li>`).join('')}</ul></details>
          </details>
        </header>
        <nav class="production-flow" aria-label="Episode workflow">${phases.map((p,i)=>`<button type="button" data-production-step="${p.steps.includes(step.id)?step.id:p.steps[0]}" aria-current="${p===phase?'step':'false'}"><span>${i+1}</span><strong>${p.title}</strong></button>`).join('')}</nav>
        <div class="production-substeps" role="group" aria-label="${esc(phase.title)} steps">${phase.steps.map(id=>`<button type="button" data-production-step="${id}" aria-pressed="${step.id===id}">${esc(shortNames[id])}</button>`).join('')}<span>Step ${index+1} of ${state.steps.length}</span></div>
        <section class="production-current" aria-label="Current step">
          <div class="production-step-copy"><p class="section-kicker">${esc(phase.title)}</p><h3>${esc(step.title)}</h3><p>${esc(step.hint)}</p></div>
          <div class="production-navigation"><button type="button" data-production-step="${prev?.id || step.id}" ${prev?'':'disabled'}>← Back</button>${next?`<button type="button" class="primary-button" data-production-step="${next.id}">Next: ${esc(shortNames[next.id])} →</button>`:'<span>End of workflow</span>'}</div>
        </section>
        ${state.stale?'<p role="alert" class="production-alert">Source files changed. Re-verify inputs before continuing.</p>':''}
        ${!step.target?`<p class="production-assisted">This step takes place outside Studio. Use the review notes below to record the result.</p>`:''}
        ${files.length?`<div class="production-media" aria-label="Current episode files">${files.map(m=>`<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.label)}</a>`).join('')}</div>`:''}
        ${step.id==='intake'?`<section class="production-recording"><h3>Before recording</h3><p>Check framing and eye level in a short camera test. Confirm both cameras and isolated microphones stay recording through the start and end claps and every restart.</p><p>Record the channel slate described in the README so the microphone channel check has something to measure.</p></section>`:''}
        ${step.id==='release'?'<div id="release-workspace"></div>':''}
        ${step.id==='social'?'<div id="social-workspace"></div>':''}
        <details class="production-notes" ${notesOpen?'open':''}><summary>Review notes <span>${step.items.filter(i=>i.notes).length} saved · ${esc(state.operator || 'choose an operator to save')}</span></summary>
          <p class="panel-hint">Record the exact version, timestamp and decision. These notes do not replace file approvals. No note here does not undo a previous approval.</p>
          ${step.items.map(item=>`<details class="production-check" ${drafts.get(item.id)?'open':''}><summary><strong>${esc(item.title)}</strong><span>${esc(labels[item.status])}</span></summary><p>${esc(item.description)}</p><form data-production-item="${esc(item.id)}">
            <div class="production-toolbar"><label>Progress<select name="status">${Object.entries(labels).map(([key,label])=>`<option value="${key}" ${item.status===key?'selected':''}>${label}</option>`).join('')}</select></label><label>Owner<input name="owner" maxlength="100" value="${esc(item.owner)}" /></label></div>
            <label>Version, timestamp, evidence or blocker<textarea name="notes" maxlength="4000" rows="3">${esc(item.notes)}</textarea></label>
            <p class="panel-hint">${esc(item.recorded_by || '')} ${esc(item.updated_at || '')}</p><button type="submit" ${state.operator?'':'disabled'}>Save note</button><button type="button" class="production-discard">Discard unsaved note</button>
          </form></details>`).join('')}
        </details>
        <div class="production-controls-heading"><span>${step.target?'Controls for this step':'Record the handoff above'}</span><button type="button" id="production-all-controls" aria-pressed="${allControls}">${allControls?'Return to focused workflow':'Show all controls'}</button></div>`;
      if(step.id==='release') renderReleaseWorkspace(root.querySelector('#release-workspace'),episode,{api,toast,pollJob,drafts});
      if(step.id==='social') renderSocialWorkspace(root.querySelector('#social-workspace'),episode,{api,toast,pollJob,drafts});
      activate(step.id,allControls);
      root.querySelectorAll('[data-production-step]').forEach(button=>button.onclick=()=>changeStep(button.dataset.productionStep));
      root.querySelector('#production-all-controls').onclick=()=>{
        allControls=!allControls; activate(step.id,allControls);
        const button=root.querySelector('#production-all-controls');button.textContent=allControls?'Return to focused workflow':'Show all controls';button.setAttribute('aria-pressed',String(allControls));
      };
      root.querySelector('.production-notes').ontoggle=event=>{notesOpen=event.currentTarget.open;};
      root.querySelectorAll('form[data-production-item]').forEach(form=>{
        const id = form.dataset.productionItem;
        const restored = drafts.get(id);
        if (restored) for (const [name,value] of Object.entries(restored)) form.elements.namedItem(name).value = value;
        form.oninput=()=>{drafts.set(id,Object.fromEntries(new FormData(form)));};
        form.querySelector('.production-discard').onclick=()=>{drafts.discard(id);render();};
        form.onsubmit=async event=>{
          event.preventDefault();const button=event.submitter;button.disabled=true;
          const submitted=Object.fromEntries(new FormData(form)); drafts.set(id,submitted);
          try { state=await api(`${url}/${form.dataset.productionItem}`,{method:'PUT',body:JSON.stringify({...submitted,revision:state.revision})});drafts.saved(id,submitted);notesOpen=true;render();toast('Note saved. File approvals are unchanged.'); }
          catch(error){toast(error.message,'error');}finally{button.disabled=false;}
        };
      });
      root.querySelector('#production-refresh').onclick=async()=>{
        if(drafts.dirty)return toast('Save or discard your note before refreshing.','error');
        try{state=await api(url);render();}catch(error){toast(error.message,'error');}
      };
      root.querySelector('#production-save-operator').onclick=async()=>{
        if(drafts.dirty)return toast('Save or discard your note before changing identity.','error');
        try{const operator_id=root.querySelector('#production-operator').value;if(!operator_id)throw Error('Choose Host 1 or Host 2.');await api('/api/operator',{method:'PUT',body:JSON.stringify({operator_id})});await operatorChanged();state=await api(url);render();}catch(error){toast(error.message,'error');}
      };
    }
    render();
  } catch(error) { if(request===requestNumber)root.innerHTML=`<p role="alert">Workflow unavailable: ${esc(error.message)}. Reopen the episode to retry.</p>`; }
}
