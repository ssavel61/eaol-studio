// Shared source-bound framing and lossless caption transformations.
function requireTrue(value, message) { if (!value) throw new Error(message); }

export function validateFinalFraming(framing, start, end, width, height) {
  const validCrop = (c, aspectWidth, aspectHeight) => c && ['x','y','width','height'].every(k => Number.isInteger(c[k]) && c[k] % 2 === 0)
    && c.x >= 0 && c.y >= 0 && c.width > 0 && c.height > 0 && c.x + c.width <= width && c.y + c.height <= height
    && c.width * aspectHeight === c.height * aspectWidth;
  if (framing?.mode === 'crop') requireTrue(validCrop(framing,9,16), 'invalid portrait crop');
  else if (framing?.mode === 'stacked') {
    requireTrue(framing.panels?.length === 2 && framing.panels.every(p => validCrop(p,9,8)), 'invalid stacked crop');
    requireTrue(new Set(framing.panels.map(p => p.speaker_id)).size === 2, 'stacked hosts must differ');
  } else if (framing?.mode === 'speaker_cuts') {
    requireTrue(framing.shots?.length >= 2, 'speaker cuts require multiple shots');
    let cursor = start;
    for (const shot of framing.shots) {
      requireTrue(validCrop(shot,9,16) && shot.start_ms === cursor && Number.isInteger(shot.end_ms)
        && shot.end_ms > shot.start_ms && shot.end_ms <= end && shot.speaker_id, 'invalid or discontinuous speaker crop');
      cursor = shot.end_ms;
    }
    requireTrue(cursor === end, 'speaker crops do not cover clip');
  } else requireTrue(false, 'invalid portrait crop mode');
}

export function reconcileCaptionHandoffs(captions, overrides = []) {
  const adjusted = captions.map(c => ({...c})), edits = [];
  for (const override of overrides) {
    const index = adjusted.findIndex(c => c.segment_id === override.segment_id), prior = adjusted[index], next = adjusted[index + 1];
    requireTrue(prior && next && prior.speaker_id && next.speaker_id && prior.speaker_id !== next.speaker_id
      && prior.end_ms === override.original_end_ms && override.end_ms === next.start_ms
      && prior.end_ms > next.start_ms && prior.end_ms - next.start_ms <= 400
      && override.end_ms - prior.start_ms >= 840, 'invalid caption handoff adjustment');
    edits.push({...override,reason:'display timing only; preserve every word and continuous source audio'});
    prior.end_ms = override.end_ms;
  }
  return { captions:adjusted, edits };
}

export function mergeCaptionPhrases(captions, groups = []) {
  const result = captions.map(c => ({...c}));
  for (const ids of groups) {
    requireTrue(Array.isArray(ids) && ids.length >= 2, 'caption phrase requires consecutive cues');
    const start = result.findIndex(c => c.segment_id === ids[0]), selected = result.slice(start,start+ids.length);
    requireTrue(start >= 0 && JSON.stringify(selected.map(c => c.segment_id)) === JSON.stringify(ids)
      && selected.every((c,i) => c.speaker_id === selected[0].speaker_id && (!i || (c.start_ms >= selected[i-1].end_ms
        && c.start_ms - selected[i-1].end_ms <= 250))), 'caption phrase must preserve adjacent same-speaker cues');
    result.splice(start,ids.length,{...selected[0],segment_id:ids.join('+'),source_segment_ids:ids,
      end_ms:selected.at(-1).end_ms,text:selected.map(c=>c.text).join(' ')});
  }
  return result;
}

export function finalFramingFilter(framing, startMs) {
  const crop = c => `crop=${c.width}:${c.height}:${c.x}:${c.y}`;
  if (framing.mode === 'stacked') return `[0:v:0]split=2[left][right];[left]${crop(framing.panels[0])},scale=1080:960[top];[right]${crop(framing.panels[1])},scale=1080:960[bottom];[top][bottom]vstack,setsar=1,ass=captions.ass[v]`;
  if (framing.mode === 'speaker_cuts') {
    const shots = framing.shots, first = shots[0];
    requireTrue(shots.every(s => s.width === first.width && s.height === first.height && s.y === first.y), 'speaker cut crops must share size and vertical position');
    let x = String(shots.at(-1).x);
    for (let i=shots.length-2;i>=0;i--) x = `if(lt(t,${((shots[i].end_ms-startMs)/1000).toFixed(6)}),${shots[i].x},${x})`;
    return `[0:v:0]crop=${first.width}:${first.height}:'${x}':${first.y},scale=1080:1920,setsar=1,ass=captions.ass[v]`;
  }
  return `[0:v:0]${crop(framing)},scale=1080:1920,setsar=1,ass=captions.ass[v]`;
}

