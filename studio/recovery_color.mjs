// Bounded per-source finishing controls; neutral values leave picture unchanged.
// pl=1 can collapse blue-channel highlights to gray; keep bounded RGB shifts without it.
export const recoveryColorPipeline = 'bounded-midtones-no-lightness-v2';
export const neutralRecoveryColor = { warmth: 0, tint: 0, saturation: 1 };
export function validateRecoveryColor(color, sources) {
  if (color === undefined) return;
  if (!color || !color.sources || typeof color.sources !== 'object' || Array.isArray(color.sources)) throw new Error('Invalid color settings');
  for (const [id, values] of Object.entries(color.sources)) {
    if (!sources.some(s => s.id === id && s.role.endsWith('_camera'))) throw new Error('Color requires an original camera source');
    if (!values || Object.keys(values).some(k => !['warmth', 'tint', 'saturation'].includes(k))) throw new Error('Unknown color control');
    for (const [key, min, max] of [['warmth', -20, 20], ['tint', -20, 20], ['saturation', .8, 1.2]]) {
      if (!Number.isFinite(values[key]) || values[key] < min || values[key] > max) throw new Error(`${key} is outside the color range`);
    }
  }
}
export function recoveryColorFilter(values) {
  if (!values || (values.warmth === 0 && values.tint === 0 && values.saturation === 1)) return '';
  const shift = n => (n * .002).toFixed(4);
  return `,colorbalance=rm=${shift(values.warmth)}:bm=${shift(-values.warmth)}:gm=${shift(-values.tint)}:pl=0,eq=saturation=${values.saturation}`;
}
