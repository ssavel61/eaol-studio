// Per-original-camera framing; solos opt into matching subject size per shot.
export function validateRecoveryFraming(framing, sources, blocks) {
  if (framing === undefined) return;
  if (!framing || typeof framing.sources !== 'object' || Array.isArray(framing.sources)) throw new Error('Invalid framing settings');
  for (const [id, values] of Object.entries(framing.sources)) {
    if (!sources.some(s => s.id === id && s.role.endsWith('_camera'))) throw new Error('Framing requires an original camera source');
    if (!values || Object.keys(values).some(k => !['zoom', 'horizontal', 'vertical'].includes(k))) throw new Error('Unknown framing control');
    for (const [key, min, max] of [['zoom', 1, 1.8], ['horizontal', -100, 100], ['vertical', -100, 100]]) {
      if (!Number.isFinite(values[key]) || values[key] < min || values[key] > max) throw new Error(`${key} is outside the framing range`);
    }
  }
  for (const block of blocks) {
    const count = Object.values(block.cameras).filter(c => framing.sources[c.sourceId]).length;
    if (count !== 0 && count !== 2) throw new Error('Save both cameras for each recording part');
  }
}
export function recoveryPanelFilter(values) {
  const height = Math.ceil(720 * values.zoom / 2) * 2;
  const x = (0.5 + values.horizontal / 200).toFixed(5);
  const y = (0.5 + values.vertical / 200).toFixed(5);
  return `scale=-2:${height}:in_range=auto:out_range=tv,crop=640:720:x='(iw-ow)*${x}':y='(ih-oh)*${y}'`;
}

export function recoverySoloFilter(values) {
  if (!values) throw new Error('Save two-shot framing before matching solo size');
  const height = Math.ceil(720 * values.zoom / 2) * 2;
  const x = (0.5 + values.horizontal / 200).toFixed(5);
  const y = (0.5 + values.vertical / 200).toFixed(5);
  // Same scale and vertical crop as the 640px panel; extend 320px per side.
  // Clamp near edges rather than stretching or introducing empty pixels.
  return `scale=-2:${height}:in_range=auto:out_range=tv,crop=1280:720:x='max(0,min(iw-ow,(iw-640)*${x}-320))':y='(ih-oh)*${y}'`;
}
