// tile_template.mjs: the one locked layout for episode tiles. Edit here, nowhere else.
//
// The palette below is the default. Change the colours here for your own show;
// the "presented by" line comes from tiles.presented_by in show.config.json.

import { loadShowConfig } from './studio/show_config.mjs';

export const BRAND = {
  slate: '#2c353c',
  teal: '#8abfc5',
  gold: '#f3e2ae',
  white: '#ffffff',
  presentedBy: loadShowConfig().tiles.presented_by,
};

export const SIZES = {
  yt: { width: 1280, height: 720 },      // YouTube episode tile
  short: { width: 1080, height: 1920 },  // Shorts / Reels cover
};

// Titles longer than this cannot fit the locked type size without shrinking,
// and shrinking per-episode is exactly the drift the lock exists to prevent.
export const MAX_TITLE_CHARS = 60;

const box = (style, children) => ({ type: 'div', props: { style, children } });
const text = (style, s) => ({ type: 'div', props: { style, children: s } });
const img = (src, width, height, style) => ({ type: 'img', props: { src, width, height, style } });

// ---- 1280x720 YouTube tile -------------------------------------------------
// v0: title block left, full-bleed photo right, gold episode eyebrow.
export function ytTile({ title, epLabel, photoDataUri }) {
  return box({
    width: SIZES.yt.width, height: SIZES.yt.height,
    display: 'flex', flexDirection: 'row', backgroundColor: BRAND.slate,
    fontFamily: 'Inter',
  }, [
    box({
      flex: 1, display: 'flex', flexDirection: 'column',
      justifyContent: 'space-between', padding: '56px 48px 40px 64px',
    }, [
      box({ display: 'flex', flexDirection: 'column' }, [
        text({ color: BRAND.gold, fontSize: 34, fontWeight: 700, letterSpacing: 6, marginBottom: 24 }, epLabel),
        text({ color: BRAND.white, fontSize: 76, fontWeight: 900, lineHeight: 1.05, letterSpacing: -1 }, title),
        box({ width: 140, height: 8, backgroundColor: BRAND.teal, marginTop: 32, display: 'flex' }, []),
      ]),
      text({ color: BRAND.teal, fontSize: 22, fontWeight: 400 }, BRAND.presentedBy),
    ]),
    img(photoDataUri, 470, SIZES.yt.height, { objectFit: 'cover', borderLeft: `10px solid ${BRAND.teal}` }),
  ]);
}

// ---- YT tile variant B: "type" — type-dominant, photo as a badge -------------
// For Test & Compare: same inputs, different bet. B bets the words are the hook.
export function ytTileB({ title, epLabel, photoDataUri }) {
  return box({
    width: SIZES.yt.width, height: SIZES.yt.height,
    display: 'flex', flexDirection: 'column', backgroundColor: BRAND.slate,
    fontFamily: 'Inter', padding: '56px 64px 40px 64px', position: 'relative',
  }, [
    text({ color: BRAND.gold, fontSize: 36, fontWeight: 700, letterSpacing: 6, marginBottom: 28 }, epLabel),
    text({ color: BRAND.white, fontSize: 92, fontWeight: 900, lineHeight: 1.04, letterSpacing: -1, maxWidth: 980 }, title),
    img(photoDataUri, 200, 200, {
      objectFit: 'cover', borderRadius: 100, border: `8px solid ${BRAND.teal}`,
      position: 'absolute', right: 56, bottom: 44,
    }),
    text({ color: BRAND.teal, fontSize: 22, fontWeight: 400, position: 'absolute', left: 64, bottom: 44 }, BRAND.presentedBy),
  ]);
}

// ---- YT tile variant C: "face" — full-bleed photo, title on a scrim -----------
// C bets the face is the hook. Full-bleed photo, slate gradient band at the
// bottom carrying the episode label and title.
export function ytTileC({ title, epLabel, photoDataUri }) {
  return box({
    width: SIZES.yt.width, height: SIZES.yt.height,
    display: 'flex', fontFamily: 'Inter', position: 'relative',
    backgroundColor: BRAND.slate,
  }, [
    img(photoDataUri, SIZES.yt.width, SIZES.yt.height, {
      objectFit: 'cover', position: 'absolute', top: 0, left: 0,
    }),
    box({
      position: 'absolute', left: 0, right: 0, bottom: 0,
      display: 'flex', flexDirection: 'column',
      padding: '120px 64px 36px 64px',
      backgroundImage: 'linear-gradient(to top, rgba(29,36,41,0.96) 55%, rgba(29,36,41,0))',
    }, [
      text({ color: BRAND.gold, fontSize: 30, fontWeight: 700, letterSpacing: 6, marginBottom: 14 }, epLabel),
      text({ color: BRAND.white, fontSize: 60, fontWeight: 900, lineHeight: 1.05, letterSpacing: -1 }, title),
    ]),
  ]);
}

// Test & Compare variant set. 'a' is the default single-tile render; --variants
// emits all three. Losers get retired from this map with receipts, not deleted
// from git history.
export const YT_VARIANTS = { a: ytTile, b: ytTileB, c: ytTileC };

// ---- 1080x1920 Shorts/Reels cover -------------------------------------------
// v0: photo up top, type centered. HARD CONSTRAINT: Instagram grid center-crops
// to 3:4, i.e. only the middle 1080x1440 (y 240–1680) survives — all text and
// the face stay inside that band. The bottom 240px carries nothing (which also
// clears the Reels UI margin render.mjs already respects at 225px).
export function shortCover({ title, epLabel, photoDataUri }) {
  return box({
    width: SIZES.short.width, height: SIZES.short.height,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    backgroundColor: BRAND.slate, fontFamily: 'Inter', paddingTop: 300,
  }, [
    img(photoDataUri, 560, 560, { objectFit: 'cover', borderRadius: 280, border: `12px solid ${BRAND.teal}` }),
    text({ color: BRAND.gold, fontSize: 40, fontWeight: 700, letterSpacing: 8, marginTop: 56 }, epLabel),
    text({
      color: BRAND.white, fontSize: 84, fontWeight: 900, lineHeight: 1.08,
      textAlign: 'center', marginTop: 24, paddingLeft: 72, paddingRight: 72,
    }, title),
    box({ width: 160, height: 8, backgroundColor: BRAND.gold, marginTop: 40, display: 'flex' }, []),
  ]);
}
