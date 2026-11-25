const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const time = frame => { const sec = frame / 30; return `${Math.floor(sec / 60)}:${(sec % 60).toFixed(3).padStart(6, '0')}`; };
function frame(value) {
  const parts = String(value).trim().split(':');
  if (parts.length < 1 || parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) throw new Error('Use minutes:seconds, hours:minutes:seconds, or seconds');
  if (parts.length > 1 && parts.slice(1).some(p => Number(p) >= 60)) throw new Error('Minutes and seconds must be below 60');
  return Math.round(parts.reduce((n, p) => n * 60 + Number(p), 0) * 30);
}
export function bindRecoveryImport({ api, pollJob, toast }) {
  const dialog = document.querySelector('#recovery-import-dialog');
  document.querySelector('#recovery-import-button').onclick = () => dialog.showModal();
  document.querySelector('#recovery-import-cancel').onclick = () => dialog.close();
  document.querySelector('#recovery-import-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter; button.disabled = true;
    try {
      const result = await api('/api/recovery/import', { method: 'POST', body: JSON.stringify({ path: document.querySelector('#recovery-package-path').value }) });
      dialog.close(); await pollJob(result.job);
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  };
}
export function renderRecoveryWorkspace(episode, { api, openEpisode, pollJob, toast }) {
  const root = document.querySelector('#recovery-workspace'), p = episode.recovery;
  document.querySelector('#welcome-view').classList.add('hidden');
  document.querySelector('#episode-view').classList.add('hidden');
  // Stop hidden normal-episode playback when switching workspaces.
  document.querySelector('#source-video')?.pause();
  root.classList.remove('hidden');
  const url = `/api/episodes/${encodeURIComponent(episode.slug)}/recovery`;
  const label = view => view === 'two' ? 'Two-shot' : `${p.hosts[view]} solo`;
  const stale = p.staleInputs.length > 0;
  const firstSolo = p.shots.find(s => s.view !== 'two') || p.shots[0];
  const previewStart = p.preview?.startFrame ?? Math.max(0, firstSolo.startFrame - 60);
  const previewEnd = p.preview?.endFrame ?? Math.min(p.frames, previewStart + 1350);
  const colorComparison = p.preview?.comparisonKind === 'color';
  const alternate = p.preview?.alternatePlayback && !p.preview.alternatePlayback.stale;
  const afterRoute = alternate ? 'alternate-media' : 'preview-media';
  const beforeRoute = alternate ? 'alternate-comparison-media' : 'comparison-media';
  const mediaVersion = alternate ? p.preview.alternatePlayback.sha256 : p.preview?.sha256;
  const beforeLabel = colorComparison ? 'same framing, original color' : 'accepted continuity';
  const afterLabel = colorComparison ? 'color draft' : 'framing draft';
  root.innerHTML = `
    <div id="recovery-baseline-heading"><p class="section-kicker">Episode finishing · recovered recordings</p>
    <h2>${esc(episode.episode_title)}</h2>
    <p>${time(p.frames)} · ${p.sources.length} original parts · ${p.blocks.length} recording blocks · 720p continuity review</p>
    <div class="recovery-status ${stale ? 'recovery-warning' : ''}"><strong>${stale ? 'Inputs changed — editing and playback paused' : 'Continuity recovery imported and verified'}</strong>
      <p>${stale ? 'Restore the exact inputs and re-import to verify them. Previous decisions remain in the record.' : 'Your existing decisions are preserved below. Continue camera finishing here; the accepted review video stays unchanged.'}</p>
      <p>This section preserves the continuity baseline. Use Session &amp; files for current export status; each review decision retains its original scope.</p>
    </div>
    </div><div class="recovery-grid" id="recovery-camera-controls">
      <div>
        <h3>Watch the accepted continuity version</h3>
        <video id="recovery-video" controls playsinline preload="metadata" ${stale ? '' : `src="${url}/media"`}></video>
        <p class="muted">This review confirms continuity and specific camera timing. It is not the finished episode.</p>
        <p><a href="${url}/media" target="_blank" rel="noopener">Open the review video separately</a></p>
        <details><summary>Video blank or unavailable?</summary><p>Use the local review file in your video player. Keep this Studio workspace open for edits and receipts.</p><code class="recovery-path">${esc(p.review.path)}</code></details>
        <h3>Camera draft <small>Revision ${p.draft.revision}</small></h3>
        <p>${p.draft.revision ? 'Saved camera changes are drafts awaiting review.' : 'Starts with the existing recovery camera plan.'} Two-shot remains the default.</p>
        <table><thead><tr><th>Episode time</th><th>View</th><th></th></tr></thead><tbody>${p.draft.shots.map((s, i) => `<tr><td>${time(s.startFrame)}–${time(s.endFrame)}</td><td>${esc(label(s.view))}</td><td><button type="button" data-shot="${i}">Inspect range</button></td></tr>`).join('')}</tbody></table>
      </div>
      <div class="recovery-editor">
        <h3>Two-shot framing</h3>
        <p>Match eye levels and face sizes, then check natural movement. Each recording part has its own settings. Solo shots keep their existing framing unless you choose to match subject size below.</p>
        <form id="recovery-framing-form">
          <label>Recording part<select name="block">${p.blocks.map((b, i) => `<option value="${i}">Part ${i + 1} · ${time(b.startFrame)}–${time(b.endFrame)}</option>`).join('')}</select></label>
          <label class="recovery-inline"><input type="checkbox" name="enabled" /> Use tighter, full-height two-shot</label>
          ${['host_1', 'host_2'].map(host => `<fieldset><legend>${esc(p.hosts[host])}</legend>
            <label>Zoom<input type="number" name="${host}_zoom" min="1" max="1.8" step="0.01" value="1" required /></label>
            <label>Horizontal crop<input type="number" name="${host}_horizontal" min="-100" max="100" step="1" value="0" required /></label>
            <label>Vertical crop<input type="number" name="${host}_vertical" min="-100" max="100" step="1" value="0" required /></label>
          </fieldset>`).join('')}
          <p class="muted">Positive horizontal values move the subject left. Positive vertical values raise the subject; negative values lower them. More zoom provides more room to reposition vertically.</p>
          <button class="primary-button" ${stale ? 'disabled' : ''}>Save framing draft</button>
        </form>
        <h3>Camera color</h3>
        <p>Make small changes toward natural skin tones. Each camera and recording part can differ; room lighting does not need a perfect match.</p>
        <form id="recovery-color-form">
          <label>Color recording part<select name="block">${p.blocks.map((b, i) => `<option value="${i}">Part ${i + 1} · ${time(b.startFrame)}–${time(b.endFrame)}</option>`).join('')}</select></label>
          <label class="recovery-inline"><input type="checkbox" name="enabled" /> Apply color draft to this part</label>
          ${['host_1', 'host_2'].map(host => `<fieldset><legend>${esc(p.hosts[host])} color</legend>
            <label>Warmth<input type="number" name="${host}_warmth" min="-20" max="20" step="1" value="0" required /></label>
            <label>Tint<input type="number" name="${host}_tint" min="-20" max="20" step="1" value="0" required /></label>
            <label>Saturation<input type="number" name="${host}_saturation" min="0.8" max="1.2" step="0.01" value="1" required /></label>
          </fieldset>`).join('')}
          <p class="muted">Positive warmth adds warmth; negative cools. Positive tint adds magenta; negative adds green. Saturation 1 keeps the original intensity. Applies to both two-shots and solos from this camera.</p>
          <button class="primary-button" ${stale ? 'disabled' : ''}>Save color draft</button>
        </form>
        <h3>Try a camera change</h3>
        <p>Use a few sustained solo shots at natural conversational boundaries. Saving a range changes only the draft picture plan.</p>
        <form id="recovery-shot-form">
          <label>Start time<input name="start" value="${time(firstSolo.startFrame)}" required /></label>
          <label>End time<input name="end" value="${time(firstSolo.endFrame)}" required /></label>
          <label>Camera<select name="view"><option value="two">Two-shot</option><option value="host_1">${esc(p.hosts.host_1)} solo</option><option value="host_2">${esc(p.hosts.host_2)} solo</option></select></label>
          <label class="recovery-inline"><input type="checkbox" name="matchTwoShotFraming" /> Match two-shot subject size</label>
          <p class="muted">For this solo range only: keep the same face size and headroom as its two-shot, with a wider frame around the speaker.</p>
          <label>Editorial reason<textarea name="reason" required maxlength="1000" placeholder="Why this speaker and this moment?"></textarea></label>
          <button class="primary-button" ${stale ? 'disabled' : ''}>Save camera draft</button>
        </form>
        <h3>Render a short preview</h3>
        <p>1–60 seconds from the mapped original cameras, with the existing accepted audio mix. Compare a color draft against the same framing and original color. Graphics and final export are still finishing work.</p>
        <form id="recovery-preview-form">
          <label>Preview start<input name="start" value="${time(previewStart)}" required /></label>
          <label>Preview end<input name="end" value="${time(previewEnd)}" required /></label>
          <button class="secondary-button" ${stale ? 'disabled' : ''}>Render camera preview</button>
        </form>
      </div>
    </div>
    ${p.preview ? `<section class="recovery-status" id="recovery-camera-preview"><h3>Latest visual preview ${p.preview.stale ? '— outdated' : '— ready for review'}</h3><p>${time(p.preview.startFrame)}–${time(p.preview.endFrame)} · Draft picture only · Human approval pending</p>${p.preview.stale ? '<p>Render again to see the current draft.</p>' : `${p.preview.comparisonFile ? `<div class="recovery-comparison"><button type="button" data-comparison="before" aria-pressed="false">Before: ${beforeLabel}</button><button type="button" data-comparison="after" aria-pressed="true">After: ${afterLabel}</button></div><p>Compare the same moment with identical audio. Showing <strong id="recovery-comparison-label">${afterLabel}</strong>.</p>` : ''}<video id="recovery-draft-preview" controls playsinline preload="metadata" src="${url}/${afterRoute}?v=${esc(mediaVersion)}"></video><p><a href="${url}/${afterRoute}" target="_blank" rel="noopener">Open camera preview separately</a></p>${alternate ? '<p>Alternate playback active · same edit and color settings.</p>' : '<button type="button" id="recovery-playback-repair">Repair black video</button><p class="muted">Creates an alternate browser playback copy of this exact comparison.</p>'}`}</section>` : ''}
    <div id="recovery-evidence-panel"><h3>Preserved review decisions</h3>
    <p>These decisions belong to their original artifacts and scopes. New camera drafts do not inherit approval.</p>
    ${p.approvals.map(a => `<details class="recovery-decision"><summary>${esc(a.scope)} · ${esc(a.kind === 'accepted' ? 'Accepted' : 'First-watch feedback')}</summary><p>${esc(a.reviewer)}: ${esc(a.feedback || '')}</p><code class="recovery-path">Target SHA-256: ${esc(a.targetSha256)}</code><p>Evidence: ${esc(p.evidence.find(e => e.id === a.evidenceId).path)}</p></details>`).join('')}
    <details class="recovery-decision"><summary>Original recordings and camera map · ${p.sources.length} parts</summary>
      <table><thead><tr><th>Source</th><th>File</th><th>Verification</th></tr></thead><tbody>${p.sources.map(s => `<tr><td>${esc(s.role)} · part ${esc(s.part)}</td><td class="recovery-path">${esc(s.path)}</td><td>${stale ? 'Recheck required' : 'SHA-256 verified'}</td></tr>`).join('')}</tbody></table>
      <p>Camera blocks: ${p.blocks.map(b => `${time(b.startFrame)}–${time(b.endFrame)}`).join(' · ')}</p>
      <p>${esc(p.notes || '')}</p>
    </details></div>`;
  const shotForm = root.querySelector('#recovery-shot-form');
  const framingForm = root.querySelector('#recovery-framing-form');
  function loadFramingFields() {
    const block = p.blocks[Number(framingForm.elements.block.value)];
    framingForm.elements.enabled.checked = Boolean(p.draft.framing?.sources[block.cameras.host_1.sourceId]);
    for (const host of ['host_1', 'host_2']) {
      const values = p.draft.framing?.sources[block.cameras[host].sourceId] || { zoom: 1, horizontal: 0, vertical: 0 };
      for (const key of ['zoom', 'horizontal', 'vertical']) framingForm.elements[`${host}_${key}`].value = values[key];
    }
  }
  framingForm.elements.block.onchange = loadFramingFields;
  loadFramingFields();
  framingForm.onsubmit = async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const f = framingForm.elements;
      const body = { draftFingerprint: p.draftFingerprint, blockIndex: Number(f.block.value), enabled: f.enabled.checked };
      for (const host of ['host_1', 'host_2']) body[host] = Object.fromEntries(['zoom', 'horizontal', 'vertical'].map(key => [key, Number(f[`${host}_${key}`].value)]));
      await api(`${url}/framing`, { method: 'PUT', body: JSON.stringify(body) });
      toast('Framing draft saved. Render a short comparison before approving the look.');
      await openEpisode(episode.slug);
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  };
  const colorForm = root.querySelector('#recovery-color-form');
  function loadColorFields() {
    const block = p.blocks[Number(colorForm.elements.block.value)];
    colorForm.elements.enabled.checked = Boolean(p.draft.color?.sources[block.cameras.host_1.sourceId]);
    for (const host of ['host_1', 'host_2']) {
      const values = p.draft.color?.sources[block.cameras[host].sourceId] || { warmth: 0, tint: 0, saturation: 1 };
      for (const key of ['warmth', 'tint', 'saturation']) colorForm.elements[`${host}_${key}`].value = values[key];
    }
  }
  colorForm.elements.block.onchange = loadColorFields;
  loadColorFields();
  colorForm.onsubmit = async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const f = colorForm.elements;
      const body = { draftFingerprint: p.draftFingerprint, blockIndex: Number(f.block.value), enabled: f.enabled.checked };
      for (const host of ['host_1', 'host_2']) body[host] = Object.fromEntries(['warmth', 'tint', 'saturation'].map(key => [key, Number(f[`${host}_${key}`].value)]));
      await api(`${url}/color`, { method: 'PUT', body: JSON.stringify(body) });
      toast('Color draft saved. Render a short Before/After comparison.');
      await openEpisode(episode.slug);
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  };
  const repairButton = root.querySelector('#recovery-playback-repair');
  if (repairButton) repairButton.onclick = async () => {
    repairButton.disabled = true;
    root.querySelector('#recovery-draft-preview')?.pause();
    try {
      const result = await api(`${url}/playback`, { method: 'POST', body: JSON.stringify({ previewSha256: p.preview.sha256 }) });
      await pollJob(result.job);
    } catch (error) { toast(error.message, 'error'); }
    finally { repairButton.disabled = false; }
  };
  root.querySelectorAll('[data-comparison]').forEach(button => button.onclick = () => {
    const video = root.querySelector('#recovery-draft-preview');
    const at = video.currentTime, playing = !video.paused;
    video.pause();
    video.src = `${url}/${button.dataset.comparison === 'before' ? beforeRoute : afterRoute}?v=${esc(mediaVersion)}`;
    video.onloadedmetadata = () => { video.currentTime = Math.min(at, Math.max(0, video.duration - .05)); if (playing) video.play().catch(() => {}); };
    root.querySelector('#recovery-comparison-label').textContent = button.dataset.comparison === 'before' ? beforeLabel : afterLabel;
    root.querySelectorAll('[data-comparison]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  });
  shotForm.elements.view.value = firstSolo.view;
  const updateSoloControl = () => {
    shotForm.elements.matchTwoShotFraming.disabled = shotForm.elements.view.value === 'two';
    if (shotForm.elements.view.value === 'two') shotForm.elements.matchTwoShotFraming.checked = false;
  };
  shotForm.elements.matchTwoShotFraming.checked = Boolean(firstSolo.matchTwoShotFraming);
  shotForm.elements.view.onchange = updateSoloControl;
  updateSoloControl();
  root.querySelectorAll('[data-shot]').forEach(button => button.onclick = () => {
    const shot = p.draft.shots[Number(button.dataset.shot)];
    shotForm.elements.start.value = time(shot.startFrame);
    shotForm.elements.end.value = time(shot.endFrame);
    shotForm.elements.view.value = shot.view;
    shotForm.elements.reason.value = shot.reason || '';
    shotForm.elements.matchTwoShotFraming.checked = Boolean(shot.matchTwoShotFraming);
    updateSoloControl();
    const video = root.querySelector('#recovery-video');
    video.currentTime = Math.max(0, shot.startFrame / 30 - 2);
  });
  async function submit(event, action) {
    event.preventDefault();
    const button = event.submitter; button.disabled = true;
    try {
      const f = event.currentTarget.elements;
      const body = { startFrame: frame(f.start.value), endFrame: frame(f.end.value), draftFingerprint: p.draftFingerprint };
      if (action === 'shot') Object.assign(body, { view: f.view.value, reason: f.reason.value, matchTwoShotFraming: f.matchTwoShotFraming.checked });
      const result = await api(`${url}/${action}`, { method: action === 'shot' ? 'PUT' : 'POST', body: JSON.stringify(body) });
      if (result.job) await pollJob(result.job);
      else { toast('Camera draft saved. Existing approvals are unchanged.'); await openEpisode(episode.slug); }
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }
  shotForm.onsubmit = e => submit(e, 'shot');
  root.querySelector('#recovery-preview-form').onsubmit = e => submit(e, 'preview');
}
