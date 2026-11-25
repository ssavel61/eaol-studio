const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function renderClosingTransitionControl(episode,{api,pollJob,toast}) {
 const parent=document.querySelector('#recovery-workspace');parent.querySelector('#closing-transition-control')?.remove();
 const panel=document.createElement('section');panel.id='closing-transition-control';panel.className='recovery-status';parent.append(panel);
 const url=`/api/episodes/${encodeURIComponent(episode.slug)}/recovery/closing-transition`;
 try {
  const state=await api(url);if(!panel.isConnected)return;
  const r=state.receipt;
  panel.innerHTML=`<h3>Music beneath the sign-off</h3><p>Review the last twenty seconds of conversation and the closing. Music begins beneath the final speaker and continues into the closing picture without restarting. The sample starts at the same point each time. Tail trim moves the ending earlier; review the last words before approving.</p>
   ${state.ready?`<form><label>Closing video with music<input name="sourcePath" value="${esc(r?.source.path||'')}" required /></label><label>Music lead before closing picture (seconds)<input name="leadSec" type="number" min="0" max="15" step=".1" value="${r?.settings.leadSec??8}" required /></label><label>Trim conversation tail (seconds)<input name="trimProgramEndSec" type="number" min="0" max="5" step=".1" value="${r?.settings.trimProgramEndSec??0}" required /></label><label>Closing music gain (dB)<input name="gainDb" type="number" min="-24" max="0" step=".5" value="${r?.settings.gainDb??-4}" required /></label><p>Episode 1 reference: eight-second lead, closing audio lowered by 4 dB. Review voice clarity for this episode.</p><button class="primary-button">Render closing transition</button></form>`:`<p>${esc(state.error)}</p>`}
   ${r?r.stale?'<p>Previous closing preview is outdated. Render again with current inputs.</p>':`<p>Ready for review. Music begins at ${r.musicStartsSec.toFixed(2)} seconds; closing picture begins at ${r.closingPictureStartsSec.toFixed(2)} seconds. Approval is pending.</p><video controls playsinline preload="metadata" src="${url}/media?v=${esc(r.output.sha256)}"></video><details><summary>Local player file</summary><code class="recovery-path">${esc(r.output.path)}</code></details>`:''}`;
  const form=panel.querySelector('form');if(form)form.onsubmit=async event=>{
   event.preventDefault();const button=event.submitter;button.disabled=true;
   try{const result=await api(url,{method:'POST',body:JSON.stringify({inputsKey:state.inputsKey,sourcePath:form.elements.sourcePath.value,leadSec:Number(form.elements.leadSec.value),gainDb:Number(form.elements.gainDb.value),trimProgramEndSec:Number(form.elements.trimProgramEndSec.value)})});await pollJob(result.job);}catch(e){toast(e.message,'error');}finally{button.disabled=false;}
  };
 }catch(e){if(panel.isConnected)panel.textContent=`Closing transition unavailable: ${e.message}`;}
}
