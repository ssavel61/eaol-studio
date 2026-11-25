const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function renderOpeningTransitionControl(episode,{api,pollJob,toast}) {
 const parent=document.querySelector('#recovery-workspace');parent.querySelector('#opening-transition-control')?.remove();
 const panel=document.createElement('section');panel.id='opening-transition-control';panel.className='recovery-status';parent.append(panel);
 const url=`/api/episodes/${encodeURIComponent(episode.slug)}/recovery/opening-transition`;
 try {
  const state=await api(url);if(!panel.isConnected)return;
  const receipt=state.receipt, settings=receipt?.settings;
  panel.innerHTML=`<h3>Opening into the conversation</h3><p>Review the last eight seconds of the opening and the first twelve seconds of the current camera draft. Match the opening’s loudness to the accepted conversation without changing the conversation mix.</p>
   ${state.ready?`<form><label>Trim opening tail (seconds)<input name="trimEndSec" type="number" min="0" max="10" step=".05" value="${settings?.trimEndSec??2}" required /></label><label>Fade in conversation picture (seconds)<input name="fadeInSec" type="number" min="0" max="2" step=".05" value="${settings?.fadeInSec??.45}" required /></label><p>The fade affects picture only. The first words remain intact.</p><button class="primary-button">Render opening transition</button></form>`:`<p>${esc(state.error)}</p>`}
   ${receipt ? receipt.stale ? '<p>Previous transition is outdated. Render again after reviewing the current inputs.</p>' : `<p>20-second transition ready for review; the conversation begins at 0:08. Full episode approval remains separate.</p><video controls playsinline preload="metadata" src="${url}/media?v=${esc(receipt.output.sha256)}"></video><details><summary>Local player file</summary><code class="recovery-path">${esc(receipt.output.path)}</code></details>` : ''}`;
  const form=panel.querySelector('form');if(form)form.onsubmit=async event=>{
   event.preventDefault();const button=event.submitter;button.disabled=true;
   try {const result=await api(url,{method:'POST',body:JSON.stringify({inputsKey:state.inputsKey,trimEndSec:Number(form.elements.trimEndSec.value),fadeInSec:Number(form.elements.fadeInSec.value)})});await pollJob(result.job);}catch(e){toast(e.message,'error');}finally{button.disabled=false;}
  };
 }catch(e){if(panel.isConnected)panel.textContent=`Opening transition unavailable: ${e.message}`;}
}
